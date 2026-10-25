import type { ExposeNote } from '@shared/types'
import { detectGarments, exposePreview } from '@shared/auto-expose'

/**
 * 입은 옷 자동 젖힘의 화면용 도우미 (커스텀).
 *
 * 계산은 shared 의 expose-state 가 하고 결과 메모(ExposeNote)가 요청에 실려 온다.
 * 여기서는 그 메모를 화면에 보이기 좋게 이름 붙이고 묶기만 한다 — 판정은 다시 하지 않는다.
 * 붙은 태그와 안 붙은 이유는 늘 보여야 한다(「몰래 붙이기」 금지).
 */

export type NoteStatus = ExposeNote['status']
export type NoteArea = ExposeNote['area']
export type NoteTone = 'ok' | 'info' | 'warn' | 'danger' | 'mute'

export interface StatusMeta {
  label: string
  tone: NoteTone
  hint: string
}

/** 상태 이름 · 색 · 설명 (Record 라서 상태가 늘면 여기서 컴파일 오류로 알려 준다) */
export const STATUS_META: Record<NoteStatus, StatusMeta> = {
  added: { label: '붙음', tone: 'ok', hint: '이 장면에서 자동으로 붙은 젖힘 태그' },
  already: {
    label: '이미 있음',
    tone: 'info',
    hint: '그 부위가 이미 젖혀진 글(clothing aside·breasts out 등)이 카드나 씬에 있어 더 붙이지 않음'
  },
  piece: {
    label: '조각이 맡음',
    tone: 'info',
    hint: '복장의 nsfw 조각이 같은 부위를 맡고 있어 건너뜀'
  },
  nude: {
    label: '알몸',
    tone: 'mute',
    hint: '알몸(옷 벗기기·nude·topless·bottomless)이라 젖힐 옷이 없음'
  },
  'over-clothes': { label: '옷 위', tone: 'mute', hint: '옷 위로 하는 장면이라 붙이지 않음' },
  'off-frame': {
    label: '화면 밖',
    tone: 'mute',
    hint: '그 부위가 화면 밖(out of frame·얼굴만 나오는 자리)이라 붙이지 않음'
  },
  negated: {
    label: '부정문',
    tone: 'mute',
    hint: '「not shown」「no sex」「covering」처럼 가리거나 부정하는 글이라 붙이지 않음'
  },
  after: {
    label: '섹스 뒤',
    tone: 'mute',
    hint: '「after sex」 같은 사후 어구라 약한 신호를 무시함'
  },
  'no-garment': {
    label: '옷 못 읽음',
    tone: 'warn',
    hint: '그 부위를 가린 옷을 못 읽음 — 태그는 붙이지 않고 제안만 함 (옷 이름을 적거나 제안 태그를 직접 적으면 됨)'
  },
  unknown: {
    label: '판단 못 함',
    tone: 'warn',
    hint: '누구 몸인지, 무슨 뜻인지 정할 수 없어 켜지도 닫지도 않음'
  },
  conflict: {
    label: '충돌',
    tone: 'danger',
    hint: '알몸(씬의 옷 벗기기 둘 다·남캐만·여캐만)인데 같은 캐릭터에 옷을 입은 모습을 가리키는 태그가 있음 — 자동으로 고치지 않고 표시만 함 · 입은 채로 두려면 씬의 「옷 벗기기」를 「안 벗김」으로 바꾸세요'
  },
  vetoed: {
    label: '막음',
    tone: 'info',
    hint: '사용자가 막음 — 음수 가중치(-1::skirt lift::), 이 씬의 자동 젖힘 끔, 조각 끔'
  },
  'not-needed': {
    label: '근거 없음',
    tone: 'mute',
    hint: '읽을 수 있는 행위·문장에서 이 부위를 드러내라는 근거를 못 찾음'
  }
}

/** 옷 글이 아예 없어 젖힐 옷이 없는 경우 — 「옷 못 읽음」 경고가 아니라 조용한 상태 (경고 피로를 막는다) */
export const QUIET_NO_GARMENT: StatusMeta = {
  label: '옷 글 없음',
  tone: 'mute',
  hint: '카드·복장에 입은 옷이 적혀 있지 않아 젖힐 옷이 없음 — 옷 이름을 적으면 읽습니다'
}

/** 「옷 못 읽음」 가운데 옷 글 자체가 없는 것 (제안 태그도 읽은 옷도 없다) */
export const isQuietNote = (n: ExposeNote): boolean =>
  n.status === 'no-garment' && n.garments.length === 0 && n.tags.length === 0

