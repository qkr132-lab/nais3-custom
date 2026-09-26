import type { CharRole } from './types'
import type { OutfitChoice, OutfitPiece } from './outfit'

/**
 * 씬 구성 직렬화 (커스텀) — 씬 JSON·캐릭터 백업·전체 백업이 함께 쓴다.
 *
 * 씬별 캐릭터 추가·큐 항목은 캐릭터를 **id**로 가리킨다. 파일로 옮기면 id가 새로 매겨지므로,
 * 파일에는 파일 안에서만 통하는 uid로 적고 가져올 때 새 id로 갈아끼운다.
 *
 * 예전 내보내기는 씬 글자만 담아서, 씬별 캐릭터·위치·자리·자리 태그·씬 태그가 전부 빠졌다.
 * 여기서 한 번에 싣고 한 번에 푼다 — 세 경로가 서로 다른 규칙으로 싣다 어긋나지 않게.
 *
 * DB·파일 입출력 없이 순수 로직만 둔다 (테스트 가능하게).
 */

type Pos = { x: number; y: number }

/** 씬 하나의 캐릭터 구성 — 씬별 캐릭터 추가·큐 항목이 들고 있는 모양 (캐릭터 = id) */
export interface SceneSetup {
  characterIds: number[]
  charRefIds?: number[]
  vibeIds?: number[]
  useCoords?: boolean
  positions?: Record<number, Pos>
  roles?: Record<number, CharRole | null>
  slots?: Pos[]
  /** (구형) 캐릭터 id → 자리 번호 */
  slotOf?: Record<number, number>
  /** 자리 번호 → 캐릭터 id */
  slotChars?: Record<number, number>
  slotRoles?: Record<number, CharRole | null>
  slotTags?: Record<number, string>
  charTags?: Record<number, string>
  /** 캐릭터 id → 이 씬에서 상대(반대 역할)에게 붙일 태그. 있으면 카드에 적힌 것 대신 쓴다 */
  partnerTags?: Record<number, string>
  /** 캐릭터 id → 이 씬에서 입힐 옷. 없으면 카드의 기본 복장 */
  outfits?: Record<number, OutfitChoice>
}

/** 자리 묶음 + 씬 태그 — 파일에 적는 모양 (캐릭터 = 파일 안 uid) */
export interface FileSlotExtras {
  slots?: Pos[]
  /** 자리 번호 → uid */
  slotChars?: Record<string, string>
  slotRoles?: Record<string, CharRole>
  slotTags?: Record<string, string>
  /** uid → 이 씬에서만 얹는 태그 */
  charTags?: Record<string, string>
  /** uid → 이 씬에서 상대에게 붙일 태그 */
  partnerTags?: Record<string, string>
  /** uid → 이 씬에서 입힐 옷 (복장은 파일 안 복장 uid로) */
  outfits?: Record<string, FileOutfitChoice>
}

/** 파일에 적는 옷 선택 — 복장을 id 대신 파일 안 uid로 가리킨다 */
export interface FileOutfitChoice {
  outfit: string
  on?: string[]
  off?: string[]
}

/** 파일에 싣는 복장 */
export interface FileOutfit {
  uid: string
  name: string
  pieces: OutfitPiece[]
}

/** 씬 하나의 구성 — 파일에 적는 모양 */
export interface FileSetup extends FileSlotExtras {
  characters: string[]
  useCoords?: boolean
  positions?: Record<string, Pos>
  roles?: Record<string, CharRole>
}

const isRole = (v: unknown): v is CharRole => v === 'source' || v === 'target'
const isPos = (v: unknown): v is Pos =>
  !!v &&
  typeof (v as Pos).x === 'number' &&
  typeof (v as Pos).y === 'number' &&
  Number.isFinite((v as Pos).x) &&
  Number.isFinite((v as Pos).y)

/** 빈 맵은 빼서 파일을 짧게 둔다 */
function nonEmpty<T extends object>(o: T): T | undefined {
  return Object.keys(o).length > 0 ? o : undefined
}

