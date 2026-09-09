import { parentPort, workerData } from 'node:worker_threads'
import { NaiTokenizer } from './nai/tokenizer'

const tokenizer = new NaiTokenizer(workerData.resourcesDir)
parentPort!.on(
  'message',
  ({ id, model, texts }: { id: number; model: string; texts: string[] }) => {
    try {
      parentPort!.postMessage({
        id,
        counts: texts.map((text) => tokenizer.countPrompt(text, model))
      })
    } catch (error) {
      parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
)