/** 메모의 이름표 정보 — 조용한 「옷 글 없음」은 따로 */
export const noteMeta = (n: ExposeNote): StatusMeta =>
  isQuietNote(n) ? QUIET_NO_GARMENT : STATUS_META[n.status]

export const AREA_LABEL: Record<NoteArea, string> = { lower: '아래', chest: '가슴' }

/** 메모의 tags 가 무엇인지 — 붙음 말고는 「붙지 않은」 태그라서 이름을 달아 보인다 */
export const TAG_ROLE: Partial<Record<NoteStatus, string>> = {
  already: '있는 태그',
  piece: '맡은 태그',
  vetoed: '막힌 태그',
  'no-garment': '제안',
  conflict: '충돌 태그',
  nude: '알몸 태그'
}

/** 요약·정렬에 쓰는 상태 순서 — 사용자가 봐야 할 것부터 */
const STATUS_ORDER: NoteStatus[] = [
  'added',
  'conflict',
  'unknown',
  'no-garment',
  'vetoed',
  'piece',
  'already',
  'nude',
  'over-clothes',
  'off-frame',
  'negated',
  'after',
  'not-needed'
]

/** 눈여겨봐야 하는 상태 — 배지로 따로 알린다 (옷 글이 없는 조용한 「옷 못 읽음」은 뺀다) */
export const ATTENTION: ReadonlySet<NoteStatus> = new Set(['conflict', 'unknown', 'no-garment'])
export const isAttention = (n: ExposeNote): boolean => ATTENTION.has(n.status) && !isQuietNote(n)

const AREA_ORDER: Record<NoteArea, number> = { lower: 0, chest: 1 }

/** 실제로 붙은 태그 (중복 없이, 나온 순서대로) */
export function attachedTags(notes: readonly ExposeNote[]): string[] {
  return [...new Set(notes.filter((n) => n.status === 'added').flatMap((n) => n.tags))]
}

/** 한 캐릭터(카드)의 메모 — 여러 자리에 앉았으면 자리 것을 모두 */
export function notesOfChar(
  notes: readonly ExposeNote[] | undefined,
  charId: number
): ExposeNote[] {
  return (notes ?? []).filter((n) => n.charId === charId)
}

export interface CharNotes {
  charIndex: number
  charId: number | null
  name: string
  notes: ExposeNote[]
}

/** 그림에 나오는 순서(charIndex)대로 캐릭터를 묶고, 캐릭터 안에서는 아래 → 가슴 */
export function groupByChar(notes: readonly ExposeNote[]): CharNotes[] {
  const byIndex = new Map<number, CharNotes>()
  for (const n of notes) {
    const group = byIndex.get(n.charIndex) ?? {
      charIndex: n.charIndex,
      charId: n.charId,
      name: n.name,
      notes: []
    }
    group.notes.push(n)
    byIndex.set(n.charIndex, group)
  }
  return [...byIndex.values()]
    .sort((a, b) => a.charIndex - b.charIndex)
    .map((g) => ({
      ...g,
      notes: [...g.notes].sort((a, b) => AREA_ORDER[a.area] - AREA_ORDER[b.area])
    }))
}

/** 요약에서 세는 상태 — 옷 글이 없는 조용한 「옷 못 읽음」은 「근거 없음」 쪽으로 센다 */
const countedStatus = (n: ExposeNote): NoteStatus => (isQuietNote(n) ? 'not-needed' : n.status)

/**
 * 상태별 개수 — 붙음은 캐릭터마다 붙은 태그 수의 합(캐릭터 배지의 「자동 +N」과 맞는다),
 * 나머지는 그 상태가 있는 캐릭터 수 (부위가 둘이어도 한 명으로 센다)
 */
export function statusCounts(
  notes: readonly ExposeNote[]
): { status: NoteStatus; count: number }[] {
  const chars = new Map<NoteStatus, Set<number>>()
  const perChar = new Map<number, ExposeNote[]>()
  for (const n of notes) {
    const list = perChar.get(n.charIndex) ?? []
    list.push(n)
    perChar.set(n.charIndex, list)
  }
  let added = 0
  for (const list of perChar.values()) added += attachedTags(list).length
  for (const n of notes) {
    const status = countedStatus(n)
    if (status === 'added') continue
    const set = chars.get(status) ?? new Set<number>()
    set.add(n.charIndex)
    chars.set(status, set)
  }
  const counts = new Map<NoteStatus, number>()
  if (added) counts.set('added', added)
  for (const [status, set] of chars) counts.set(status, set.size)
  return STATUS_ORDER.filter((s) => counts.has(s)).map((status) => ({
    status,
    count: counts.get(status) ?? 0
  }))
}

