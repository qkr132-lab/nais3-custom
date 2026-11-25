import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterCard, GenerationRequest, Scene } from '../src/shared/types'

vi.hoisted(() => {
  const invoke = vi.fn((channel: string): unknown => {
    throw new Error(`요청을 만들 때는 IPC 를 부르지 않는다 (${channel})`)
  })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() })
  vi.stubGlobal('window', { nais: { invoke } })
})

import { buildSceneRequest } from '../src/renderer/src/stores/scenes-store'
import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useSceneExtrasStore } from '../src/renderer/src/stores/scene-extras-store'
import { useOutfitsStore } from '../src/renderer/src/stores/outfits-store'
import { useCardFitStore } from '../src/renderer/src/stores/card-fit-store'
import { useCharRefsStore, useVibesStore } from '../src/renderer/src/stores/refs-store'
import { DEFAULT_EXPOSE_ACTS } from '../src/shared/auto-expose'
import { compileCardFitRules } from '../src/shared/card-fit'
import { DEFAULT_CARD_FIT_RULES } from '../src/shared/card-fit-default'

/**
 * 카드 태그 씬 맞춤 — 요청 조립 전체 경로 (합성 카드·합성 씬만. 사용자 데이터는 쓰지 않는다).
 * 씬 > 세트 > 전체 설정 순으로 켜고 끄고, 끄면 글자 하나 다르지 않고, 뺀 것은 bodyNotes(topic fit)에 있다.
 */

