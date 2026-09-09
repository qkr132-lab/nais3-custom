import { createRoot } from 'react-dom/client'
import { SplitPromptFields } from '../../src/renderer/src/components/prompt-panel'
import { PromptEditor } from '../../src/renderer/src/components/prompt-editor'
import { PromptPresetBar } from '../../src/renderer/src/components/prompt-preset-bar'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { Toaster } from '../../src/renderer/src/components/toaster'
import { DEFAULT_REQUEST, useGenerationStore } from '../../src/renderer/src/stores/generation-store'
import {
  usePromptPresetsStore,
  pickPresetParams
} from '../../src/renderer/src/stores/prompt-presets-store'
import { useScenesStore } from '../../src/renderer/src/stores/scenes-store'
import { useCharactersStore } from '../../src/renderer/src/stores/characters-store'
import { useSceneExtrasStore } from '../../src/renderer/src/stores/scene-extras-store'
import { useCharRefsStore, useVibesStore } from '../../src/renderer/src/stores/refs-store'
import { initLiveResync } from '../../src/renderer/src/lib/live-resync'
import { mergePromptParts } from '../../src/shared/scene-request'
import type { GenerationRequest, IpcInvokeMap, PromptPreset, Scene } from '../../src/shared/types'
import './placement.css'

const parts = { base: 'base A', additional: 'middle A', detail: 'detail A' }
const initial = { ...DEFAULT_REQUEST, promptParts: parts, prompt: mergePromptParts(parts) }
let presets: PromptPreset[] = [
  {
    id: 1,
    name: '프리셋 A',
    prompt: initial.prompt,
    negativePrompt: '',
    params: pickPresetParams(initial)
  },
  {
    id: 2,
    name: '프리셋 B',
    prompt: 'base B, middle B, detail B',
    negativePrompt: '',
    params: { promptParts: { base: 'base B', additional: 'middle B', detail: 'detail B' } }
  }
]
const settings = new Map<string, string>([
  ['prompt_split_enabled', '1'],
  ['main_params', JSON.stringify(initial)]
])
let queued: { id: string; request: GenerationRequest }[] = []
const publishQueue = (): void =>
  useGenerationStore.setState({
    queue: {
      items: queued.map((i) => ({ id: i.id, state: 'pending', sceneId: i.request.sceneId })),
      running: false,
      delayMs: 0
    }
  })
const enqueue = (requests: GenerationRequest[]): void => {
  queued.push(
    ...requests.map((request) => ({
      id: String(queued.length + Math.random()),
      request: structuredClone(request)
    }))
  )
  publishQueue()
}
window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    req: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    let result: unknown
    switch (channel) {
      case 'settings:get':
        result = { value: settings.get((req as { key: string }).key) ?? null }
        break
      case 'settings:set': {
        const { key, value } = req as { key: string; value: string }
        settings.set(key, value)
        break
      }
      case 'promptPresets:list':
        result = { items: structuredClone(presets) }
        break
      case 'promptPresets:update': {
        const { id, patch } = req as IpcInvokeMap['promptPresets:update']['req']
        presets = presets.map((p) => (p.id === id ? { ...p, ...patch } : p))
        break
      }
      case 'queue:enqueue':
        enqueue([(req as { request: GenerationRequest }).request])
        break
      case 'queue:enqueueNext':
      case 'queue:enqueueMany':
        enqueue((req as { requests: GenerationRequest[] }).requests)
        break
      case 'queue:pending':
        result = { items: structuredClone(queued) }
        break
      case 'queue:updatePending': {
        const { updates } = req as IpcInvokeMap['queue:updatePending']['req']
        queued = queued.map((i) => updates.find((u) => u.id === i.id) ?? i)
        break
      }
      case 'queue:status':
        result = { items: [], running: false, delayMs: 0 }
        break
      case 'images:list':
        result = { items: [], total: 0 }
        break
      case 'nai:balance':
        result = { anlas: null, tier: null, opusUsage: null }
        break
      case 'scenes:setReserveAll':
      case 'scenes:update':
        break
      case 'tokens:count':
        result = { counts: [0] }
        break
      case 'tags:search':
        result = { items: [] }
        break
      default:
        throw new Error(`Blocked fixture IPC ${channel}`)
    }
    return result as IpcInvokeMap[C]['res']
  },
  on: () => () => {},
  pathForFile: () => ''
}
useGenerationStore.setState({
  request: initial,
  promptSplitEnabled: true,
  seedLocked: true,
  batchCount: 1
})
usePromptPresetsStore.setState({ presets: structuredClone(presets), loaded: true, activeId: 1 })
useCharactersStore.setState({ items: [], loaded: true })
useSceneExtrasStore.setState({
  loaded: true,
  additionsEnabled: false,
  sequenceEnabled: false,
  entries: []
})
useCharRefsStore.setState({ items: [], loaded: true })
useVibesStore.setState({ items: [], loaded: true })
useScenesStore.setState({
  activePresetId: 1,
  scenes: [
    {
      id: 1,
      presetId: 1,
      name: '검증 씬',
      prompt: 'scene tags',
      negativePrompt: '',
      width: 832,
      height: 1216,
      reserveCount: 1,
      sourceTags: '',
      targetTags: ''
    } as Scene
  ]
})
initLiveResync()
Object.assign(window, {
  promptFixture: {
    queued: () => queued,
    presets: () => presets,
    settings: () => Object.fromEntries(settings),
    gen: () => useGenerationStore.getState(),
    scenes: () => useScenesStore.getState(),
    clearQueue: () => {
      queued = []
      publishQueue()
    }
  }
})

function Harness(): React.JSX.Element {
  const gen = useGenerationStore()
  return (
    <TooltipProvider>
      <main className="flex h-full flex-col gap-3 p-4 text-ink">
        <h1 className="text-[15px] font-semibold">프롬프트 입력·저장·대기 요청 검증</h1>
        <div className="flex flex-wrap gap-3 text-[12px]">
          <button onClick={() => gen.setPromptSplitEnabled(!gen.promptSplitEnabled)}>
            분할 {gen.promptSplitEnabled ? '끄기' : '켜기'}
          </button>
          <button onClick={() => void gen.generate()}>메인 요청 만들기</button>
          <button onClick={() => void useScenesStore.getState().reserveAndGenerateScene(1)}>
            씬 요청 만들기
          </button>
          <button onClick={() => void gen.hydrate()}>저장값 다시 읽기</button>
        </div>
        <div className="flex min-h-0 w-full max-w-[700px] flex-1 flex-col gap-3">
          <PromptPresetBar />
          {gen.promptSplitEnabled ? (
            <SplitPromptFields parts={gen.request.promptParts!} onChange={gen.patchPromptParts} />
          ) : (
            <PromptEditor
              value={gen.request.prompt}
              onValueChange={(v) => gen.patchRequest({ prompt: v })}
              tokensOverride={null}
              placeholder="통합 입력"
              className="h-60"
            />
          )}
          <pre
            data-testid="request"
            className="max-h-24 overflow-auto whitespace-pre-wrap break-words text-[11px]"
          >
            {JSON.stringify(gen.request)}
          </pre>
        </div>
        <Toaster />
      </main>
    </TooltipProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
