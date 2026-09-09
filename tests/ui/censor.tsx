import { createRoot } from 'react-dom/client'
import type { IpcInvokeMap, Scene } from '../../src/shared/types'
import {
  changeCensors,
  changeCensorWeights,
  changeAnalSuppression
} from '../../src/shared/censor-tags'
import { SceneMode } from '../../src/renderer/src/components/scene-mode'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { useScenesStore } from '../../src/renderer/src/stores/scenes-store'
import { useGenerationStore } from '../../src/renderer/src/stores/generation-store'
import './placement.css'
import { tokenFixtureInvoke } from './token-fixture'

const initial: Scene[] = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1,
  presetId: 1,
  name: `씬 ${String(i + 1).padStart(2, '0')}`,
  prompt: 'landscape, blue sky',
  negativePrompt: '',
  width: 832,
  height: 1216,
  reserveCount: 0,
  varietyPlus: false,
  sourceTags: '',
  targetTags: '',
  sourcePos: null,
  targetPos: null,
  exportNo: null,
  thumbnail: '',
  thumbnailPath: '',
  imageCount: 0,
  censorKinds: []
}))
let records: Scene[] = JSON.parse(localStorage.getItem('censor-ui-fixture') ?? 'null') ?? initial
const persist = (): void => localStorage.setItem('censor-ui-fixture', JSON.stringify(records))
let failNext = false
window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    req: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    let result: unknown
    switch (channel) {
      case 'scenePresets:list':
        result = {
          items: [1, 2].map((id) => ({
            id,
            name: `프리셋 ${id}`,
            defaultWidth: 832,
            defaultHeight: 1216,
            sceneCount: records.filter((s) => s.presetId === id).length
          }))
        }
        break
      case 'scenes:list':
        result = {
          items: structuredClone(
            records.filter((s) => s.presetId === (req as { presetId: number }).presetId)
          )
        }
        break
      case 'settings:get':
        result = { value: null }
        break
      case 'r2sync:getConfig':
        result = null
        break
      case 'settings:set':
        break
      case 'scenes:images':
        result = { items: [], total: 0 }
        break
      case 'tokens:count':
      case 'tokens:preview':
        result = tokenFixtureInvoke(
          channel,
          req as IpcInvokeMap['tokens:count']['req'] | IpcInvokeMap['tokens:preview']['req']
        )
        break
      case 'tags:search':
        result = { items: [] }
        break
      case 'scenes:update': {
        const { id, patch } = req as IpcInvokeMap['scenes:update']['req']
        records = records.map((s) =>
          s.id === id
            ? {
                ...s,
                ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
              }
            : s
        )
        persist()
        break
      }
      case 'scenes:setCensors': {
        if (failNext) {
          failNext = false
          throw new Error('테스트 저장 실패. 다시 시도해 주세요.')
        }
        const { ids, changes } = req as IpcInvokeMap['scenes:setCensors']['req']
        records = records.map((s) =>
          ids.includes(s.id)
            ? {
                ...s,
                censorKinds: changeCensors(s.censorKinds, changes),
                censorWeights: changeCensorWeights(s.censorWeights, changes),
                suppressAnal: changeAnalSuppression(s.suppressAnal, changes)
              }
            : s
        )
        persist()
        result = {
          items: records
            .filter((s) => ids.includes(s.id))
            .map(({ id, censorKinds, censorWeights, suppressAnal }) => ({
              id,
              censorKinds,
              censorWeights,
              suppressAnal
            }))
        }
        break
      }
      default:
        throw new Error(`UI fixture blocked IPC: ${channel}`)
    }
    return result as IpcInvokeMap[C]['res']
  },
  on: () => () => undefined,
  pathForFile: () => {
    throw new Error('No filesystem in fixture')
  }
}
Object.assign(window, {
  censorFixture: {
    reset: () => {
      localStorage.removeItem('censor-ui-fixture')
      location.reload()
    },
    state: () => useScenesStore.getState(),
    records: () => records,
    failNext: () => {
      failNext = true
    },
    preset: (id: number) => useScenesStore.getState().setActivePreset(id),
    request: () => useGenerationStore.getState().request
  }
})
createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <main className="h-full">
      <SceneMode />
    </main>
  </TooltipProvider>
)
