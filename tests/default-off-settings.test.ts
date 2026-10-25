import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterCard, GenerationRequest, Scene } from '../src/shared/types'

const { invoke } = vi.hoisted(() => {
  const invoke = vi.fn((channel: string): unknown => {
    throw new Error(`요청을 만들 때는 IPC 를 부르지 않는다 (${channel})`)
  })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', { nais: { invoke } })
  return { invoke }
})

import { buildSceneRequest } from '../src/renderer/src/stores/scenes-store'
import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useSceneExtrasStore } from '../src/renderer/src/stores/scene-extras-store'
import { useOutfitsStore } from '../src/renderer/src/stores/outfits-store'
import { useCharRefsStore, useVibesStore } from '../src/renderer/src/stores/refs-store'

/**
 * 기본 꺼짐 설정 셋 — 입은 옷 자동 젖힘(expose_worn_clothes) · 눈 감으면 눈 태그 빼기(eyes_closed_strip) ·
 * 알몸일 때 pink nipples(nude_pink_nipples). 저장값이 '1' 일 때만 켜지고, 끄면 그 기능이 없을 때와 출력이 글자 단위로 같다.
 * 합성 카드·합성 씬만 쓴다 (사용자 데이터 없음).
 */

const KEYS = {
  exposeWorn: 'expose_worn_clothes',
  eyesClosedStrip: 'eyes_closed_strip',
  nudePinkNipples: 'nude_pink_nipples',
  futaReassembly: 'futa_reassembly'
} as const
type Flag = keyof typeof KEYS

const FLAGS = Object.keys(KEYS) as Flag[]

/** 저장값을 흉내 내 스토어를 불러온다 — stored 에 없는 키는 저장값 없음(null) */
async function loadWith(stored: Partial<Record<string, string>>): Promise<void> {
  invoke.mockReset()
  invoke.mockImplementation((channel: string, arg?: unknown): unknown => {
    if (channel === 'outfits:list') return { items: [] }
    if (channel === 'settings:get') return { value: stored[(arg as { key: string }).key] ?? null }
    if (channel === 'settings:set') return undefined
    throw new Error(`예상하지 못한 IPC: ${channel}`)
  })
  await useOutfitsStore.getState().load()
}

describe('저장값 읽기 — 저장값 없음 → 꺼짐, 1 → 켬, 0 → 꺼짐', () => {
  it('스토어 처음 값은 셋 다 꺼짐이다', () => {
    const initial = useOutfitsStore.getInitialState()
    for (const flag of FLAGS) expect(initial[flag], flag).toBe(false)
  })

  for (const flag of FLAGS) {
    it(`${KEYS[flag]} → ${flag}`, async () => {
      // 다른 설정이 켜져 있어도 이 키만 본다 — 먼저 전부 켜 두고 읽어 본다
      useOutfitsStore.setState({
        exposeWorn: true,
        eyesClosedStrip: true,
        nudePinkNipples: true,
        futaReassembly: true
      })
      await loadWith({})
      expect(useOutfitsStore.getState()[flag]).toBe(false)
      await loadWith({ [KEYS[flag]]: '1' })
      expect(useOutfitsStore.getState()[flag]).toBe(true)
      // 이 키만 켜진다 — 나머지는 저장값이 없으니 꺼짐
      for (const other of FLAGS.filter((f) => f !== flag))
        expect(useOutfitsStore.getState()[other], other).toBe(false)
      await loadWith({ [KEYS[flag]]: '0' })
      expect(useOutfitsStore.getState()[flag]).toBe(false)
      // 1 이 아닌 다른 값도 꺼짐
      for (const odd of ['', 'true', 'on', '2'] as const) {
        await loadWith({ [KEYS[flag]]: odd })
        expect(useOutfitsStore.getState()[flag], odd).toBe(false)
      }
    })
  }

  it('켜고 끄면 저장값 1·0 을 그 키로 보낸다', () => {
    invoke.mockReset()
    const sent: { key: string; value: string }[] = []
    invoke.mockImplementation((channel: string, arg?: unknown): unknown => {
      if (channel === 'settings:set') {
        sent.push(arg as { key: string; value: string })
        return undefined
      }
      throw new Error(`예상하지 못한 IPC: ${channel}`)
    })
    const s = useOutfitsStore.getState()
    s.setExposeWorn(true)
    s.setEyesClosedStrip(true)
    s.setNudePinkNipples(true)
    s.setExposeWorn(false)
    s.setEyesClosedStrip(false)
    s.setNudePinkNipples(false)
    expect(sent).toEqual([
      { key: 'expose_worn_clothes', value: '1' },
      { key: 'eyes_closed_strip', value: '1' },
      { key: 'nude_pink_nipples', value: '1' },
      { key: 'expose_worn_clothes', value: '0' },
      { key: 'eyes_closed_strip', value: '0' },
      { key: 'nude_pink_nipples', value: '0' }
    ])
  })
})

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

const sceneOf = (over: Partial<Scene> = {}): Scene =>
  ({
    id: 4,
    presetId: 1,
    name: '합성 씬',
    prompt: 'bed',
    negativePrompt: '',
    width: 832,
    height: 1216,
    reserveCount: 1,
    varietyPlus: false,
    sourceTags: '',
    targetTags: '',
    sourcePos: null,
    targetPos: null,
    censorKinds: [],
    ...over
  }) as Scene

