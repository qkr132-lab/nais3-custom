import { describe, expect, it } from 'vitest'
import {
  buildFragmentsByPath,
  buildMainParams,
  buildNaiInfo,
  buildSnapshot,
  fragmentLines,
  hashValue,
  sceneCountsOf,
  sha1Hex,
  stableStringify,
  summarizeQueue,
  toCloudCharacter,
  toCloudScene,
  type SnapshotSource
} from '../src/main/cloud/snapshot'
import type { Fragment, ListFolder, QueueStatusLite, Scene, ScenePreset } from '../src/shared/types'

/**
 * 모바일 클라우드 — PC 스냅샷·해시 순수 함수 (커스텀). 합성 데이터만 쓴다.
 */

const scene = (over: Partial<Scene> & { id: number; presetId: number }): Scene => ({
  kind: 'scene',
  name: `씬${over.id}`,
  prompt: 'forest',
  negativePrompt: 'lowres',
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
  ...over
})

const preset = (
  id: number,
  name: string,
  kind: 'scene' | 'background',
  sceneCount = 0
): ScenePreset => ({
  id,
  name,
  kind,
  defaultWidth: null,
  defaultHeight: null,
  sceneCount
})

const baseSource = (): SnapshotSource => ({
  presets: [
    preset(1, '기본', 'scene', 2),
    preset(2, '두번째', 'scene', 0),
    preset(9, '배경', 'background', 1)
  ],
  scenes: [
    scene({ id: 10, presetId: 1, imageCount: 3 }),
    scene({ id: 11, presetId: 1 }),
    scene({ id: 90, presetId: 9, kind: 'background' })
  ],
  characters: [
    {
      id: 5,
      name: '한 명',
      prompt: '1girl',
      negativePrompt: '',
      enabled: true,
      folderId: 3,
      role: 'source',
      outfitId: 7
    },
    {
      id: 6,
      name: '두 명',
      prompt: '1boy',
      negativePrompt: 'x',
      enabled: false,
      folderId: null,
      role: null,
      outfitId: null
    }
  ],
  charFolders: [{ id: 3, name: '폴더', parentId: null }],
  outfits: [{ id: 7, name: '교복' }],
  fragmentFolders: [{ id: 1, name: '의상', collapsed: false, color: null }],
  fragments: [{ id: 1, name: 'Casual', content: 't-shirt\n# 주석\n\nhoodie # 뒤', folderId: 1 }],
  mainParamsRaw: JSON.stringify({ prompt: 'main', width: 640, height: 960, steps: 20 }),
  promptSplit: false,
  naiTier: 'opus'
})

describe('stableStringify · hashValue', () => {
  it('키 순서가 달라도 같은 글자열이고, undefined 는 뺀다', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: undefined, e: [3, { z: 1, y: 2 }] } })).toBe(
      stableStringify({ a: { e: [3, { y: 2, z: 1 }], d: 2 }, b: 1 })
    )
    expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}')
  })

  it('배열 순서는 바뀌면 다른 글자열이다', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })

  it('SHA-1 은 40자 16진수이고 내용이 바뀌면 달라진다', () => {
    const a = hashValue({ x: 1, y: [1, 2] })
    expect(a).toMatch(/^[0-9a-f]{40}$/)
    expect(hashValue({ y: [1, 2], x: 1 })).toBe(a)
    expect(hashValue({ x: 2, y: [1, 2] })).not.toBe(a)
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
  })
})

