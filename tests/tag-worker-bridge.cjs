// Isolated UI QA bridge. Uses the production worker and shipped DB; settings are
// ephemeral and no user app database, token, image or network API is accessed.
const { Worker } = require('node:worker_threads')
const { resolve } = require('node:path')
const readline = require('node:readline')
const worker = new Worker(resolve('out/main/tag-search-worker.js'), {
  workerData: { path: resolve('resources/tag-search.sqlite') }
})
const personal = { ko: {}, usage: {} }
const queue = new Map()
let id = 0
worker.on('message', (m) => {
  const job = queue.get(m.id)
  if (!job) return
  queue.delete(m.id)
  if (m.error) job.reject(new Error(m.error))
  else job.resolve(m.result)
})
const ask = (method, args) =>
  new Promise((resolve, reject) => {
    const key = ++id
    queue.set(key, { resolve, reject })
    worker.postMessage({ id: key, method, args, personal })
  })
readline
  .createInterface({ input: process.stdin })
  .on('line', async (line) => {
    const m = JSON.parse(line),
      a = m.req || {}
    try {
      let result
      switch (m.channel) {
        case 'tags:search':
          result = { items: await ask('recommend', [a.query, a.limit]) }
          break
        case 'tags:recordUse':
          personal.usage[a.tag] = {
            count: (personal.usage[a.tag]?.count || 0) + 1,
            lastUsed: Date.now()
          }
          break
        case 'tags:setKo':
          personal.ko[a.tag] = a.ko
          break
        case 'tags:lookup':
          result = { items: await ask('lookup', [a.tags]) }
          break
        case 'tags:history':
          result = { items: await ask('history', [a.mode, a.limit]) }
          break
        case 'tags:clearHistory':
          personal.usage = {}
          break
        default:
          throw new Error('Unexpected tag channel')
      }
      process.stdout.write(JSON.stringify({ id: m.id, result }) + '\n')
    } catch (e) {
      process.stdout.write(JSON.stringify({ id: m.id, error: String(e) }) + '\n')
    }
  })
  .on('close', () => worker.terminate())
