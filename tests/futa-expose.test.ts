import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterCard, Scene } from '../src/shared/types'

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

import { DEFAULT_EXPOSE_ACTS as acts } from '../src/shared/auto-expose'
import { bodyOfSex, readBody } from '../src/shared/body'
import { analyzeText } from '../src/shared/expose-evidence'
import {
  analyzeExposure,
  declaredNudeAreas,
  finishExposure,
  gateAuto,
  type ExposeChar,
  type ExposeField,
  type SceneExposure
} from '../src/shared/expose-state'
import type { Outfit } from '../src/shared/outfit'
import { buildSceneRequest } from '../src/renderer/src/stores/scenes-store'
import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useSceneExtrasStore } from '../src/renderer/src/stores/scene-extras-store'
import { useOutfitsStore } from '../src/renderer/src/stores/outfits-store'
import { autoAreasFromNotes } from '../src/renderer/src/lib/expose-notes'

/**
 * 몸 기준 주인 배정 (후타) · 알몸 선언이 있는 부위의 nsfw 조각 · erect nipples — 합성 입력만.
 * 캐릭터: 남(하는쪽) · 여(당하는쪽) · 후타(하는쪽/당하는쪽)
 */
const base = (
  index: number,
  name: string
): Pick<ExposeChar, 'index' | 'id' | 'name' | 'faceSeat' | 'autoOff'> => ({
  index,
  id: index + 1,
  name,
  faceSeat: false,
  autoOff: false
})
const man = (index = 0): ExposeChar => ({
  ...base(index, '남'),
  sex: 'male',
  role: 'source',
  receivesScene: false
})
const woman = (index = 1): ExposeChar => ({
  ...base(index, '여'),
  sex: 'female',
  role: 'target',
  receivesScene: true
})
/** 카드에서 읽은 후타 몸을 단 캐릭터 (역할은 characterSex 기준 그대로) */
const futa = (index: number, role: 'source' | 'target'): ExposeChar => ({
  ...base(index, '후타'),
  sex: role === 'source' ? 'male' : 'female',
  body: readBody(role, ['1girl, futanari'], true).body,
  role,
  receivesScene: role === 'target'
})

const read = (chars: ExposeChar[], ...fields: ExposeField[]): SceneExposure =>
  analyzeExposure({ chars, fields, acts })
const lower = (ex: SceneExposure, i: number): boolean => ex.chars[i].areas.lower.needed
const chest = (ex: SceneExposure, i: number): boolean => ex.chars[i].areas.chest.needed