/**
 * 자리 묶음·씬 태그를 파일 모양으로.
 *
 * 자리 → 캐릭터는 새 방식(slotChars)이 먼저고, 구형(slotOf)은 아직 빈 자리에 한해,
 * 그 캐릭터가 다른 자리에 앉아 있지 않을 때만 옮긴다 — seatSlots와 같은 우선순위라
 * 파일로 옮긴 뒤에도 앉는 자리가 바뀌지 않는다. 구형 배정은 파일에서 새 방식으로 정리된다.
 */
export function encodeSlotExtras(
  setup: Omit<SceneSetup, 'characterIds'>,
  uidOf: (id: number) => string | undefined,
  outfitUidOf: (id: number) => string | undefined = () => undefined
): FileSlotExtras {
  const count = setup.slots?.length ?? 0
  const out: FileSlotExtras = {}
  if (count) out.slots = setup.slots!.map((p) => ({ x: p.x, y: p.y }))

  const seats: Record<string, string> = {}
  for (const [at, id] of Object.entries(setup.slotChars ?? {})) {
    const i = Number(at)
    const uid = uidOf(id)
    if (i >= 0 && i < count && uid) seats[i] = uid
  }
  for (const [id, at] of Object.entries(setup.slotOf ?? {})) {
    const uid = uidOf(Number(id))
    if (!uid || at < 0 || at >= count || seats[at] !== undefined) continue
    if (Object.values(seats).includes(uid)) continue
    seats[at] = uid
  }
  const slotChars = nonEmpty(seats)
  if (slotChars) out.slotChars = slotChars

  const roles: Record<string, CharRole> = {}
  for (const [at, role] of Object.entries(setup.slotRoles ?? {})) {
    if (Number(at) < count && isRole(role)) roles[at] = role
  }
  const slotRoles = nonEmpty(roles)
  if (slotRoles) out.slotRoles = slotRoles

  const tags: Record<string, string> = {}
  for (const [at, text] of Object.entries(setup.slotTags ?? {})) {
    if (Number(at) < count && typeof text === 'string' && text.trim()) tags[at] = text
  }
  const slotTags = nonEmpty(tags)
  if (slotTags) out.slotTags = slotTags

  const ct: Record<string, string> = {}
  for (const [id, text] of Object.entries(setup.charTags ?? {})) {
    const uid = uidOf(Number(id))
    if (uid && typeof text === 'string' && text.trim()) ct[uid] = text
  }
  const charTags = nonEmpty(ct)
  if (charTags) out.charTags = charTags

  const pt: Record<string, string> = {}
  for (const [id, text] of Object.entries(setup.partnerTags ?? {})) {
    const uid = uidOf(Number(id))
    if (uid && typeof text === 'string' && text.trim()) pt[uid] = text
  }
  const partnerTags = nonEmpty(pt)
  if (partnerTags) out.partnerTags = partnerTags

  const oc: Record<string, FileOutfitChoice> = {}
  for (const [id, choice] of Object.entries(setup.outfits ?? {})) {
    const uid = uidOf(Number(id))
    const outfit = choice ? outfitUidOf(choice.outfitId) : undefined
    if (!uid || !outfit) continue
    oc[uid] = {
      outfit,
      ...(choice.on?.length ? { on: [...choice.on] } : {}),
      ...(choice.off?.length ? { off: [...choice.off] } : {})
    }
  }
  const outfits = nonEmpty(oc)
  if (outfits) out.outfits = outfits

  return out
}

/**
 * 파일의 자리 묶음·씬 태그를 id 모양으로. 못 찾는 uid는 그 항목만 버리고 센다.
 */