describe('toCloudScene · toCloudCharacter', () => {
  it('기본값과 같은 선택 필드는 싣지 않는다', () => {
    const lite = toCloudScene(
      scene({
        id: 1,
        presetId: 1,
        background: { prompt: '', placement: 'after-scene', replaceSimple: false },
        censorKinds: [],
        censorTagWeights: {},
        suppressAnal: false
      }),
      4
    )
    expect(lite).toMatchObject({ id: 1, presetId: 1, kind: 'scene', sortOrder: 4 })
    // 그림 수는 씬 본문에 싣지 않는다 (싣으면 그림마다 프리셋 해시가 바뀌어 씬 전체를 다시 올리게 된다)
    expect(lite).not.toHaveProperty('imageCount')
    expect(lite).not.toHaveProperty('background')
    expect(lite).not.toHaveProperty('censorKinds')
    expect(lite).not.toHaveProperty('censorTagWeights')
    expect(lite).not.toHaveProperty('suppressAnal')
    // 앱 안에서만 쓰는 필드는 안 나간다
    expect(lite).not.toHaveProperty('thumbnail')
    expect(lite).not.toHaveProperty('varietyPlus')
  })

  it('기본값이 아닌 배경·검열·항문 억제는 싣는다', () => {
    const lite = toCloudScene(
      scene({
        id: 1,
        presetId: 1,
        background: { prompt: 'forest', placement: 'before-scene', replaceSimple: true },
        censorKinds: ['penis'],
        censorTagWeights: { penis: 1.3 },
        suppressAnal: true
      }),
      0
    )
    expect(lite.background).toEqual({
      prompt: 'forest',
      placement: 'before-scene',
      replaceSimple: true
    })
    expect(lite.censorKinds).toEqual(['penis'])
    expect(lite.censorTagWeights).toEqual({ penis: 1.3 })
    expect(lite.suppressAnal).toBe(true)
  })

  it('캐릭터는 썸네일·좌표 없이 필요한 열만', () => {
    const base = baseSource().characters[0]
    const lite = toCloudCharacter(
      { ...base, thumbnail: 'AAAA', center: { x: 0.1, y: 0.2 } } as never,
      2
    )
    expect(lite).toEqual({
      id: 5,
      name: '한 명',
      folderId: 3,
      enabled: true,
      prompt: '1girl',
      negativePrompt: '',
      role: 'source',
      outfitId: 7,
      sortOrder: 2
    })
  })
})

describe('buildMainParams', () => {
  it('저장값이 없으면 기본값', () => {
    expect(buildMainParams(null, false)).toEqual({
      prompt: '',
      promptParts: null,
      promptSplit: false,
      negativePrompt: '',
      model: 'nai-diffusion-5-full',
      width: 832,
      height: 1216,
      steps: 28
    })
  })

  it('분할이 꺼져 있으면 저장된 promptParts 가 있어도 null, 켜져 있으면 3칸', () => {
    const raw = JSON.stringify({
      prompt: 'a, b, c',
      promptParts: { base: 'a', additional: 'b', detail: 'c' },
      model: 'nai-diffusion-4-5-full'
    })
    const off = buildMainParams(raw, false)
    expect(off.promptParts).toBeNull()
    expect(off.promptSplit).toBe(false)
    expect(off.model).toBe('nai-diffusion-4-5-full')
    const on = buildMainParams(raw, true)
    expect(on.promptSplit).toBe(true)
    expect(on.promptParts).toEqual({ base: 'a', additional: 'b', detail: 'c' })
    expect(on.prompt).toBe('a, b, c')
  })

  it('분할을 켰는데 promptParts 가 없으면 보이는 글을 base 로', () => {
    const on = buildMainParams(JSON.stringify({ prompt: '글' }), true)
    expect(on.promptParts).toEqual({ base: '글', additional: '', detail: '' })
  })

  it('손상된 JSON·엉뚱한 형식의 값은 기본값으로 버린다', () => {
    expect(buildMainParams('{깨짐', false).width).toBe(832)
    const odd = buildMainParams(JSON.stringify({ width: '큼', prompt: 5, steps: null }), false)
    expect(odd.width).toBe(832)
    expect(odd.prompt).toBe('')
    expect(odd.steps).toBe(28)
  })
})