describe('몸 기준 주인 배정 — 후타', () => {
  it('S1 후타(하는쪽) + 여: 삽입이면 둘 다 아래가 열린다 (옛 동작과 같다)', () => {
    const ex = read(
      [woman(0), futa(1, 'source')],
      { text: 'hetero, missionary', scope: 'scene' },
      { text: 'vaginal, penis in pussy', scope: 'source' }
    )
    expect(lower(ex, 0)).toBe(true)
    expect(lower(ex, 1)).toBe(true)
  })

  it('S4 후타(하는쪽) + 여: 파이즈리는 여 가슴만 — 후타 가슴은 열지 않는다', () => {
    const ex = read([woman(0), futa(1, 'source')], { text: 'paizuri', scope: 'scene' })
    expect(chest(ex, 0)).toBe(true)
    expect(chest(ex, 1)).toBe(false)
    expect(lower(ex, 1)).toBe(true)
  })

  it('S2b 남(하는쪽) + 후타(당하는쪽): 당하는쪽 칸의 음경 태그는 후타 아래도 연다 (남캐 아래만 열리던 어긋남)', () => {
    const chars = [man(0), futa(1, 'target')]
    const fields: ExposeField[] = [{ text: 'large penis, erection', scope: 'target' }]
    const withBody = read(chars, ...fields)
    expect(lower(withBody, 1)).toBe(true)
    // 몸을 모르던 옛 방식은 후타(여로 분류) 아래가 비었다
    const legacy = read([man(0), { ...futa(1, 'target'), body: undefined }], ...fields)
    expect(lower(legacy, 1)).toBe(false)
    expect(lower(legacy, 0)).toBe(true)
  })

  it('S2c 씬 전체 fellatio: 음경 보유자가 둘이면 둘 다 (태그는 칸으로 못 가른다)', () => {
    const ex = read([man(0), futa(1, 'target')], { text: 'fellatio', scope: 'scene' })
    expect(lower(ex, 0)).toBe(true)
    expect(lower(ex, 1)).toBe(true)
  })

  it('S2 하는쪽 칸의 handjob 은 하는쪽(남캐)만 — 칸의 행위자 몫', () => {
    const ex = read([man(0), futa(1, 'target')], { text: 'handjob', scope: 'source' })
    expect(lower(ex, 0)).toBe(true)
    expect(lower(ex, 1)).toBe(false)
  })

  it('S7 남(하는쪽) + 후타(당하는쪽): 하는쪽이 가슴을 주무르면 후타 가슴 — 여 대조군과 같다', () => {
    const f = { text: "grabbing another's breast", scope: 'source' as const }
    expect(chest(read([man(0), futa(1, 'target')], f), 1)).toBe(true)
    expect(chest(read([man(0), woman(1)], f), 1)).toBe(true)
    expect(chest(read([man(0), futa(1, 'target')], f), 0)).toBe(false)
  })

  it('쿤닐링구스는 받는 몸의 음부 — 당하는쪽 후타 아래가 열리고, 하는쪽 후타는 열리지 않는다', () => {
    const f = { text: 'cunnilingus', scope: 'scene' as const }
    expect(lower(read([man(0), futa(1, 'target')], f), 1)).toBe(true)
    // 하는쪽 후타(음부는 받는 몸일 때만)와 여: 여 아래만
    const both = read([woman(0), futa(1, 'source')], f)
    expect(lower(both, 0)).toBe(true)
    expect(lower(both, 1)).toBe(false)
    // 질 없는 후타(futa without pussy)는 받는 쪽이어도 음부 증거를 받지 않는다
    const noPussy: ExposeChar = {
      ...futa(1, 'target'),
      body: readBody('target', ['futa without pussy'], true).body
    }
    expect(lower(read([man(0), noPussy], f), 1)).toBe(false)
  })

  it('문장의 he/she 는 역할의 성별을 따른다 — 후타 하는쪽은 「그」, 가슴 이야기(her)는 상대 것', () => {
    const ex = read([woman(0), futa(1, 'source')], {
      text: 'his cock slides into her pussy, she grabs her breasts',
      scope: 'scene'
    })
    expect(lower(ex, 1)).toBe(true)
    expect(chest(ex, 0)).toBe(true)
    expect(chest(ex, 1)).toBe(false)
  })

  it('이 캐릭터 칸의 증거는 그 캐릭터 몸이 받는다 (후타 하는쪽의 자기 가슴·음경)', () => {
    const f = futa(1, 'source')
    const ex = read([woman(0), f], { text: 'nipples, erection', scope: 'char', index: 1 })
    expect(chest(ex, 1)).toBe(true)
    expect(lower(ex, 1)).toBe(true)
    expect(chest(ex, 0)).toBe(false)
  })

  it('문장의 her cock · her penis · her balls 는 여성형 지칭어여도 음경 보유자(후타)의 것이다', () => {
    for (const text of [
      'She strokes her hard cock',
      'her cock slides into his mouth',
      'her penis is throbbing',
      'She licks her balls',
      'the futanari strokes her erection'
    ]) {
      const ex = read([woman(0), futa(1, 'source')], { text, scope: 'scene' })
      expect(lower(ex, 1), text).toBe(true)
      // 상대 여캐의 아래는 이 문장으로 열리지 않는다
      expect(lower(ex, 0), text).toBe(false)
    }
    // 같은 문장도 후타가 없으면 옛 방식 그대로(여로 분류된 캐릭터가 받는다)
    const legacy = read([woman(0), { ...man(1) }], {
      text: 'She strokes her hard cock',
      scope: 'scene'
    })
    expect(lower(legacy, 0)).toBe(true)
  })

  it('몸을 모르는 캐릭터만 있으면 옛 방식 그대로다 — 몸을 넘겨도 비후타는 같다', () => {
    const plain = read([man(0), woman(1)], { text: 'vaginal', scope: 'scene' })
    const withBody = read(
      [
        { ...man(0), body: bodyOfSex('male') },
        { ...woman(1), body: bodyOfSex('female') }
      ],
      { text: 'vaginal', scope: 'scene' }
    )
    expect(withBody.chars.map((c) => c.areas)).toEqual(plain.chars.map((c) => c.areas))
  })
})

