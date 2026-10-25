import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterCard, GenerationRequest } from '../src/shared/types'

vi.hoisted(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', {
    nais: {
      invoke: vi.fn(() => {
        throw new Error('요청을 만들 때는 IPC 를 부르지 않는다')
      })
    }
  })
})

import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useOutfitsStore } from '../src/renderer/src/stores/outfits-store'
import { DEFAULT_EXPOSE_ACTS } from '../src/shared/auto-expose'

/** 메인 탭 생성도 씬과 같은 규칙으로 입은 옷 자동 젖힘을 적용한다 */
const card = (id: number, prompt: string, role: CharacterCard['role'] = null): CharacterCard =>
  ({
    id,
    name: `카드 ${id}`,
    prompt,
    negativePrompt: '',
    enabled: true,
    center: { x: 0.5, y: 0.5 },
    role,
    slotNo: null,
    charRefId: null
  }) as CharacterCard

async function build(prompt: string): Promise<GenerationRequest> {
  useGenerationStore.setState({
    request: { ...DEFAULT_REQUEST, prompt },
    promptSplitEnabled: false,
    source: null
  })
  return useGenerationStore.getState().buildMainRequest()
}

beforeEach(() => {
  useOutfitsStore.setState({
    items: [],
    acts: DEFAULT_EXPOSE_ACTS,
    stripOnNude: false,
    exposeWorn: true,
    kinds: {}
  })
  useCharactersStore.setState({
    items: [
      card(1, 'blue eyes, pleated skirt, white shirt', 'target'),
      card(2, '1boy, black pants', 'source')
    ]
  })
})

describe('메인 탭 — 입은 옷 자동 젖힘', () => {
  it('메인 프롬프트의 행위를 보고 카드 옷에 맞는 젖힘 태그를 붙이고 메모를 싣는다', async () => {
    const r = await build('bed, vaginal')
    const [girl, boy] = r.characterPrompts
    expect(girl.prompt).toBe('blue eyes, pleated skirt, white shirt, skirt lift')
    expect(boy.prompt).toBe('1boy, black pants, pants pull, open fly')
    expect(
      r.exposeNotes?.filter((n) => n.status === 'added').map((n) => [n.charIndex, n.tags])
    ).toEqual([
      [0, ['skirt lift']],
      [1, ['pants pull', 'open fly']]
    ])
    // 화면 상태·저장에 쓰는 기본 요청에는 메모가 없다
    expect(useGenerationStore.getState().request.exposeNotes).toBeUndefined()
  })

  it('가슴 행위는 가슴 옷만, 여 아래 행위는 남캐를 열지 않는다', async () => {
    const r = await build('paizuri')
    expect(r.characterPrompts[0].prompt).toBe('blue eyes, pleated skirt, white shirt, shirt lift')
    expect(r.characterPrompts[1].prompt).toBe('1boy, black pants, pants pull, open fly')
    const c = await build('cunnilingus')
    expect(c.characterPrompts[0].prompt).toBe('blue eyes, pleated skirt, white shirt, skirt lift')
    expect(c.characterPrompts[1].prompt).toBe('1boy, black pants')
  })

  it('설정을 끄면 예전과 똑같이 나가고 메모도 없다', async () => {
    useOutfitsStore.setState({ exposeWorn: false })
    const r = await build('bed, vaginal')
    expect(r.characterPrompts[0].prompt).toBe('blue eyes, pleated skirt, white shirt')
    expect(r.characterPrompts[1].prompt).toBe('1boy, black pants')
    expect('exposeNotes' in r).toBe(false)
  })

  it('요리·사후 어구 같은 오탐은 메인 탭에서도 막힌다', async () => {
    expect((await build('cooking, presenting food')).characterPrompts[0].prompt).toBe(
      'blue eyes, pleated skirt, white shirt'
    )
    expect((await build('after sex, nipples')).characterPrompts[0].prompt).toBe(
      'blue eyes, pleated skirt, white shirt'
    )
  })

  it('역할 없는 여캐도 메인 프롬프트의 행위를 받는다', async () => {
    useCharactersStore.setState({
      items: [card(1, 'blue eyes, skirt'), card(2, '1boy, black pants', 'source')]
    })
    const r = await build('vaginal')
    expect(r.characterPrompts[0].prompt).toBe('blue eyes, skirt, skirt lift')
  })
})
