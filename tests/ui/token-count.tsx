import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CharacterCard, IpcInvokeMap, Scene } from '../../src/shared/types'
import { PromptEditor } from '../../src/renderer/src/components/prompt-editor'
import { PromptPanel } from '../../src/renderer/src/components/prompt-panel'
import { SceneDetail } from '../../src/renderer/src/components/scene-detail'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { DEFAULT_REQUEST, useGenerationStore } from '../../src/renderer/src/stores/generation-store'
import { useCharactersStore } from '../../src/renderer/src/stores/characters-store'
import { useFragmentsStore } from '../../src/renderer/src/stores/fragments-store'
import { useScenesStore } from '../../src/renderer/src/stores/scenes-store'
import { useSceneExtrasStore } from '../../src/renderer/src/stores/scene-extras-store'
import { usePromptPresetsStore } from '../../src/renderer/src/stores/prompt-presets-store'
import { useCharRefsStore, useVibesStore } from '../../src/renderer/src/stores/refs-store'
import { tokenFixtureInvoke } from './token-fixture'
import './placement.css'

type Pending = { resolve: (result: unknown) => void; reject: (error: Error) => void }
const pending = new Map<number, Pending>()
const state = {
  mode: 'auto' as 'auto' | 'manual' | 'error',
  delay: 0,
  calls: [] as { id: number; channel: string; request: unknown }[]
}
let nextId = 0
window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    request: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    if (channel === 'tokens:count' || channel === 'tokens:preview') {
      const id = ++nextId
      state.calls.push({ id, channel, request: structuredClone(request) })
      if (state.mode === 'manual') {
        return (await new Promise<unknown>((resolve, reject) =>
          pending.set(id, { resolve, reject })
        )) as IpcInvokeMap[C]['res']
      }
      await new Promise((resolve) => setTimeout(resolve, state.delay))
      if (state.mode === 'error') throw new Error('Token UI fixture error')
      return tokenFixtureInvoke(
        channel,
        request as IpcInvokeMap['tokens:count']['req'] | IpcInvokeMap['tokens:preview']['req']
      ) as IpcInvokeMap[C]['res']
    }
    if (channel === 'tags:search') return { items: [] } as IpcInvokeMap[C]['res']
    if (channel === 'settings:get') return { value: null } as IpcInvokeMap[C]['res']
    if (channel === 'promptPresets:list') return { items: [] } as IpcInvokeMap[C]['res']
    if (channel === 'scenes:images' || channel === 'images:list')
      return { items: [], total: 0 } as IpcInvokeMap[C]['res']
    if (channel === 'settings:set' || channel === 'scenes:update' || channel === 'chars:update')
      return undefined as IpcInvokeMap[C]['res']
    throw new Error(`Token UI fixture blocked IPC: ${channel}`)
  },
  on: () => () => {},
  pathForFile: () => ''
}

const character: CharacterCard = {
  id: 1,
  name: '검증 캐릭터',
  prompt: 'character',
  negativePrompt: 'character negative',
  thumbnail: '',
  enabled: true,
  center: { x: 0.5, y: 0.5 },
  slotNo: null,
  folderId: null,
  charRefId: null,
  role: null
}
const scene = {
  id: 1,
  presetId: 1,
  name: '토큰 검증 씬',
  prompt: 'scene',
  negativePrompt: 'scene negative',
  width: 832,
  height: 1216,
  reserveCount: 0,
  sourceTags: '',
  targetTags: '',
  censorKinds: [],
  thumbnail: '',
  imageCount: 0
} as unknown as Scene
useGenerationStore.setState({
  request: {
    ...DEFAULT_REQUEST,
    model: 'nai-diffusion-5-full',
    prompt: 'base',
    negativePrompt: 'negative',
    qualityToggle: false
  },
  promptSplitEnabled: false
})
useCharactersStore.setState({ items: [character], folders: [], loaded: true })
useFragmentsStore.setState({ items: [], folders: [], loaded: true })
useScenesStore.setState({ scenes: [scene], activePresetId: 1, images: [], imagesTotal: 0 })
useSceneExtrasStore.setState({
  loaded: true,
  additionsEnabled: false,
  sequenceEnabled: false,
  additions: {},
  entries: []
})
usePromptPresetsStore.setState({ loaded: true, presets: [] })
useCharRefsStore.setState({ loaded: true, items: [] })
useVibesStore.setState({ loaded: true, items: [] })
Object.assign(window, {
  tokenFixture: {
    state,
    reply: (id: number, result?: unknown) => {
      const call = state.calls.find((entry) => entry.id === id)!
      pending
        .get(id)
        ?.resolve(
          result ??
            tokenFixtureInvoke(
              call.channel as 'tokens:count' | 'tokens:preview',
              call.request as
                IpcInvokeMap['tokens:count']['req'] | IpcInvokeMap['tokens:preview']['req']
            )
        )
      pending.delete(id)
    },
    reject: (id: number) => {
      pending.get(id)?.reject(new Error('Token UI fixture rejected request'))
      pending.delete(id)
    },
    patch: useGenerationStore.getState().patchRequest,
    generation: () => useGenerationStore.getState(),
    characters: (patch: Partial<CharacterCard>) =>
      useCharactersStore.setState({
        items: [{ ...useCharactersStore.getState().items[0], ...patch }]
      }),
    overlay: (open: boolean) => useCharactersStore.setState({ overlayOpen: open }),
    scene: (patch: Partial<Scene>) =>
      useScenesStore.setState({ scenes: [{ ...useScenesStore.getState().scenes[0], ...patch }] }),
    extras: (patch: Parameters<typeof useSceneExtrasStore.setState>[0]) =>
      useSceneExtrasStore.setState(patch),
    fragment: (content: string) =>
      useFragmentsStore.setState({
        items: [{ id: 1, name: 'sample', content, folderId: null }]
      })
  }
})

function Harness(): React.JSX.Element {
  const mode = new URLSearchParams(location.search).get('mode') ?? 'editor'
  const [text, setText] = useState('')
  const selectedScene = useScenesStore((s) => s.scenes[0])
  return (
    <TooltipProvider>
      <main className="h-full p-4 text-ink">
        {mode === 'panel' ? (
          <div className="h-full max-w-[760px]" data-testid="panel">
            <PromptPanel />
          </div>
        ) : mode === 'scene' ? (
          <div className="h-full" data-testid="scene">
            <SceneDetail scene={selectedScene} />
          </div>
        ) : (
          <div className="max-w-[700px] space-y-4">
            <div data-testid="editor-a">
              <PromptEditor
                value={text}
                onValueChange={setText}
                placeholder="토큰 입력"
                className="h-40"
              />
            </div>
            {mode === 'duplicate' && (
              <div data-testid="editor-b">
                <PromptEditor
                  value={text}
                  onValueChange={setText}
                  placeholder="같은 입력 미러"
                  className="h-40"
                />
              </div>
            )}
            {mode === 'override' && (
              <div data-testid="editor-b">
                <PromptEditor
                  model="nai-diffusion-4-5-full"
                  value={text}
                  onValueChange={setText}
                  placeholder="V4.5 고정 입력"
                  className="h-40"
                />
              </div>
            )}
          </div>
        )}
      </main>
    </TooltipProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
