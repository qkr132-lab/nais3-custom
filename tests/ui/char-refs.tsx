import { createRoot } from 'react-dom/client'
import type { CharacterCard, CharRefItem, IpcInvokeMap } from '../../src/shared/types'
import { CharacterOverlay } from '../../src/renderer/src/components/character-overlay'
import { RefOverlay } from '../../src/renderer/src/components/ref-overlay'
import { TextPromptHost } from '../../src/renderer/src/components/text-prompt-host'
import { Toaster } from '../../src/renderer/src/components/toaster'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { useCharactersStore } from '../../src/renderer/src/stores/characters-store'
import { useFragmentsStore } from '../../src/renderer/src/stores/fragments-store'
import { useGenerationStore } from '../../src/renderer/src/stores/generation-store'
import { useCharRefsStore } from '../../src/renderer/src/stores/refs-store'
import { tokenFixtureInvoke } from './token-fixture'
import './placement.css'

/**
 * 캐릭터 레퍼런스 설정 화면 검증 — `?model=` 로 모델을 바꿔 본다 (기본 V5 Full).
 * `?view=link` 면 캐릭터 창을 띄운다 (카드를 펼쳐 「레퍼런스 연결」 창을 연다).
 * V5: 강도 5까지·충실도 없음·「같은 옷 선호」 / V4.5: 강도 1까지·충실도 있음·의상 안내.
 * IPC 는 전부 여기서 받아 기록만 하고 밖으로 나가지 않는다.
 */
const state = { calls: [] as { channel: string; request: unknown }[] }
window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    request: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    state.calls.push({ channel, request: structuredClone(request) })
    if (channel === 'settings:get') return { value: null } as IpcInvokeMap[C]['res']
    if (channel === 'crefs:update' || channel === 'settings:set' || channel === 'chars:update')
      return undefined as IpcInvokeMap[C]['res']
    if (channel === 'tokens:count' || channel === 'tokens:preview')
      return tokenFixtureInvoke(
        channel,
        request as IpcInvokeMap['tokens:count']['req'] | IpcInvokeMap['tokens:preview']['req']
      ) as IpcInvokeMap[C]['res']
    throw new Error(`Reference fixture blocked IPC: ${channel}`)
  },
  on: () => () => {},
  pathForFile: () => ''
}

const ref = (id: number, name: string, refType: CharRefItem['refType']): CharRefItem => ({
  id,
  name,
  thumbnail: '',
  enabled: true,
  refType,
  strength: 1,
  fidelity: 0.8,
  folderId: null
})
const query = new URLSearchParams(location.search)
const model = query.get('model') ?? 'nai-diffusion-5-full'
const linkView = query.get('view') === 'link'
const linkedChar: CharacterCard = {
  id: 1,
  name: '연결 캐릭터',
  prompt: 'girl',
  negativePrompt: '',
  thumbnail: '',
  enabled: true,
  center: { x: 0.5, y: 0.5 },
  slotNo: null,
  folderId: null,
  charRefId: 2,
  role: null,
  partnerTags: '',
  outfitId: null
}
useCharactersStore.setState({ loaded: true, folders: [], items: [linkedChar] })
useFragmentsStore.setState({ loaded: true, folders: [], items: [] })
useGenerationStore.getState().patchRequest({ model })
useCharRefsStore.setState({
  loaded: true,
  folders: [],
  items: [
    ref(1, '캐릭터', 'character'),
    ref(2, '캐릭터+스타일', 'character&style'),
    ref(3, '의상', 'costume'),
    ref(4, '스타일', 'style')
  ]
})
Object.assign(window, { refFixture: { state, items: () => useCharRefsStore.getState().items } })
createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <main className="h-dvh w-[420px] p-4">
      {linkView ? <CharacterOverlay /> : <RefOverlay kind="charref" />}
    </main>
    <TextPromptHost />
    <Toaster />
  </TooltipProvider>
)
