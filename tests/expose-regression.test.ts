import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CharacterCard, ExposeNote, Scene } from '../src/shared/types'

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

import { buildSceneRequest } from '../src/renderer/src/stores/scenes-store'
import { DEFAULT_REQUEST, useGenerationStore } from '../src/renderer/src/stores/generation-store'
import { useCharactersStore } from '../src/renderer/src/stores/characters-store'
import { useSceneExtrasStore } from '../src/renderer/src/stores/scene-extras-store'
import { useOutfitsStore } from '../src/renderer/src/stores/outfits-store'
import { DEFAULT_EXPOSE_ACTS } from '../src/shared/auto-expose'
import { tagsOf } from '../src/shared/auto-expose'
import { CARDS, OUTFITS, SCENES, type SyntheticScene } from './fixtures/expose-synthetic'

/**
 * 합성 회귀 — 사용자 씬 골격을 흉내 낸 합성 씬(tests/fixtures/expose-synthetic.ts)으로
 * 요청 전체(buildSceneRequest)를 만들어, 부위별 판정과 붙은 태그를 표로 확인한다.
 */

const KINDS = Object.fromEntries(
  [
    'pleated skirt',
    'white panties',
    'white shirt',
    'white bra',
    'black pants',
    'white dress',
    'black bikini',
    'skirt'
  ].map((t) => [t, 'cloth'])
)

const card = (key: string, enabled: boolean): CharacterCard => {
  const c = CARDS[key]
  return {
    id: c.id,
    name: c.name,
    // 어느 캐릭터의 프롬프트인지 알아보려는 표지 — 옷·행위 낱말이 없어서 판정에는 영향이 없다
    prompt: `zz${c.id}, ${c.prompt}`,
    negativePrompt: '',
    enabled,
    center: { x: 0.5, y: 0.5 },
    role: c.role,
    slotNo: null,
    charRefId: null,
    ...(c.outfitId ? { outfitId: c.outfitId } : {})
  } as CharacterCard
}

const sceneOf = (s: SyntheticScene): Scene =>
  ({
    id: 4,
    presetId: 1,
    name: s.name,
    prompt: s.prompt,
    negativePrompt: '',
    width: 832,
    height: 1216,
    reserveCount: 1,
    varietyPlus: false,
    sourceTags: s.sourceTags ?? '',
    targetTags: s.targetTags ?? '',
    sourcePos: null,
    targetPos: null,
    censorKinds: []
  }) as Scene

interface Drawn {
  prompts: Record<number, string[]>
  notes: ExposeNote[] | undefined
}

/** 합성 씬 하나를 이 설정으로 그려 본다 — 카드 id → 그 카드의 프롬프트들(자리마다) */
function draw(s: SyntheticScene, exposeWorn: boolean): Drawn {
  const heroine = s.heroine ?? 'A'
  useGenerationStore.setState({
    request: { ...DEFAULT_REQUEST, prompt: '', negativePrompt: '' },
    promptSplitEnabled: false,
    source: null
  })
  useOutfitsStore.setState({
    items: OUTFITS,
    acts: DEFAULT_EXPOSE_ACTS,
    stripOnNude: false,
    exposeWorn,
    kinds: KINDS as never
  })
  useCharactersStore.setState({
    items: Object.keys(CARDS).map((k) => card(k, k === heroine))
  })
  const male = s.male ? CARDS[s.male] : undefined
  const slotCount = Math.max(-1, ...Object.keys(s.slotRoles ?? {}).map(Number)) + 1
  useSceneExtrasStore.setState({
    loaded: true,
    sequenceEnabled: false,
    entries: [],
    additionsEnabled: true,
    additions: {
      1: {
        4: {
          characterIds: male ? [male.id] : [],
          charRefIds: [],
          vibeIds: [],
          ...(male ? { roles: { [male.id]: 'source' as const } } : {}),
          ...(slotCount > 0
            ? {
                slots: Array.from({ length: slotCount }, (_, i) => ({ x: 0.2 + i * 0.3, y: 0.5 })),
                slotRoles: s.slotRoles,
                slotTags: s.slotTags
              }
            : {})
        }
      }
    },
    nudeStrips: s.nudeStrip !== undefined ? { 1: { 4: s.nudeStrip } } : {}
  })
  const request = buildSceneRequest(sceneOf(s))
  const prompts: Record<number, string[]> = {}
  for (const cp of request.characterPrompts) {
    const m = /zz(\d+),?\s*/.exec(cp.prompt)
    if (!m) continue
    ;(prompts[Number(m[1])] ??= []).push(cp.prompt.replace(m[0], ''))
  }
  return { prompts, notes: request.exposeNotes }
}

const statusOf = (
  notes: ExposeNote[] | undefined,
  id: number,
  area: 'lower' | 'chest'
): string | undefined => {
  // 「근거 없음(not-needed)」은 판정이 아니니 뺀다. 충돌은 같은 부위에 다른 판정이 없을 때만 그 부위의 상태다
  const here = (notes ?? []).filter(
    (n) => n.charId === id && n.area === area && n.status !== 'not-needed'
  )
  return (here.find((n) => n.status !== 'conflict') ?? here[0])?.status
}

const addedOf = (notes: ExposeNote[] | undefined, id: number): string[] => [
  ...new Set(
    (notes ?? []).filter((n) => n.charId === id && n.status === 'added').flatMap((n) => n.tags)
  )
]