export function decodeSlotExtras(
  file: FileSlotExtras,
  idOf: (uid: string) => number | undefined,
  outfitIdOf: (uid: string) => number | undefined = () => undefined
): { extras: Omit<SceneSetup, 'characterIds'>; dropped: number } {
  let dropped = 0
  const extras: Omit<SceneSetup, 'characterIds'> = {}
  const slots = Array.isArray(file.slots) ? file.slots.filter(isPos) : []
  const count = slots.length
  if (count) extras.slots = slots.map((p) => ({ x: p.x, y: p.y }))

  const slotChars: Record<number, number> = {}
  for (const [at, uid] of Object.entries(file.slotChars ?? {})) {
    const i = Number(at)
    if (!(i >= 0 && i < count)) continue
    const id = idOf(uid)
    if (id === undefined) dropped++
    else slotChars[i] = id
  }
  if (Object.keys(slotChars).length) extras.slotChars = slotChars

  const slotRoles: Record<number, CharRole> = {}
  for (const [at, role] of Object.entries(file.slotRoles ?? {})) {
    if (Number(at) < count && isRole(role)) slotRoles[Number(at)] = role
  }
  if (Object.keys(slotRoles).length) extras.slotRoles = slotRoles

  const slotTags: Record<number, string> = {}
  for (const [at, text] of Object.entries(file.slotTags ?? {})) {
    if (Number(at) < count && typeof text === 'string' && text.trim()) slotTags[Number(at)] = text
  }
  if (Object.keys(slotTags).length) extras.slotTags = slotTags

  const charTags: Record<number, string> = {}
  for (const [uid, text] of Object.entries(file.charTags ?? {})) {
    if (typeof text !== 'string' || !text.trim()) continue
    const id = idOf(uid)
    if (id === undefined) dropped++
    else charTags[id] = text
  }
  if (Object.keys(charTags).length) extras.charTags = charTags

  const partnerTags: Record<number, string> = {}
  for (const [uid, text] of Object.entries(file.partnerTags ?? {})) {
    if (typeof text !== 'string' || !text.trim()) continue
    const id = idOf(uid)
    if (id === undefined) dropped++
    else partnerTags[id] = text
  }
  if (Object.keys(partnerTags).length) extras.partnerTags = partnerTags

  const strs = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length ? v.filter((x): x is string => typeof x === 'string') : undefined
  const outfits: Record<number, OutfitChoice> = {}
  for (const [uid, fc] of Object.entries(file.outfits ?? {})) {
    if (!fc || typeof fc.outfit !== 'string') continue
    const id = idOf(uid)
    const outfitId = outfitIdOf(fc.outfit)
    if (id === undefined || outfitId === undefined) {
      dropped++
      continue
    }
    const on = strs(fc.on)
    const off = strs(fc.off)
    outfits[id] = { outfitId, ...(on ? { on } : {}), ...(off ? { off } : {}) }
  }
  if (Object.keys(outfits).length) extras.outfits = outfits

  return { extras, dropped }
}

/** 이 구성이 가리키는 캐릭터 id 전부 — 파일에 카드를 실을 대상 */
export function setupCharacterIds(setup: SceneSetup): number[] {
  const ids = new Set<number>(setup.characterIds ?? [])
  const count = setup.slots?.length ?? 0
  for (const [at, id] of Object.entries(setup.slotChars ?? {})) if (Number(at) < count) ids.add(id)
  for (const [id, at] of Object.entries(setup.slotOf ?? {})) if (at < count) ids.add(Number(id))
  return [...ids]
}

/** 이 구성이 입히는 복장 id 전부 — 파일에 복장을 실을 대상 */
export function setupOutfitIds(setup: SceneSetup): number[] {
  return [...new Set(Object.values(setup.outfits ?? {}).map((c) => c.outfitId))]
}