const card = (
  id: number,
  prompt: string,
  role: CharacterCard['role'] = null,
  extra: Partial<CharacterCard> = {}
): CharacterCard =>
  ({
    id,
    name: `카드 ${id}`,
    prompt,
    negativePrompt: '',
    enabled: true,
    center: { x: 0.5, y: 0.5 },
    role,
    slotNo: null,
    charRefId: null,
    ...extra
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

const GIRL = 1
const BOY = 2
const GIRL_CARD = '1girl, 1.4::yellow eyes::, tsurime, cleavage, navel, white bandeau, loincloth'
const BOY_CARD = '1boy, fat man, 1.4::brown hair, short hair::, sanpaku, large penis'

function setup(opts: { fit?: boolean; rules?: boolean; eyes?: boolean } = {}): void {
  useGenerationStore.setState({
    request: { ...DEFAULT_REQUEST, prompt: 'masterpiece', negativePrompt: '' },
    promptSplitEnabled: false,
    source: null
  })
  useOutfitsStore.setState({
    items: [],
    acts: DEFAULT_EXPOSE_ACTS,
    stripOnNude: false,
    exposeWorn: false,
    futaReassembly: false,
    futaViewFix: true,
    eyesClosedStrip: opts.eyes ?? false,
    nudePinkNipples: false,
    // 옷 분류 — 메인이 알려 주는 값을 흉내 낸다
    kinds: { 'white bandeau': 'cloth', bandeau: 'cloth', loincloth: 'cloth' },
    loaded: true
  })
  useVibesStore.setState({ loaded: true })
  useCharRefsStore.setState({ loaded: true })
  useCharactersStore.setState({
    loaded: true,
    items: [card(GIRL, GIRL_CARD, 'target'), card(BOY, BOY_CARD, 'source')]
  })
  useSceneExtrasStore.setState({
    loaded: true,
    sequenceEnabled: false,
    entries: [],
    additionsEnabled: false,
    additions: {},
    nudeStrips: {},
    cardFits: {},
    cardFitPresets: {}
  })
  useCardFitStore.setState({
    loaded: true,
    enabled: opts.fit ?? true,
    rules: opts.rules === false ? null : compileCardFitRules(DEFAULT_CARD_FIT_RULES),
    error: null,
    warnings: []
  })
}

const prompts = (r: GenerationRequest): string[] => r.characterPrompts.map((c) => c.prompt)
const fitNotes = (r: GenerationRequest): NonNullable<GenerationRequest['bodyNotes']> =>
  (r.bodyNotes ?? []).filter((n) => n.topic === 'fit')

describe('켜고 끄기 — 전체 설정이 꺼져 있으면 끔, 켜져 있으면 씬 > 세트', () => {
  beforeEach(() => setup())

  it('전체 설정 켬: 감은 눈 씬에서 당하는쪽 눈매·눈 색이 빠지고 메모가 남는다', () => {
    const r = buildSceneRequest(sceneOf({ targetTags: 'closed eyes' }))
    expect(prompts(r)[0]).toBe('1girl, cleavage, navel, white bandeau, loincloth, closed eyes')
    expect(prompts(r)[1]).toBe(BOY_CARD)
    expect(fitNotes(r).map((n) => n.before)).toEqual(['yellow eyes', 'tsurime'])
  })

  it('전체 설정 끔: 글자 하나 다르지 않고 메모도 없다', () => {
    setup({ fit: false })
    const r = buildSceneRequest(sceneOf({ targetTags: 'closed eyes', prompt: 'from behind, pov' }))
    expect(prompts(r)).toEqual([`${GIRL_CARD}, closed eyes`, BOY_CARD])
    expect(r.bodyNotes).toBeUndefined()
  })

  it('규칙표가 깨졌으면(rules null) 켜져 있어도 고치지 않는다', () => {
    setup({ rules: false })
    const r = buildSceneRequest(sceneOf({ targetTags: 'closed eyes' }))
    expect(prompts(r)).toEqual([`${GIRL_CARD}, closed eyes`, BOY_CARD])
  })

  it('세트에서 끄면 그 세트 씬은 그대로, 씬에서 켜면 그 씬만 다시 켜진다', () => {
    // 세터는 저장(IPC)까지 하므로 상태만 바꾼다
    useSceneExtrasStore.setState({ cardFitPresets: { 1: false } })
    const off = buildSceneRequest(sceneOf({ targetTags: 'closed eyes' }))
    expect(prompts(off)[0]).toBe(`${GIRL_CARD}, closed eyes`)
    useSceneExtrasStore.setState({ cardFits: { 1: { 4: true } } })
    const on = buildSceneRequest(sceneOf({ targetTags: 'closed eyes' }))
    expect(prompts(on)[0]).not.toContain('tsurime')
    // 다른 씬(5)은 세트 값(끔)을 따른다
    const other = buildSceneRequest(sceneOf({ id: 5, targetTags: 'closed eyes' }))
    expect(prompts(other)[0]).toContain('tsurime')
  })

  it('전체 설정을 끄면 씬·세트에서 켜 둔 곳도 꺼진다 — 끄는 곳은 설정 창 하나', () => {
    setup({ fit: false })
    useSceneExtrasStore.setState({ cardFits: { 1: { 4: true } }, cardFitPresets: { 1: true } })
    const r = buildSceneRequest(sceneOf({ targetTags: 'closed eyes' }))
    expect(prompts(r)).toEqual([`${GIRL_CARD}, closed eyes`, BOY_CARD])
    expect(r.bodyNotes).toBeUndefined()
  })
})

describe('규칙 — 실제 조립 경로', () => {
  beforeEach(() => setup())

  it('rolling eyes: 눈매는 빼고 눈 색은 가중치만 푼다', () => {
    const r = buildSceneRequest(sceneOf({ targetTags: 'ahegao, rolling eyes' }))
    expect(prompts(r)[0]).toBe(
      '1girl, yellow eyes, cleavage, navel, white bandeau, loincloth, ahegao, rolling eyes'
    )
  })

  it('뒷모습: from behind 라고 카드 태그를 빼지 않는다', () => {
    const r = buildSceneRequest(sceneOf({ prompt: 'from behind, doggystyle' }))
    expect(prompts(r)).toEqual([GIRL_CARD, BOY_CARD])
  })

  it('pov: 하는쪽 머리·눈을 빼고 몸은 남긴다', () => {
    const r = buildSceneRequest(sceneOf({ prompt: 'pov, missionary' }))
    expect(prompts(r)[1]).toBe('1boy, fat man, large penis')
    expect(prompts(r)[0]).toBe(GIRL_CARD)
  })

  it('알몸이면 옷 벗기기 따라 켜기: 씬에 옷 벗기기 값이 없으면 카드 옷을 빼고 메모를 남긴다', () => {
    const r = buildSceneRequest(sceneOf({ targetTags: 'nude' }))
    expect(prompts(r)[0]).not.toMatch(/bandeau|loincloth/)
    const strip = fitNotes(r).filter((n) => n.reason.includes('옷 벗기기'))
    expect(strip.some((n) => n.kind === 'removed' && n.before?.includes('loincloth'))).toBe(true)
  })

  it('씬에서 「안 벗김」을 골랐으면 옷 벗기기를 켜지 않는다', () => {
    useSceneExtrasStore.setState({ nudeStrips: { 1: { 4: false } } })
    const r = buildSceneRequest(sceneOf({ targetTags: 'nude' }))
    expect(prompts(r)[0]).toContain('loincloth')
  })

  it('기존 「눈이 안 보이면 눈 태그 빼기」와 같이 켜도 두 번 빼지 않는다', () => {
    setup({ eyes: true })
    const r = buildSceneRequest(sceneOf({ targetTags: 'closed eyes' }))
    expect(prompts(r)[0]).toBe('1girl, cleavage, navel, white bandeau, loincloth, closed eyes')
    const eyes = (r.bodyNotes ?? []).filter((n) => n.topic === 'eyes')
    expect(eyes.map((n) => n.before)).toEqual(['yellow eyes'])
    expect(fitNotes(r).map((n) => n.before)).toEqual(['tsurime'])
  })
})
