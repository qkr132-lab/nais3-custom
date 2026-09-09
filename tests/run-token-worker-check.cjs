const { resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const { Worker } = require('node:worker_threads')
const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const fs = require('node:fs')
const assert = require('node:assert/strict')

if (!process.versions.electron) {
  const result = spawnSync(resolve('node_modules/electron/dist/electron.exe'), [__filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60000
  })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  if (result.error) console.error(result.error)
  process.exit(result.status ?? 1)
}

const appRoot = process.env.NAIS_TOKEN_TEST_APP || resolve(__dirname, '..')
const worker = new Worker(resolve(appRoot, 'out/main/nai-token-worker.js'), {
  workerData: {
    resourcesDir: resolve(appRoot.replace(/app\.asar$/, 'app.asar.unpacked'), 'resources')
  }
})
const jobs = new Map()
let id = 0
worker.on('message', (message) => {
  const job = jobs.get(message.id)
  jobs.delete(message.id)
  if (message.error) job.reject(new Error(message.error))
  else job.resolve(message.counts)
})
worker.on('error', (error) => {
  for (const job of jobs.values()) job.reject(error)
  jobs.clear()
})
const query = (model, texts) =>
  new Promise((resolve, reject) => {
    const next = ++id
    jobs.set(next, { resolve, reject })
    worker.postMessage({ id: next, model, texts })
  })

;(async () => {
  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  let ticks = 0
  const heartbeat = setInterval(() => ticks++, 5)
  try {
    const vectors = require('./fixtures/nai-tokenizer-reference.json').vectors.filter((v) =>
      [
        'empty',
        'ascii',
        'korean',
        'japanese',
        'emoji',
        'numeric-weight',
        'quality-standard'
      ].includes(v.name)
    )
    const cold = performance.now()
    assert.deepEqual(
      await query(
        'nai-diffusion-5-full',
        vectors.map((v) => v.input)
      ),
      vectors.map((v) => v.qwen.count)
    )
    const coldMs = performance.now() - cold
    assert.ok(ticks > 0, 'Main event loop must run while the Qwen vocabulary loads')
    assert.deepEqual(
      await query(
        'nai-diffusion-4-5-full',
        vectors.map((v) => v.input)
      ),
      vectors.map((v) => v.t5.count)
    )
    const samples = []
    for (let i = 0; i < 100; i++) {
      const before = performance.now()
      const counts = await query('nai-diffusion-5-full', [
        `${i}, ` +
          'A silver haired warrior stands beneath the blue sky, full body, detailed background. '.repeat(
            30
          )
      ])
      assert.ok(counts[0] > 300)
      samples.push(performance.now() - before)
    }
    const longStart = performance.now()
    const [longCount] = await query('nai-diffusion-5-full', ['a'.repeat(100000)])
    assert.ok(longCount > 0)
    const longMs = performance.now() - longStart
    samples.sort((a, b) => a - b)
    const report = {
      appRoot,
      vectors: vectors.length * 2,
      coldMs,
      medianMs: samples[50],
      p95Ms: samples[95],
      long100kMs: longMs,
      mainEventLoopMaxMs: delay.max / 1e6,
      heartbeatTicks: ticks
    }
    const directory = resolve('.superloopy/evidence/frontend/token-count')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(
      resolve(directory, process.env.NAIS_TOKEN_TEST_APP ? 'packaged-worker.json' : 'worker.json'),
      JSON.stringify(report, null, 2)
    )
    console.log(JSON.stringify(report))
  } finally {
    clearInterval(heartbeat)
    delay.disable()
    await worker.terminate()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