/** 씬 구성 전체를 파일 모양으로 */
export function encodeSetup(
  setup: SceneSetup,
  uidOf: (id: number) => string | undefined,
  outfitUidOf: (id: number) => string | undefined = () => undefined
): FileSetup {
  const characters = setupCharacterIds(setup)
    .map(uidOf)
    .filter((u): u is string => !!u)
  const out: FileSetup = { characters }
  if (setup.useCoords !== undefined) out.useCoords = setup.useCoords

  const positions: Record<string, Pos> = {}
  for (const [id, p] of Object.entries(setup.positions ?? {})) {
    const uid = uidOf(Number(id))
    if (uid && isPos(p)) positions[uid] = { x: p.x, y: p.y }
  }
  if (Object.keys(positions).length) out.positions = positions

  const roles: Record<string, CharRole> = {}
  for (const [id, role] of Object.entries(setup.roles ?? {})) {
    const uid = uidOf(Number(id))
    if (uid && isRole(role)) roles[uid] = role
  }
  if (Object.keys(roles).length) out.roles = roles

  return { ...out, ...encodeSlotExtras(setup, uidOf, outfitUidOf) }
}

/** 파일의 씬 구성을 id 모양으로. 바이브·캐릭레퍼 연결은 파일에 없으므로 빈 채로 둔다 */
export function decodeSetup(
  file: FileSetup,
  idOf: (uid: string) => number | undefined,
  outfitIdOf: (uid: string) => number | undefined = () => undefined
): { setup: SceneSetup; dropped: number } {
  let dropped = 0
  const characterIds: number[] = []
  for (const uid of Array.isArray(file.characters) ? file.characters : []) {
    const id = idOf(uid)
    if (id === undefined) dropped++
    else if (!characterIds.includes(id)) characterIds.push(id)
  }
  const setup: SceneSetup = { characterIds, charRefIds: [], vibeIds: [] }
  if (typeof file.useCoords === 'boolean') setup.useCoords = file.useCoords

  const positions: Record<number, Pos> = {}
  for (const [uid, p] of Object.entries(file.positions ?? {})) {
    const id = idOf(uid)
    if (id !== undefined && isPos(p)) positions[id] = { x: p.x, y: p.y }
  }
  if (Object.keys(positions).length) setup.positions = positions

  const roles: Record<number, CharRole> = {}
  for (const [uid, role] of Object.entries(file.roles ?? {})) {
    const id = idOf(uid)
    if (id !== undefined && isRole(role)) roles[id] = role
  }
  if (Object.keys(roles).length) setup.roles = roles

  const slot = decodeSlotExtras(file, idOf, outfitIdOf)
  return { setup: { ...setup, ...slot.extras }, dropped: dropped + slot.dropped }
}

/**
 * 공용 카드(내보낼 때 캐릭터 창에서 켜져 있던 것)를 씬 구성에 붙인다.
 * 씬에서 고른 캐릭터 뒤에 붙여 생성 순서가 원래와 같게 한다.
 */
export function withShared(setup: SceneSetup, sharedIds: number[]): SceneSetup {
  const characterIds = [...setup.characterIds]
  for (const id of sharedIds) if (!characterIds.includes(id)) characterIds.push(id)
  return { ...setup, characterIds }
}

/** 파일에 실을 만한 내용이 있는지 — 캐릭터도 자리도 없으면 빈 구성 */
export function setupHasContent(setup: SceneSetup | undefined | null): boolean {
  return !!setup && ((setup.characterIds?.length ?? 0) > 0 || (setup.slots?.length ?? 0) > 0)
}

// ── 휴지통 정리 ─────────────────────────────────────────────────────────

/** settings의 scene_extras 모양 */
export interface SceneExtrasFile {
  sequenceEnabled?: boolean
  entries?: (SceneSetup & { id: string; name: string; enabled: boolean })[]
  additionsEnabled?: boolean
  additions?: Record<string, Record<string, SceneSetup>>
}

