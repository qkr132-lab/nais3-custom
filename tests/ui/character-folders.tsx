import { createRoot } from 'react-dom/client'
import type { IpcInvokeMap, ListFolder } from '../../src/shared/types'
import { CharacterOverlay } from '../../src/renderer/src/components/character-overlay'
import { TextPromptHost } from '../../src/renderer/src/components/text-prompt-host'
import { Toaster } from '../../src/renderer/src/components/toaster'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { useCharactersStore } from '../../src/renderer/src/stores/characters-store'
import { useFragmentsStore } from '../../src/renderer/src/stores/fragments-store'
import { useCharRefsStore } from '../../src/renderer/src/stores/refs-store'
import { tokenFixtureInvoke } from './token-fixture'
import './placement.css'

const state = {
  folders: [
    { id: 1, name: '기본 캐릭터', collapsed: true, parentId: null, color: null },
    { id: 2, name: '다른 폴더', collapsed: false, parentId: null, color: null }
  ] as ListFolder[],
  calls: [] as { channel: string; request: unknown }[],
  failNext: false
}
let nextId = 3
window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    request: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    state.calls.push({ channel, request: structuredClone(request) })
    if (channel === 'chars:folderCreate') {
      if (state.failNext) {
        state.failNext = false
        throw new Error('저장 실패 검증')
      }
      const req = request as IpcInvokeMap['chars:folderCreate']['req']
      const id = nextId++
      state.folders.push({
        id,
        name: req.name,
        parentId: req.parentId ?? null,
        collapsed: false,
        color: null
      })
      const parent = state.folders.find((f) => f.id === req.parentId)
      if (parent) parent.collapsed = false
      return { id } as IpcInvokeMap[C]['res']
    }
    if (channel === 'chars:list')
      return { folders: structuredClone(state.folders), items: [] } as IpcInvokeMap[C]['res']
    if (channel === 'chars:folderCollapse') {
      const req = request as IpcInvokeMap['chars:folderCollapse']['req']
      const folder = state.folders.find((f) => f.id === req.id)
      if (folder) folder.collapsed = req.collapsed
      return undefined as IpcInvokeMap[C]['res']
    }
    if (channel === 'tokens:count' || channel === 'tokens:preview')
      return tokenFixtureInvoke(
        channel,
        request as IpcInvokeMap['tokens:count']['req'] | IpcInvokeMap['tokens:preview']['req']
      ) as IpcInvokeMap[C]['res']
    if (channel === 'settings:get') return { value: null } as IpcInvokeMap[C]['res']
    throw new Error(`Folder fixture blocked IPC: ${channel}`)
  },
  on: () => () => {},
  pathForFile: () => ''
}
useCharactersStore.setState({ loaded: true, folders: structuredClone(state.folders), items: [] })
useFragmentsStore.setState({ loaded: true, folders: [], items: [] })
useCharRefsStore.setState({ loaded: true, folders: [], items: [] })
Object.assign(window, {
  folderFixture: { state, reload: () => useCharactersStore.getState().load() }
})
createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <main className="h-dvh p-4">
      <CharacterOverlay />
    </main>
    <TextPromptHost />
    <Toaster />
  </TooltipProvider>
)