describe('조각 표', () => {
  it('# 뒤는 주석, 빈 줄은 뺀다', () => {
    expect(fragmentLines('a\n # 주석 줄\n\n b # 꼬리 \n')).toEqual(['a', 'b'])
  })

  it('이름(소문자)과 폴더/이름(소문자) 두 키로 같은 줄 목록을 가리킨다', () => {
    const folders: ListFolder[] = [{ id: 1, name: '의상', collapsed: false, color: null }]
    const items: Fragment[] = [
      { id: 1, name: 'Casual', content: 'tee\nhoodie', folderId: 1 },
      { id: 2, name: 'Hair', content: 'long', folderId: null },
      { id: 3, name: 'Ghost', content: 'x', folderId: 99 } // 없는 폴더
    ]
    const byPath = buildFragmentsByPath(folders, items)
    expect(byPath).toEqual({
      casual: ['tee', 'hoodie'],
      '의상/casual': ['tee', 'hoodie'],
      hair: ['long'],
      ghost: ['x']
    })
  })

  it('__proto__ 같은 이름도 보통 키로 들어간다', () => {
    const byPath = buildFragmentsByPath(
      [],
      [{ id: 1, name: '__proto__', content: 'z', folderId: null }]
    )
    expect(Object.keys(byPath)).toEqual(['__proto__'])
    expect(JSON.parse(JSON.stringify(byPath))).toEqual(JSON.parse('{"__proto__":["z"]}'))
  })
})

describe('buildNaiInfo', () => {
  it('등급만 싣고(Anlas·사용량은 메인이 모른다) 등급이 없으면 null', () => {
    expect(buildNaiInfo('opus')).toEqual({
      tier: 'opus',
      anlas: null,
      opusUsage: null,
      updatedAt: 0
    })
    expect(buildNaiInfo(null)).toBeNull()
  })
})

describe('sceneCountsOf', () => {
  it('씬 id(글자열) → 그림 수, 그림이 없는 씬도 0 으로 싣는다', () => {
    expect(
      sceneCountsOf([
        scene({ id: 10, presetId: 1, imageCount: 3 }),
        scene({ id: 11, presetId: 1, imageCount: 0 })
      ])
    ).toEqual({ '10': 3, '11': 0 })
    expect(sceneCountsOf([])).toEqual({})
  })
})

