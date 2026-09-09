const { Worker } = require('node:worker_threads')
const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const { resolve } = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const root = resolve(__dirname, '..')
const appRoot = process.env.NAIS_TAG_TEST_APP || root
const output = resolve(root, '.superloopy/evidence/frontend/korean-search')
fs.mkdirSync(output, { recursive: true })
const worker = new Worker(resolve(appRoot, 'out/main/tag-search-worker.js'), {
  workerData: { path: resolve(appRoot.replace(/app\.asar$/, 'app.asar.unpacked'), 'resources/tag-search.sqlite') }
})
const jobs = new Map()
let sequence = 0
worker.on('message', (m) => {
  const job = jobs.get(m.id)
  if (!job) return
  jobs.delete(m.id)
  if (m.error) job.reject(new Error(m.error))
  else job.resolve(m.result)
})
worker.on('error', (e) => {
  for (const job of jobs.values()) job.reject(e)
  jobs.clear()
})
function query(q) {
  return new Promise((resolve, reject) => {
    const id = ++sequence
    jobs.set(id, { resolve, reject })
    worker.postMessage({ id, method: 'search', args: [q, 10] })
  })
}
;(async () => {
  const heartbeat = monitorEventLoopDelay({ resolution: 10 })
  heartbeat.enable()
  let ticks = 0
  const timer = setInterval(() => ticks++, 5)
  try {
    const coldStart = performance.now()
    assert.equal((await query('카메하메하'))[0].tag, 'kamehameha (dragon ball)')
    const coldMs = performance.now() - coldStart
    const inputs = [
      'ㅈ',
      'ㅈㅅ',
      '전',
      '전ㅅ',
      '전신',
      '에',
      '에네',
      '에네르기파',
      '에너르기파',
      '카메',
      '카메하메하',
      '파동권',
      '나선환',
      '장풍',
      '기공파',
      '에너지 구체',
      '화가 난',
      '웃는',
      '눈',
      '눈 감은',
      '머리',
      '긴 머리',
      '검은색 재킷',
      '위에서 내려다보는',
      '카메라를 보는',
      '달리고 있는',
      '손오공',
      '하츠네 미쿠',
      '날개',
      '창',
      '검',
      '별',
      '밤',
      '비',
      '숲',
      'ba',
      'bl',
      'blue',
      'blue eyes',
      'hair',
      'body',
      'light',
      'energy',
      'energy beam',
      'gun',
      'sword',
      'sitting',
      'full body',
      'dress',
      'holding sword',
      'long hair',
      'black jacket',
      'abcqzx',
      '없는말카쟈뤼푸뿡'
    ]
    const samples = []
    const results = {}
    for (const input of inputs) {
      const t = performance.now(),
        items = await query(input)
      samples.push({ query: input, ms: performance.now() - t })
      results[input] = items.map((x) => ({
        tag: x.tag,
        ko: x.ko,
        match: x.match,
        alias: x.matchedAlias
      }))
    }
    for (let i = 0; i < 100; i++) {
      const t = performance.now()
      await query(inputs[i % inputs.length])
      samples.push({ query: 'cached', ms: performance.now() - t })
    }
    const sorted = samples
      .filter((x) => x.query !== 'cached')
      .map((x) => x.ms)
      .sort((a, b) => a - b)
    const cached = samples
      .filter((x) => x.query === 'cached')
      .map((x) => x.ms)
      .sort((a, b) => a - b)
    assert(results['ㅈ'].some((x) => x.tag === 'full body'))
    assert.equal(results['에너르기파'][0].tag, 'kamehameha (dragon ball)')
    assert(ticks > 5, 'main event loop must continue while dictionary searches run')
    const report = {
      runtime: process.versions,
      coldMs,
      medianMs: sorted[Math.floor(sorted.length / 2)],
      p95Ms: sorted[Math.floor(sorted.length * 0.95)],
      maxMs: sorted.at(-1),
      cachedP95Ms: cached[94],
      mainLoopMaxMs: heartbeat.max / 1e6,
      heartbeatTicks: ticks,
      memory: process.memoryUsage(),
      samples,
      results
    }
    fs.writeFileSync(resolve(output, process.env.NAIS_TAG_TEST_APP ? 'packaged-worker-performance.json' : 'worker-performance.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ ...report, samples: undefined, results: undefined }, null, 2))
  } finally {
    clearInterval(timer)
    heartbeat.disable()
    await worker.terminate()
  }
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