/** 개수에 붙는 단위 — 붙음은 태그 개수, 나머지는 캐릭터 수 */
export const countUnit = (status: NoteStatus): string => (status === 'added' ? '개' : '명')

/** 「붙음 3개」 · 「충돌 1명」 */
export const countLabel = (c: { status: NoteStatus; count: number }): string =>
  `${STATUS_META[c.status].label} ${c.count}${countUnit(c.status)}`

/** 한 줄 요약 — 「붙음 3개 · 충돌 1명」. 「근거 없음」은 소음이라 뺀다 */
export function summaryText(notes: readonly ExposeNote[]): string {
  return statusCounts(notes)
    .filter((c) => c.status !== 'not-needed')
    .map(countLabel)
    .join(' · ')
}

/**
 * 줄에 보일 이유 — 앞의 「아래: 」「가슴: 」은 부위 칸과 겹쳐 떼고, 붙은 태그를 되풀이할 뿐인
 * 「skirt lift 붙임」은 비운다 (태그 칩이 이미 말한다). 막힌 태그 같은 덧붙임이 있으면 남긴다.
 * 「근거 없음」은 이름표가 이미 말하니 이유를 비운다.
 */
export function displayReason(n: ExposeNote): string {
  if (n.status === 'not-needed') return ''
  const text = n.reason.replace(/^(아래|가슴): /, '').trim()
  if (n.status === 'added' && text === `${n.tags.join(', ')} 붙임`) return ''
  return text
}

/** 메모 한 줄 — 호버 글에 쓴다. 「아래 · 붙음 +shorts pull (옷 shorts · 근거 sex) — 이유」 */
export function noteLine(n: ExposeNote): string {
  const role = TAG_ROLE[n.status]
  const facts = [
    // 붙지 않은 태그는 무엇인지 이름을 달아 (있는 태그·맡은 태그·막힌 태그·제안)
    role && n.tags.length ? `${role} ${n.tags.join(', ')}` : '',
    n.garments.length ? `옷 ${n.garments.join(', ')}` : '',
    n.evidence.length ? `근거 ${n.evidence.join(', ')}` : ''
  ].filter(Boolean)
  return [
    `${AREA_LABEL[n.area]} · ${noteMeta(n).label}`,
    n.status === 'added' && n.tags.length ? ` +${n.tags.join(', ')}` : '',
    facts.length ? ` (${facts.join(' · ')})` : '',
    displayReason(n) ? ` — ${displayReason(n)}` : ''
  ].join('')
}

/** 화면에 한 줄로 보일 메모 묶음 — 부위가 달라도 같은 말이면 한 줄 (알몸 아래·가슴 → 「아래 · 가슴 알몸」) */
export interface NoteRow {
  areas: NoteArea[]
  /** 대표 메모 (첫 부위) */
  note: ExposeNote
  /** 묶인 메모 전부 */
  members: ExposeNote[]
  /** 모든 부위의 근거를 합친 것 (중복 없이, 3개까지) */
  evidence: string[]
}

const rowKey = (n: ExposeNote): string =>
  [
    isQuietNote(n) ? 'quiet' : n.status,
    n.tags.join('|'),
    n.garments.join('|'),
    displayReason(n)
  ].join('\u0000')

/**
 * 메모를 줄로 묶는다 — 같은 상태·태그·옷·이유면 부위를 합쳐 한 줄 (같은 정보를 부위마다 되풀이하지 않는다).
 * 줄 순서는 사용자가 봐야 할 상태부터, 같은 상태끼리는 아래 → 가슴.
 */
export function mergeRows(notes: readonly ExposeNote[]): NoteRow[] {
  const rows = new Map<string, NoteRow>()
  const ordered = [...notes].sort((a, b) => AREA_ORDER[a.area] - AREA_ORDER[b.area])
  for (const n of ordered) {
    const key = rowKey(n)
    const row = rows.get(key)
    if (row) {
      if (!row.areas.includes(n.area)) row.areas.push(n.area)
      row.members.push(n)
      for (const e of n.evidence)
        if (!row.evidence.includes(e) && row.evidence.length < 3) row.evidence.push(e)
    } else {
      rows.set(key, {
        areas: [n.area],
        note: n,
        members: [n],
        evidence: n.evidence.slice(0, 3)
      })
    }
  }
  const rank = (r: NoteRow): number => STATUS_ORDER.indexOf(countedStatus(r.note))
  return [...rows.values()].sort(
    (a, b) => rank(a) - rank(b) || AREA_ORDER[a.areas[0]] - AREA_ORDER[b.areas[0]]
  )
}