describe('buildSnapshot', () => {
  it('프리셋은 종류별로 순번을 매기고, 씬은 프리셋별로 묶어 순번을 매긴다', () => {
    const snap = buildSnapshot(baseSource())
    expect(snap.library.presets).toEqual([
      { id: 1, name: '기본', kind: 'scene', sortOrder: 0, sceneCount: 2 },
      { id: 2, name: '두번째', kind: 'scene', sortOrder: 1, sceneCount: 0 },
      { id: 9, name: '배경', kind: 'background', sortOrder: 0, sceneCount: 1 }
    ])
    expect(snap.scenes.map((b) => [b.presetId, b.scenes.map((s) => [s.id, s.sortOrder])])).toEqual([
      [
        1,
        [
          [10, 0],
          [11, 1]
        ]
      ],
      [2, []],
      [9, [[90, 0]]]
    ])
    expect(snap.scenes[2].scenes[0].kind).toBe('background')
  })

  it('씬의 sortOrder 는 DB 의 정렬값 그대로 — 가운데 씬을 지워도 뒤 씬의 값과 해시 입력이 안 바뀐다', () => {
    const withOrder = (ids: [number, number][]): SnapshotSource => {
      const src = baseSource()
      src.scenes = ids.map(([id, order]) => ({ ...scene({ id, presetId: 1 }), sortOrder: order }))
      return src
    }
    const before = buildSnapshot(
      withOrder([
        [10, 0],
        [11, 1],
        [12, 2],
        [13, 3]
      ])
    )
    const after = buildSnapshot(
      withOrder([
        [10, 0],
        [12, 2],
        [13, 3]
      ])
    ) // 11 을 지웠다
    const pick = (snap: ReturnType<typeof buildSnapshot>): [number, number][] =>
      snap.scenes[0].scenes.map((s) => [s.id, s.sortOrder])
    expect(pick(before)).toEqual([
      [10, 0],
      [11, 1],
      [12, 2],
      [13, 3]
    ])
    expect(pick(after)).toEqual([
      [10, 0],
      [12, 2],
      [13, 3]
    ]) // 뒤 씬들이 한 칸씩 당겨지지 않는다
    // 지우지 않은 씬의 항목은 한 글자도 다르지 않다 (클라우드가 그 행을 다시 쓰지 않는다)
    const rows = (snap: ReturnType<typeof buildSnapshot>, id: number): string =>
      JSON.stringify(snap.scenes[0].scenes.find((s) => s.id === id))
    for (const id of [10, 12, 13]) expect(rows(after, id)).toBe(rows(before, id))
  })

  it('sortOrder 가 같거나 간격이 있어도 목록 순서를 그대로 둔다 (클라우드는 sortOrder → id 순)', () => {
    const src = baseSource()
    src.scenes = [
      { ...scene({ id: 20, presetId: 1 }), sortOrder: 5 },
      { ...scene({ id: 21, presetId: 1 }), sortOrder: 5 },
      { ...scene({ id: 22, presetId: 1 }), sortOrder: 9 }
    ]
    const list = buildSnapshot(src).scenes[0].scenes
    expect(list.map((s) => [s.id, s.sortOrder])).toEqual([
      [20, 5],
      [21, 5],
      [22, 9]
    ])
    // 클라우드가 하는 정렬(sort_order → id)을 해 봐도 PC 목록과 같다
    const cloudOrder = [...list].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    expect(cloudOrder.map((s) => s.id)).toEqual(list.map((s) => s.id))
  })

  it('sortOrder 가 없는 씬(시험용 입력)은 프리셋 안의 목록 위치를 쓴다', () => {
    const src = baseSource()
    src.scenes = [scene({ id: 30, presetId: 1 }), scene({ id: 31, presetId: 1 })]
    expect(buildSnapshot(src).scenes[0].scenes.map((s) => s.sortOrder)).toEqual([0, 1])
  })

  it('라이브러리: 캐릭터 순번·폴더·복장·메인·계정', () => {
    const { library } = buildSnapshot(baseSource())
    expect(library.characters.map((c) => [c.id, c.sortOrder, c.enabled])).toEqual([
      [5, 0, true],
      [6, 1, false]
    ])
    expect(library.charFolders).toEqual([{ id: 3, name: '폴더', parentId: null }])
    expect(library.outfits).toEqual([{ id: 7, name: '교복' }])
    expect(library.main).toMatchObject({ prompt: 'main', width: 640, height: 960, steps: 20 })
    expect(library.naiInfo?.tier).toBe('opus')
  })

  it('씬의 그림 수만 바뀌면 어떤 해시도 달라지지 않는다 (그림 저장마다 씬 전체를 다시 올리지 않는다)', () => {
    const a = buildSnapshot(baseSource())
    const more = baseSource()
    more.scenes[0] = { ...more.scenes[0], imageCount: 99 }
    const b = buildSnapshot(more)
    expect(b.scenes.map((x) => x.hash)).toEqual(a.scenes.map((x) => x.hash))
    expect(b.libraryHash).toBe(a.libraryHash)
    expect(JSON.stringify(b.scenes)).not.toContain('imageCount')
  })

  it('프리셋에 들지 않은 프리셋의 씬은 올리지 않는다', () => {
    const src = baseSource()
    src.scenes.push(scene({ id: 77, presetId: 555 }))
    const snap = buildSnapshot(src)
    expect(snap.scenes.flatMap((b) => b.scenes.map((s) => s.id))).not.toContain(77)
  })

  it('같은 입력이면 해시가 같고, 바뀐 부분의 해시만 달라진다', () => {
    const a = buildSnapshot(baseSource())
    const b = buildSnapshot(baseSource())
    expect(b.libraryHash).toBe(a.libraryHash)
    expect(b.fragments.hash).toBe(a.fragments.hash)
    expect(b.scenes.map((x) => x.hash)).toEqual(a.scenes.map((x) => x.hash))

    // 첫 프리셋의 씬 하나만 바꾼다 — 그 프리셋 해시만 달라진다
    const srcScene = baseSource()
    srcScene.scenes[0] = { ...srcScene.scenes[0], prompt: '바뀐 프롬프트' }
    const c = buildSnapshot(srcScene)
    expect(c.scenes[0].hash).not.toBe(a.scenes[0].hash)
    expect(c.scenes[1].hash).toBe(a.scenes[1].hash)
    expect(c.scenes[2].hash).toBe(a.scenes[2].hash)
    expect(c.libraryHash).toBe(a.libraryHash)

    // 캐릭터를 켜면 라이브러리 해시만
    const srcChar = baseSource()
    srcChar.characters[1] = { ...srcChar.characters[1], enabled: true }
    const d = buildSnapshot(srcChar)
    expect(d.libraryHash).not.toBe(a.libraryHash)
    expect(d.scenes.map((x) => x.hash)).toEqual(a.scenes.map((x) => x.hash))

    // 조각을 고치면 조각 해시만
    const srcFrag = baseSource()
    srcFrag.fragments = [{ ...srcFrag.fragments[0], content: 'other' }]
    const e = buildSnapshot(srcFrag)
    expect(e.fragments.hash).not.toBe(a.fragments.hash)
    expect(e.libraryHash).toBe(a.libraryHash)
  })

  it('조각 표는 고정된 키 규칙으로 만들어진다', () => {
    expect(buildSnapshot(baseSource()).fragments.byPath).toEqual({
      casual: ['t-shirt', 'hoodie'],
      '의상/casual': ['t-shirt', 'hoodie']
    })
  })
})