/** 스토어를 처음 값(기본)으로 되돌리고, 옷 분류만 채운다 */
function resetToDefaults(): void {
  useOutfitsStore.setState(useOutfitsStore.getInitialState(), true)
  useOutfitsStore.setState({ kinds: { skirt: 'cloth' }, loaded: true })
  useGenerationStore.setState({
    request: { ...DEFAULT_REQUEST, prompt: 'masterpiece', negativePrompt: '' },
    promptSplitEnabled: false,
    source: null
  })
  useVibesStore.setState({ loaded: true })
  useCharRefsStore.setState({ loaded: true })
  useCharactersStore.setState({
    loaded: true,
    items: [card(1, '1girl, blue eyes, red hair, skirt', 'target')]
  })
  useSceneExtrasStore.setState({
    loaded: true,
    sequenceEnabled: false,
    entries: [],
    additionsEnabled: false,
    additions: {},
    nudeStrips: {}
  })
}

const only = (r: GenerationRequest): string => r.characterPrompts[0].prompt

// 셋 다 일어날 수 있는 장면 — 아래를 드러내는 행위(vaginal) + 알몸(nude) + 감은 눈(closed eyes)
const SCENE = sceneOf({ prompt: 'bed, vaginal, nude, closed eyes' })

describe('기본값(셋 다 꺼짐)의 출력 — 세 기능이 없을 때와 글자 단위로 같다', () => {
  beforeEach(resetToDefaults)

  it('옷 벗기기만 일어나고, 젖힘 태그·눈 태그 빼기·pink nipples 와 그 메모는 없다', () => {
    const r = buildSceneRequest(SCENE)
    // 눈 색은 그대로, 알몸 선언이 있어 치마만 걷힌다, pink nipples 없음
    expect(only(r)).toBe('1girl, blue eyes, red hair, nude, completely nude')
    expect('exposeNotes' in r).toBe(false)
    expect('bodyNotes' in r).toBe(false)
    expect('futaPlan' in r).toBe(false)
  })

  it('세 설정을 하나씩 켜면 그 기능만 일어난다 (켜면 지금과 똑같이 동작)', () => {
    useOutfitsStore.setState({ nudePinkNipples: true })
    const pink = buildSceneRequest(SCENE)
    expect(only(pink)).toBe('1girl, blue eyes, red hair, nude, completely nude, pink nipples')
    expect('exposeNotes' in pink).toBe(false)
    expect(pink.bodyNotes?.map((n) => [n.kind, n.after])).toEqual([['added', 'pink nipples']])

    useOutfitsStore.setState({ nudePinkNipples: false, eyesClosedStrip: true })
    const eyes = buildSceneRequest(SCENE)
    expect(only(eyes)).toBe('1girl, red hair, nude, completely nude')
    expect(eyes.bodyNotes?.map((n) => [n.kind, n.topic, n.before])).toEqual([
      ['removed', 'eyes', 'blue eyes']
    ])
    expect('exposeNotes' in eyes).toBe(false)

    useOutfitsStore.setState({ eyesClosedStrip: false, exposeWorn: true })
    const expose = buildSceneRequest(SCENE)
    expect(only(expose)).toBe('1girl, blue eyes, red hair, nude, completely nude')
    expect(expose.exposeNotes?.length).toBeGreaterThan(0)
    expect('bodyNotes' in expose).toBe(false)
  })

  it('입은 옷 자동 젖힘이 꺼져 있으면 옷을 입은 채 아래를 드러내는 장면이어도 젖힘 태그와 exposeNotes 가 없다', () => {
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: false } } })
    const r = buildSceneRequest(sceneOf({ prompt: 'bed, vaginal' }))
    expect(only(r)).toBe('1girl, blue eyes, red hair, skirt')
    expect('exposeNotes' in r).toBe(false)
    useOutfitsStore.setState({ exposeWorn: true })
    const on = buildSceneRequest(sceneOf({ prompt: 'bed, vaginal' }))
    expect(on.exposeNotes?.length).toBeGreaterThan(0)
  })

  it('메인 탭도 같다 — 기본이면 눈 태그와 pink nipples 와 젖힘 메모가 없다', async () => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: 'bed, vaginal, nude, closed eyes' },
      promptSplitEnabled: false
    })
    // 옷 분류는 메인 프로세스에 묻는 값이라 미리 채워 둔다 (요청 조립은 IPC 를 부르지 않는다)
    useOutfitsStore.setState({
      kinds: new Proxy(
        {},
        { has: () => true, get: (_t, p) => (p === 'skirt' ? 'cloth' : 'body') }
      ) as never
    })
    const off = await useGenerationStore.getState().buildMainRequest()
    expect(only(off)).toBe('1girl, blue eyes, red hair, nude, completely nude')
    expect('exposeNotes' in off).toBe(false)
    expect('bodyNotes' in off).toBe(false)
    useOutfitsStore.setState({ eyesClosedStrip: true, nudePinkNipples: true })
    const on = await useGenerationStore.getState().buildMainRequest()
    expect(only(on)).toBe('1girl, red hair, nude, completely nude, pink nipples')
    expect(on.bodyNotes?.length).toBe(2)
  })
})