describe('erect nipples 단독은 옷 위 표지가 아니다', () => {
  const kinds = (text: string): string[] =>
    analyzeText(text, { actor: null }, acts).evidence.map((e) => e.kind)

  it('erect nipples 만 있으면 옷 위(over)가 아니다', () => {
    expect(kinds('erect nipples')).not.toContain('over')
  })

  it('옷 낱말이 같이 있을 때만 옷 위 표지다', () => {
    expect(kinds('erect nipples under clothes')).toContain('over')
    expect(kinds('erect nipples visible through shirt')).toContain('over')
    expect(kinds('erect nipples, dress')).not.toContain('over')
  })

  it('알몸으로 벗긴 캐릭터에 erect nipples 가 있어도 충돌로 표시하지 않는다', () => {
    const woman0 = woman(0)
    const scene = read([woman0], { text: 'erect nipples', scope: 'char', index: 0 })
    const done = finishExposure(scene.chars[0], scene, {
      card: 'nude, completely nude',
      outfit: '',
      own: ['erect nipples'],
      stripped: true,
      strippedBy: '옷 벗기기 둘 다',
      piece: { state: { lower: 'none', chest: 'none' }, tags: { lower: [], chest: [] } }
    })
    expect(done.notes.some((n) => n.status === 'conflict')).toBe(false)
    // 옷 위 접촉을 적으면 여전히 충돌이다
    const over = read([woman0], { text: 'erect nipples under clothes', scope: 'char', index: 0 })
    const doneOver = finishExposure(over.chars[0], over, {
      card: 'nude, completely nude',
      outfit: '',
      own: ['erect nipples under clothes'],
      stripped: true,
      strippedBy: '옷 벗기기 둘 다',
      piece: { state: { lower: 'none', chest: 'none' }, tags: { lower: [], chest: [] } }
    })
    expect(doneOver.notes.some((n) => n.status === 'conflict')).toBe(true)
  })
})

// ── 알몸 선언이 있는 부위는 복장 nsfw 조각도 켜지 않는다 ─────────────────

describe('알몸 선언 + 복장 nsfw 조각 (이상 징후 1)', () => {
  const outfit = (pieceTags: string): Outfit =>
    ({
      id: 9,
      name: '복장',
      negative: '',
      pieces: [
        { id: 'a', tags: 'pleated skirt, white panties', on: true },
        { id: 'b', tags: pieceTags, on: false, when: 'nsfw-lower' }
      ]
    }) as unknown as Outfit

  it('gateAuto — 같은 부위에 알몸 선언이 있으면 auto 를 끄고, 누드 조각이면 그대로 둔다', () => {
    const ex = read([woman(0)], { text: 'vaginal', scope: 'scene' })
    expect(ex.chars[0].auto.lower).toBe(true)
    const declared = { lower: true, chest: false }
    expect(gateAuto(ex.chars[0], declared, outfit('panties aside')).lower).toBe(false)
    // 그 부위의 nsfw 조각이 누드 조각이면 예외 — 그대로 켠다
    expect(gateAuto(ex.chars[0], declared, outfit('bottomless, completely nude')).lower).toBe(true)
    // 선언이 없으면 그대로
    expect(
      gateAuto(ex.chars[0], { lower: false, chest: false }, outfit('panties aside')).lower
    ).toBe(true)
    // 복장이 없으면(카드 옷만) 끈다 — 카드 옷 결과와 같다
    expect(gateAuto(ex.chars[0], declared, undefined).lower).toBe(false)
  })

  it('declaredNudeAreas — nude · bottomless · topless · 문장의 ass nude, 씬 전체 글은 받는 캐릭터만', () => {
    const ex = read(
      [man(0), woman(1)],
      { text: 'bed, vaginal, ass nude', scope: 'scene' },
      { text: 'topless', scope: 'char', index: 1 }
    )
    const scene = ex
    expect(declaredNudeAreas(ex.chars[1], scene, ['1girl'])).toEqual({ lower: true, chest: true })
    // 씬 전체 글을 받지 않는 하는쪽은 선언이 없다
    expect(declaredNudeAreas(ex.chars[0], scene, ['1boy'])).toEqual({ lower: false, chest: false })
    expect(declaredNudeAreas(ex.chars[0], scene, ['1boy, bottomless'])).toEqual({
      lower: true,
      chest: false
    })
  })
})