describe('summarizeQueue', () => {
  it('상태별 개수와 지금 생성 중인 씬', () => {
    const status: QueueStatusLite = {
      running: true,
      delayMs: 600,
      items: [
        { id: 'a', state: 'done' },
        { id: 'b', state: 'failed' },
        { id: 'c', state: 'cancelled' },
        { id: 'd', state: 'generating', sceneId: 12 },
        { id: 'e', state: 'pending', sceneId: 12 },
        { id: 'f', state: 'pending' }
      ]
    }
    expect(summarizeQueue(status, 1234)).toEqual({
      running: true,
      pending: 2,
      generating: 1,
      done: 1,
      failed: 1,
      generatingSceneId: 12,
      updatedAt: 1234
    })
    expect(
      summarizeQueue({ items: [], running: false, delayMs: 0 }, 1).generatingSceneId
    ).toBeNull()
  })
})

describe('buildSnapshot — 잔액 조회로 받은 계정 정보', () => {
  const info = {
    tier: 'opus',
    anlas: 4321,
    opusUsage: { percent: 73, isNegative: false, timeUntilNextPercent: 600 },
    updatedAt: 1_700_000_000_000
  }

  it('받은 계정 정보가 있으면 그대로(시각 포함) 싣고, 없으면 설정의 등급만 싣는다', () => {
    expect(buildSnapshot(baseSource(), info).library.naiInfo).toEqual(info)
    expect(buildSnapshot(baseSource(), null).library.naiInfo).toEqual({
      tier: 'opus',
      anlas: null,
      opusUsage: null,
      updatedAt: 0
    })
    expect(buildSnapshot(baseSource()).library.naiInfo?.updatedAt).toBe(0)
  })

  it('받은 정보의 등급이 비어 있으면 설정의 등급으로 채운다', () => {
    const lib = buildSnapshot(baseSource(), { ...info, tier: null }).library
    expect(lib.naiInfo?.tier).toBe('opus')
    expect(lib.naiInfo?.anlas).toBe(4321)
  })

  it('라이브러리 해시는 계정 정보가 바뀔 때만 달라진다', () => {
    const a = buildSnapshot(baseSource(), info)
    expect(buildSnapshot(baseSource(), { ...info }).libraryHash).toBe(a.libraryHash)
    expect(
      buildSnapshot(baseSource(), { ...info, updatedAt: info.updatedAt + 1 }).libraryHash
    ).not.toBe(a.libraryHash)
    expect(buildSnapshot(baseSource(), { ...info, anlas: 1 }).libraryHash).not.toBe(a.libraryHash)
    // 씬 해시는 영향이 없다
    expect(buildSnapshot(baseSource(), { ...info, anlas: 1 }).scenes.map((x) => x.hash)).toEqual(
      a.scenes.map((x) => x.hash)
    )
  })
})