describe('합성 씬 회귀 — 부위별 판정과 붙은 태그', () => {
  beforeEach(() => {
    useOutfitsStore.setState({ exposeWorn: true })
  })

  it.each(SCENES.map((s) => [s.name, s] as const))('%s', (_name, scene) => {
    const { prompts, notes } = draw(scene, true)
    for (const [key, want] of Object.entries(scene.expect)) {
      const id = CARDS[key].id
      for (const area of ['lower', 'chest'] as const) {
        if (!(area in want)) continue
        expect(statusOf(notes, id, area), `${key} ${area}`).toBe(want[area])
      }
      if (want.add) {
        expect(addedOf(notes, id), `${key} 붙은 태그`).toEqual(want.add)
        // 붙은 태그는 그 캐릭터 프롬프트(한 자리 이상)에 그대로 들어 있다
        const joined = (prompts[id] ?? []).join(' | ')
        for (const t of want.add) expect(joined, `${key} 프롬프트에 ${t}`).toContain(t)
      }
    }
  })

  it('옷 벗기기=켬 + 자리의 clothing aside 는 충돌로 표시만 한다 (알몸 우선)', () => {
    const scene = SCENES.find((s) => s.name.startsWith('핑거링 · 옷 벗기기=켬'))!
    const { prompts, notes } = draw(scene, true)
    const conflict = notes?.filter((n) => n.status === 'conflict' && n.charId === CARDS.A.id)
    expect(conflict?.length).toBeGreaterThan(0)
    expect(conflict?.[0].tags).toContain('clothing aside')
    // 알몸이라 옷 태그는 걷히고 nude 가 붙는다 — clothing aside 는 건드리지 않는다
    expect(prompts[CARDS.A.id].join(' ')).toContain('completely nude')
  })

  it('얼굴 인셋 자리에는 몸 증거도 입은 옷 재고도 없다', () => {
    const scene = SCENES.find((s) => s.name.startsWith('얼굴 인셋'))!
    const { prompts, notes } = draw(scene, true)
    const seats = prompts[CARDS.A.id]
    expect(seats).toHaveLength(2)
    // 몸 자리(0번)에만 젖힘이 붙고, 인셋(1번)에는 안 붙는다
    expect(seats[0]).toContain('skirt lift')
    expect(seats[1]).not.toContain('skirt lift')
    expect(notes).toContainEqual(
      expect.objectContaining({ charIndex: expect.any(Number), status: 'off-frame' })
    )
  })

  it('모든 합성 씬 x 모든 히로인: 붙은 태그는 notes 에 있고, notes 에 없는 젖힘 태그는 붙지 않는다', () => {
    for (const scene of SCENES) {
      for (const heroine of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
        const label = `${scene.name} / ${heroine}`
        const { prompts, notes } = draw({ ...scene, heroine }, true)
        expect(notes, label).toBeDefined()
        for (const n of notes ?? []) expect(n.reason, label).toBeTruthy()
        for (const [idText, list] of Object.entries(prompts)) {
          const id = Number(idText)
          const key = Object.keys(CARDS).find((k) => CARDS[k].id === id) as string
          const added = addedOf(notes, id)
          // 프롬프트에 원래 있던 태그 — 카드·복장 조각·씬·자리 글, 알몸 처리가 붙이는 nude
          const given = new Set(
            tagsOf(
              [
                CARDS[key].prompt,
                ...OUTFITS.flatMap((o) => o.pieces.map((p) => p.tags)),
                scene.prompt,
                scene.sourceTags ?? '',
                scene.targetTags ?? '',
                ...Object.values(scene.slotTags ?? {}),
                'nude, completely nude'
              ].join(', ')
            )
          )
          for (const prompt of list) {
            const tags = tagsOf(prompt)
            // 몰래 붙이기 금지 — 원래 글에 없던 태그는 모두 notes 의 added 태그다
            for (const t of tags) if (!given.has(t)) expect(added, `${label}: ${t}`).toContain(t)
            // 같은 젖힘 태그가 두 번 붙지 않는다
            for (const t of added)
              expect(tags.filter((x) => x === t).length, `${label}: ${t}`).toBeLessThanOrEqual(1)
          }
          // 붙었다고 한 태그는 적어도 한 자리의 프롬프트에 실제로 있다
          if (added.length)
            expect(
              list.some((prompt) => added.every((t) => tagsOf(prompt).includes(t))),
              label
            ).toBe(true)
        }
      }
    }
  })

  it('설정을 끄면 메모가 없고, 입은 옷 자동 젖힘이 붙인 태그가 하나도 없다', () => {
    for (const scene of SCENES) {
      const on = draw(scene, true)
      const off = draw(scene, false)
      expect(off.notes, scene.name).toBeUndefined()
      for (const [idText, list] of Object.entries(off.prompts)) {
        const id = Number(idText)
        // 켰을 때 자동층이 붙인 태그는 끄면 (카드·복장·씬에 이미 있던 게 아니면) 없다
        for (const t of addedOf(on.notes, id)) {
          const source = [CARDS[Object.keys(CARDS).find((k) => CARDS[k].id === id)!].prompt]
            .concat(
              scene.prompt,
              scene.sourceTags ?? '',
              scene.targetTags ?? '',
              Object.values(scene.slotTags ?? {})
            )
            .join(', ')
          if (!tagsOf(source).includes(t) && !OUTFITS[0].pieces.some((p) => p.tags.includes(t)))
            expect(list.join(' | '), `${scene.name} ${t}`).not.toContain(t)
        }
      }
    }
  })
})