/** 캐릭터 줄 배지 — 「자동 +N」과 눈여겨볼 상태, 호버 글 */
export interface CharBadge {
  /** 붙은 태그 수 */
  added: number
  /** 눈여겨볼 상태 (충돌·판단 못 함·옷 못 읽음)와 그 부위 */
  attention: { status: NoteStatus; areas: NoteArea[] }[]
  /** 호버 글 — 「근거 없음」을 뺀 모든 메모를 한 줄씩 */
  title: string
}

export function charBadge(notes: readonly ExposeNote[]): CharBadge {
  const attention = STATUS_ORDER.filter((s) => ATTENTION.has(s)).flatMap((status) => {
    const areas = notes
      .filter((n) => n.status === status && isAttention(n))
      .map((n) => n.area)
      .sort((a, b) => AREA_ORDER[a] - AREA_ORDER[b])
    return areas.length ? [{ status, areas: [...new Set(areas)] }] : []
  })
  const lines = [...notes]
    .sort((a, b) => AREA_ORDER[a.area] - AREA_ORDER[b.area])
    .filter((n) => n.status !== 'not-needed')
    .map(noteLine)
  return {
    added: attachedTags(notes).length,
    attention,
    title: lines.length ? ['입은 옷 자동 젖힘', ...lines].join('\n') : ''
  }
}

/** 읽은 옷 이름 (중복 없이) */
export function garmentsOf(notes: readonly ExposeNote[]): string[] {
  return [...new Set(notes.flatMap((n) => n.garments))]
}

/**
 * 메모에서 본 「이 부위를 드러내야 하는 장면」 — 복장 선택의 nsfw 조각 「자동」 표시가 생성과 같은 판정을 따르게 한다.
 * 드러내야 하는 부위는 알몸·조각·이미 젖힘·막음·옷 못 읽음·붙음 가운데 하나로 남는다
 * (이 씬에서 자동 젖힘을 껐으면 아무것도 켜지지 않는다 — autoOn=false).
 */
const NEEDED_STATUS: ReadonlySet<NoteStatus> = new Set([
  'added',
  'piece',
  'nude',
  'already',
  'no-garment',
  'vetoed'
])
export function autoAreasFromNotes(
  notes: readonly ExposeNote[],
  autoOn: boolean
): { lower: boolean; chest: boolean } {
  if (!autoOn) return { lower: false, chest: false }
  // 알몸 선언 때문에 복장의 nsfw 조각이 켜지지 않은 부위(gated)는 저절로 켜지는 부위가 아니다
  const needed = (area: NoteArea): boolean =>
    notes.some((n) => n.area === area && NEEDED_STATUS.has(n.status) && !n.gated)
  return { lower: needed('lower'), chest: needed('chest') }
}

export interface RoundNotes {
  label: string
  notes: ExposeNote[]
}

/** 회차(큐 반복 항목)마다 결과가 같으면 한 묶음으로, 다르면 회차별로 */
export function groupRounds(
  rounds: readonly RoundNotes[]
): { label: string | null; notes: ExposeNote[] }[] {
  if (rounds.length <= 1) return rounds.map((r) => ({ label: null, notes: r.notes }))
  const first = JSON.stringify(rounds[0].notes)
  if (rounds.every((r) => JSON.stringify(r.notes) === first))
    return [{ label: null, notes: rounds[0].notes }]
  return rounds.map((r) => ({ label: r.label, notes: r.notes }))
}

/**
 * 여러 회차의 요약 개수를 한 줄로 — 같은 상태는 가장 큰 값을 쓴다.
 * 첫 회차만 보이면 다른 회차에만 있는 충돌·판단 못 함이 접힌 줄에서 가려진다.
 */
export function mergedCounts(
  groups: readonly { notes: ExposeNote[] }[]
): { status: NoteStatus; count: number }[] {
  const best = new Map<NoteStatus, number>()
  for (const g of groups)
    for (const c of statusCounts(g.notes))
      best.set(c.status, Math.max(best.get(c.status) ?? 0, c.count))
  return STATUS_ORDER.filter((s) => best.has(s) && s !== 'not-needed').map((status) => ({
    status,
    count: best.get(status) ?? 0
  }))
}

/**
 * 카드 글에서 읽은 옷과 젖힘 후보 — 씬을 모를 때(복장 탭·큐 항목)의 대비용.
 * 씬 안에서는 요청에 실린 메모가 진짜 결과이고, 이건 「이 카드는 이렇게 읽힌다」는 안내다.
 */
export function readCardWear(prompt: string): {
  garments: string[]
  lower: string[]
  chest: string[]
} {
  const preview = exposePreview(prompt)
  return {
    garments: detectGarments(prompt).map((g) => g.nouns[0]),
    lower: preview.lower,
    chest: preview.chest
  }
}