describe('알몸 선언 + 복장 nsfw 조각 — 요청 조립 전체', () => {
  const OUTFIT = {
    id: 9,
    name: '복장',
    negative: '',
    pieces: [
      { id: 'a', tags: 'pleated skirt, white panties', on: true },
      { id: 'b', tags: 'panties aside, skirt lift', on: false, when: 'nsfw-lower' }
    ]
  } as unknown as Outfit
  const heroine = (outfitId: number | null): CharacterCard =>
    ({
      id: 1,
      name: '히로인',
      prompt: '1girl, red hair',
      negativePrompt: '',
      enabled: true,
      center: { x: 0.5, y: 0.5 },
      role: 'target',
      slotNo: null,
      charRefId: null,
      outfitId
    }) as unknown as CharacterCard
  const sceneOf = (prompt: string): Scene =>
    ({
      id: 4,
      presetId: 1,
      name: '합성 씬',
      prompt,
      negativePrompt: '',
      width: 832,
      height: 1216,
      reserveCount: 1,
      varietyPlus: false,
      sourceTags: '',
      targetTags: '',
      sourcePos: null,
      targetPos: null,
      censorKinds: []
    }) as Scene

  beforeEach(() => {
    useGenerationStore.setState({
      request: { ...DEFAULT_REQUEST, prompt: '', negativePrompt: '' },
      promptSplitEnabled: false,
      source: null
    })
    useOutfitsStore.setState({
      items: [OUTFIT],
      acts,
      stripOnNude: false,
      exposeWorn: true,
      kinds: {}
    })
    useCharactersStore.setState({ items: [heroine(9)] })
    useSceneExtrasStore.setState({
      loaded: true,
      sequenceEnabled: false,
      entries: [],
      additionsEnabled: false,
      additions: {},
      nudeStrips: {}
    })
  })

  it('알몸 선언이 없으면 nsfw 조각이 켜진다 (대조군)', () => {
    const r = buildSceneRequest(sceneOf('bed, vaginal'))
    expect(r.characterPrompts[0].prompt).toContain('panties aside, skirt lift')
  })

  it('같은 부위에 bottomless · ass nude 선언이 있으면 조각이 켜지지 않고 「알몸」으로 남는다', () => {
    for (const text of ['bed, vaginal, bottomless', 'bed, vaginal, ass nude']) {
      const r = buildSceneRequest(sceneOf(text))
      expect(r.characterPrompts[0].prompt, text).not.toContain('panties aside')
      expect(r.exposeNotes, text).toContainEqual(
        expect.objectContaining({ area: 'lower', status: 'nude' })
      )
      // 몰래 끄지 않는다 — 안 켠 까닭이 메모에 있다
      expect(
        r.exposeNotes?.some((n) => n.status === 'piece' && n.area === 'lower'),
        text
      ).toBe(false)
    }
  })

  it('조각을 막은 부위는 메모가 gated 로 말하고, 복장 선택 화면은 그 부위를 「저절로 켜짐」으로 세지 않는다', () => {
    const r = buildSceneRequest(sceneOf('bed, vaginal, bottomless'))
    const note = r.exposeNotes?.find((n) => n.area === 'lower' && n.status === 'nude')
    expect(note?.gated).toBe(true)
    expect(note?.reason).toContain('복장의 nsfw 조각도 켜지지 않음')
    expect(autoAreasFromNotes(r.exposeNotes ?? [], true).lower).toBe(false)
    // 막히지 않은 대조군은 그대로 저절로 켜진다
    const open = buildSceneRequest(sceneOf('bed, vaginal'))
    expect(autoAreasFromNotes(open.exposeNotes ?? [], true).lower).toBe(true)
  })

  it('복장에 그 부위의 nsfw 조각이 없으면 gated 가 아니다 (막을 조각이 없다)', () => {
    useCharactersStore.setState({
      items: [{ ...heroine(null), prompt: '1girl, red hair, pleated skirt, white panties' }]
    })
    const r = buildSceneRequest(sceneOf('bed, vaginal, bottomless'))
    const note = r.exposeNotes?.find((n) => n.area === 'lower' && n.status === 'nude')
    expect(note?.gated).toBeUndefined()
    expect(note?.reason).not.toContain('nsfw 조각')
  })

  it('다른 부위의 선언은 이 부위 조각을 막지 않는다 (topless 는 아래와 무관)', () => {
    const r = buildSceneRequest(sceneOf('bed, vaginal, topless'))
    expect(r.characterPrompts[0].prompt).toContain('panties aside, skirt lift')
  })

  it('nsfw 조각 자체가 누드 조각이면 선언이 있어도 켠다', () => {
    useOutfitsStore.setState({
      items: [
        {
          ...OUTFIT,
          pieces: [
            { id: 'a', tags: 'pleated skirt', on: true },
            { id: 'b', tags: 'bottomless, completely nude', on: false, when: 'nsfw-lower' }
          ]
        } as unknown as Outfit
      ]
    })
    const r = buildSceneRequest(sceneOf('bed, vaginal, bottomless'))
    expect(r.characterPrompts[0].prompt).toContain('completely nude')
  })

  it('카드에 직접 적은 옷의 결과와 같다 — 복장 없는 카드도 알몸으로 남는다', () => {
    useCharactersStore.setState({
      items: [{ ...heroine(null), prompt: '1girl, red hair, pleated skirt, white panties' }]
    })
    const r = buildSceneRequest(sceneOf('bed, vaginal, bottomless'))
    expect(r.exposeNotes).toContainEqual(expect.objectContaining({ area: 'lower', status: 'nude' }))
    expect(r.characterPrompts[0].prompt).not.toContain('skirt lift')
  })
})
