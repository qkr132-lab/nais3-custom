import { createRoot } from 'react-dom/client'
import type { GenerationRequest, IpcInvokeMap, Scene, SceneImage } from '../../src/shared/types'
import { PageNav } from '../../src/renderer/src/components/page-nav'
import { useLayoutStore } from '../../src/renderer/src/stores/layout-store'
import { useCharactersStore } from '../../src/renderer/src/stores/characters-store'
import { useVibesStore, useCharRefsStore } from '../../src/renderer/src/stores/refs-store'
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
  kind: 'scene',
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
const queued: GenerationRequest[] = []
const generated: (SceneImage & { sceneId: number })[] = []
useCharactersStore.setState({ loaded: true })
useVibesStore.setState({ loaded: true })
useCharRefsStore.setState({ loaded: true })
useLayoutStore.setState({ centerMode: 'scene' })
window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    req: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    let result: unknown
    switch (channel) {
      case 'scenePresets:list':
        result = {
          items: ((req as { kind?: string } | undefined)?.kind === 'background' ? [3] : [1, 2]).map(
            (id) => ({
              id,
              kind: id === 3 ? 'background' : 'scene',
              name: `프리셋 ${id}`,
              defaultWidth: 832,
              defaultHeight: 1216,
              sceneCount: records.filter((s) => s.presetId === id).length
            })
          )
        }
        break
      case 'scenes:list':
        result = {
          items: structuredClone(
            records.filter((s) => s.presetId === (req as { presetId: number }).presetId)
          )
        }
        break
      case 'scenes:create': {
        const { name, presetId } = req as IpcInvokeMap['scenes:create']['req']
        const id = Math.max(...records.map((s) => s.id)) + 1
        records.push({
          ...initial[0],
          id,
          name,
          presetId,
          kind: presetId === 3 ? 'background' : 'scene',
          prompt: ''
        })
        persist()
        result = { id }
        break
      }
      case 'scenes:delete':
        records = records.filter((s) => s.id !== (req as { id: number }).id)
        persist()
        break
      case 'scenes:setReserveAll': {
        const { presetId, count } = req as IpcInvokeMap['scenes:setReserveAll']['req']
        records = records.map((s) => (s.presetId === presetId ? { ...s, reserveCount: count } : s))
        persist()
        break
      }
      case 'queue:enqueueMany':
        queued.push(...(req as IpcInvokeMap['queue:enqueueMany']['req']).requests)
        break
      case 'images:setFavorite': {
        const { id, favorite } = req as IpcInvokeMap['images:setFavorite']['req']
        const image = generated.find((i) => i.id === id)
        if (image) image.favorite = favorite
        break
      }
      case 'settings:get':
        result = { value: localStorage.getItem(`fixture-setting-${(req as { key: string }).key}`) }
        break
      case 'r2sync:getConfig':
        result = null
        break
      case 'settings:set':
        localStorage.setItem(
          `fixture-setting-${(req as { key: string }).key}`,
          (req as { value: string }).value
        )
        break
      case 'scenes:setBackground': {
        if (failNext) {
          failNext = false
          throw new Error('테스트 저장 실패')
        }
        const { ids, background } = req as IpcInvokeMap['scenes:setBackground']['req']
        records = records.map((s) => (ids.includes(s.id) ? { ...s, background } : s))
        persist()
        break
      }
      case 'scenes:duplicate': {
        const source = records.find((s) => s.id === (req as { id: number }).id)!
        const id = Math.max(...records.map((s) => s.id)) + 1
        records.push({
          ...structuredClone(source),
          id,
          name: `${source.name} 복제`,
          reserveCount: 0
        })
        persist()
        result = { id }
        break
      }
      case 'scenes:images': {
        const { sceneId, favoritesOnly } = req as IpcInvokeMap['scenes:images']['req']
        const items = generated.filter(
          (i) => i.sceneId === sceneId && (!favoritesOnly || i.favorite)
        )
        result = { items, total: items.length }
        break
      }
      case 'queue:pending':
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
    request: () => useGenerationStore.getState().request,
    queued: () => queued,
    complete: async (sceneId: number) => {
      generated.push({
        id: generated.length + 1,
        sceneId,
        filePath: 'fixture-background.png',
        thumbnail: '',
        seed: 123,
        favorite: false
      })
      const scene = records.find((s) => s.id === sceneId)!
      scene.imageCount++
      persist()
      await useScenesStore.getState().load()
      await useScenesStore.getState().loadImages(sceneId, true)
    }
  }
})
function Workspace(): React.JSX.Element {
  const mode = useLayoutStore((s) => s.centerMode)
  const workspace = new URLSearchParams(location.search).has('workspace')
  return (
    <main className="flex h-full flex-col">
      {workspace && (
        <div className="flex justify-center p-2">
          <PageNav />
        </div>
      )}
      <SceneMode key={mode} kind={mode === 'background' ? 'background' : 'scene'} />
    </main>
  )
}
createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <Workspace />
  </TooltipProvider>
)
