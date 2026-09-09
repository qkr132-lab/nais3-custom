import { parentPort, workerData } from 'node:worker_threads'
import { TagSearchEngine } from './tag-search-engine'
import type { TagUsage } from '../shared/tag-search'

const engine = new TagSearchEngine(workerData.path)
parentPort!.on(
  'message',
  (message: {
    id: number
    method: 'search' | 'recommend' | 'lookup' | 'history'
    args: [string, number] | [string[]]
    personal?: { ko: Record<string, string>; usage: TagUsage }
  }) => {
    try {
      if (message.personal) engine.setPersonal(message.personal)
      let result
      switch (message.method) {
        case 'search':
          result = engine.search(...(message.args as [string, number]))
          break
        case 'recommend':
          result = engine.recommend(...(message.args as [string, number]))
          break
        case 'history':
          result = engine.history(...(message.args as ['recent' | 'frequent', number]))
          break
        case 'lookup':
          result = engine.lookup(...(message.args as [string[]]))
          break
      }
      parentPort!.postMessage({ id: message.id, result })
    } catch (error) {
      parentPort!.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
)