/** 지워진 캐릭터를 가리키는 항목을 구성에서 걷어낸다 */
export function stripDeadCharacters<T extends SceneSetup>(setup: T, alive: (id: number) => boolean): T {
  const keep = <V>(map: Record<number, V> | undefined): Record<number, V> | undefined => {
    if (!map) return map
    const out: Record<number, V> = {}
    for (const [id, v] of Object.entries(map)) if (alive(Number(id))) out[Number(id)] = v
    return out
  }
  const seats = setup.slotChars
    ? Object.fromEntries(Object.entries(setup.slotChars).filter(([, id]) => alive(id)))
    : setup.slotChars
  return {
    ...setup,
    characterIds: (setup.characterIds ?? []).filter(alive),
    positions: keep(setup.positions),
    roles: keep(setup.roles),
    slotOf: keep(setup.slotOf),
    charTags: keep(setup.charTags),
    partnerTags: keep(setup.partnerTags),
    outfits: keep(setup.outfits),
    slotChars: seats
  }
}

/**
 * 백업에 싣기 전에 휴지통에 든 씬·캐릭터의 흔적을 지운다.
 *
 * 씬을 지워도 씬별 캐릭터 추가 설정은 씬 id로 남아 있고, 캐릭터를 폴더째 지우면 참조가
 * 남을 수 있다. 그대로 실으면 "지운 게 백업에 같이 들어간다"가 된다.
 */
export function pruneSceneExtras(
  extras: SceneExtrasFile,
  isLiveScene: (sceneId: number) => boolean,
  isLiveCharacter: (id: number) => boolean
): SceneExtrasFile {
  const additions: Record<string, Record<string, SceneSetup>> = {}
  for (const [presetId, scenes] of Object.entries(extras.additions ?? {})) {
    const kept: Record<string, SceneSetup> = {}
    for (const [sceneId, setup] of Object.entries(scenes ?? {})) {
      if (!isLiveScene(Number(sceneId))) continue
      kept[sceneId] = stripDeadCharacters(setup, isLiveCharacter)
    }
    additions[presetId] = kept
  }
  return {
    ...extras,
    additions,
    entries: (extras.entries ?? []).map((e) => stripDeadCharacters(e, isLiveCharacter))
  }
}

// ── 씬 JSON v2 ──────────────────────────────────────────────────────────

/** 씬 JSON에 실리는 캐릭터 카드 */
export interface FileCharacter {
  uid: string
  name: string
  prompt: string
  negativePrompt: string
  role?: CharRole | null
  /** 카드 자리 번호 — 씬의 N번 자리로 자동 배정 */
  slotNo?: number | null
  /** 상대(반대 역할)에게 붙일 태그 */
  partnerTags?: string
  /** 기본 복장 (파일 안 복장 uid) */
  outfit?: string
}

/** 씬 JSON v2 — 씬 글자 + 그 씬의 캐릭터 구성 전부 */
export interface SceneBundle {
  version: 2
  /** 가져올 때 카드를 담을 폴더 이름 */
  characterFolder?: string
  characters: FileCharacter[]
  /**
   * 모든 씬에 함께 들어가는 카드 (uid) — 내보낼 때 캐릭터 창에서 켜져 있던 카드.
   * 씬마다 남자만 씬별 추가로 넣고 여자는 캐릭터 창에서 켜두는 식으로 짜면, 씬 설정만으로는
   * 여자가 파일에서 빠져 가져간 쪽의 당하는쪽 자리가 비어버린다. 가져올 때 모든 씬에 붙인다.
   */
  shared?: string[]
  /** 이 파일의 카드·씬이 입는 복장 */
  outfits?: FileOutfit[]
  scenes: (Record<string, unknown> & {
    name: string
    sourcePos?: Pos | null
    targetPos?: Pos | null
    /** 씬별 캐릭터 추가 — 없으면 캐릭터 없이 씬만 */
    setup?: FileSetup
  })[]
}

export function isSceneBundle(data: unknown): data is SceneBundle {
  return (
    !!data &&
    typeof data === 'object' &&
    (data as { version?: unknown }).version === 2 &&
    Array.isArray((data as { characters?: unknown }).characters) &&
    Array.isArray((data as { scenes?: unknown }).scenes)
  )
}

export { isPos }
