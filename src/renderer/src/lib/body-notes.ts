import { readBody } from '@shared/body'
import type { BodyNote, ExposeNote } from '@shared/types'
import type { NoteTone } from './expose-notes'

/**
 * 몸·후타 자동 재조립의 화면용 도우미 (커스텀).
 *
 * 바꾸고 붙이는 계산은 shared 쪽이 하고, 결과 메모(BodyNote)가 요청에 실려 온다.
 * 여기서는 그 메모를 화면에 보이기 좋게 이름 붙이고 묶기만 한다 — 판정은 다시 하지 않는다.
 * 바꾼 것·붙인 것·안 바꾼 것은 늘 보여야 한다(「몰래 바꾸기」 금지).
 */

export type BodyKind = BodyNote['kind']
export type BodyWhere = BodyNote['where']

export interface KindMeta {
  label: string
  tone: NoteTone
  hint: string
}

/** 종류 이름 · 색 · 설명 (Record 라서 종류가 늘면 여기서 컴파일 오류로 알려 준다) */
export const KIND_META: Record<BodyKind, KindMeta> = {
  replaced: {
    label: '바꿈',
    tone: 'ok',
    hint: '후타 구성에 맞지 않는 글을 다른 태그로 바꿔 보냄 · 적어 둔 원본은 그대로'
  },
  removed: {
    label: '뺌',
    tone: 'ok',
    hint: '후타 구성에 맞지 않는 태그를 빼고 보냄 · 적어 둔 원본은 그대로'
  },
  added: {
    label: '더함',
    tone: 'ok',
    hint: '몸에 맞춰 태그를 더해 보냄 · 적어 둔 원본은 그대로'
  },
  kept: {
    label: '안 바꿈',
    tone: 'mute',
    hint: '안전하게 바꿀 수 없어 그대로 보냄 · 필요하면 글을 직접 고치세요'
  },
  unreadable: {
    label: '못 읽음',
    tone: 'warn',
    hint: '조각(<이름>)·랜덤 선택지에 후타가 들어올 수 있는데 미리 읽을 수 없어 판단하지 못함'
  },
  suspect: {
    label: '후타 의심',
    tone: 'warn',
    hint: '여성 카드에 음경 태그만 있어 후타로 보지 않고 바꾸지 않음 · 후타라면 카드에 futanari 를 적으세요'
  },
  conflict: {
    label: '충돌',
    tone: 'danger',
    hint: '카드의 몸 태그끼리 맞지 않아 바꾸지 않고 표시만 함'
  }
}

/** 메모 위치 이름 */
export const WHERE_LABEL: Record<BodyWhere, string> = {
  main: '메인',
  scene: '씬',
  source: '하는쪽 칸',
  target: '당하는쪽 칸',
  slot: '자리',
  char: '캐릭터'
}

/** 사용자가 봐야 할 것부터 — 바뀐 것, 그다음 눈여겨볼 것, 마지막에 그대로 둔 것 */
const KIND_ORDER: BodyKind[] = [
  'replaced',
  'removed',
  'added',
  'conflict',
  'suspect',
  'unreadable',
  'kept'
]

/** 눈여겨봐야 하는 종류 — 배지로 따로 알린다 */
export const BODY_ATTENTION: ReadonlySet<BodyKind> = new Set(['conflict', 'suspect', 'unreadable'])

const WHERE_ORDER: Record<BodyWhere, number> = {
  main: 0,
  scene: 1,
  source: 2,
  target: 3,
  slot: 4,
  char: 5
}

/** 더한 태그가 pink nipples 인가 — 단보루 태그는 아니지만 실측으로 쓰는 고정 규칙이라 요약에서 따로 센다 */
export const isPinkNote = (n: BodyNote): boolean =>
  n.kind === 'added' &&
  (n.after ?? '')
    .split(',')
    // 가중치 묶음(1.2::nude::)의 표기를 걷고 태그 하나씩 견준다
    .some(
      (tag) =>
        tag
          .replace(/-?\d*\.?\d*::/g, '')
          .trim()
          .toLowerCase() === 'pink nipples'
    )

/**
 * 후타 때문에 생긴 메모인가 — 알몸에 더한 pink nipples(여캐도 받는다)와 눈여겨볼 상태(의심·충돌·못 읽음)는 뺀다.
 * 어느 카드가 후타인지는 메모로 짐작하지 않는다 (상대 여캐에도 글을 바꾼 메모가 붙는다) — 요청의 futaPlan 이 알려 준다
 */
export const isFutaNote = (n: BodyNote): boolean => !isPinkNote(n) && !BODY_ATTENTION.has(n.kind)

/**
 * 메모가 가리키는 곳 — 「메인」 「씬」 「합성 카드 A · 하는쪽 칸」.
 * 이름이 같은 카드가 여러 자리에 앉았으면(dup) 몇 번째인지 붙여 가른다
 */
export function placeLabel(n: BodyNote, dup?: ReadonlySet<string>): string {
  const where = WHERE_LABEL[n.where]
  const name = n.name?.trim()
  const who =
    name && dup?.has(name) && n.charIndex != null
      ? `${name} #${n.charIndex + 1}`
      : name || (n.charIndex != null ? `캐릭터 ${n.charIndex + 1}` : '')
  if (!who) return where
  return n.where === 'char' ? who : `${who} · ${where}`
}

/** 이름이 같은데 순서가 다른 캐릭터가 있는 이름들 — 같은 카드가 두 자리에 앉은 경우 */
function duplicateNames(notes: readonly BodyNote[]): Set<string> {
  const seen = new Map<string, Set<number>>()
  for (const n of notes) {
    const name = n.name?.trim()
    if (!name || n.charIndex == null) continue
    const set = seen.get(name) ?? new Set<number>()
    set.add(n.charIndex)
    seen.set(name, set)
  }
  return new Set([...seen].filter(([, set]) => set.size > 1).map(([name]) => name))
}

const sorted = (notes: readonly BodyNote[]): BodyNote[] =>
  [...notes].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      WHERE_ORDER[a.where] - WHERE_ORDER[b.where] ||
      (a.charIndex ?? -1) - (b.charIndex ?? -1)
  )

/** 메모 한 줄 — 호버 글에 쓴다. 「씬 · 바꿈 hetero → futa with female (근거 …) — 이유」 */
export function bodyNoteLine(n: BodyNote): string {
  const change =
    n.kind === 'replaced'
      ? [n.before, n.after].filter(Boolean).join(' → ')
      : n.kind === 'added'
        ? n.after
          ? `+${n.after}`
          : ''
        : (n.before ?? n.after ?? '')
  return [
    `${placeLabel(n)} · ${KIND_META[n.kind].label}`,
    change ? ` ${change}` : '',
    n.evidence ? ` (근거 ${n.evidence})` : '',
    n.reason ? ` — ${n.reason}` : ''
  ].join('')
}

/** 화면에 한 줄로 보일 메모 묶음 — 같은 바뀜이 여러 곳이면 위치만 모아 한 줄 */
export interface BodyRow {
  note: BodyNote
  members: BodyNote[]
  places: string[]
}

const rowKey = (n: BodyNote): string =>
  [n.kind, n.before ?? '', n.after ?? '', n.evidence ?? '', n.reason].join('\u0000')

export function mergeBodyRows(notes: readonly BodyNote[]): BodyRow[] {
  const rows = new Map<string, BodyRow>()
  const dup = duplicateNames(notes)
  for (const n of sorted(notes)) {
    const key = rowKey(n)
    const place = placeLabel(n, dup)
    const row = rows.get(key)
    if (row) {
      row.members.push(n)
      if (!row.places.includes(place)) row.places.push(place)
    } else {
      rows.set(key, { note: n, members: [n], places: [place] })
    }
  }
  return [...rows.values()]
}

/** 요약 한 칸 — 개수 말고도 후타 명수 같은 글자가 들어 있다 */
export interface BodyCount {
  id: 'futa' | 'off' | BodyKind | 'pink'
  label: string
  tone: NoteTone
  /** 접힌 줄에서 색으로 눈에 띄어야 하는가 (바뀐 것·눈여겨볼 것) */
  loud: boolean
}

/** 요약 조각 순서 — 바뀐 것, 눈여겨볼 것, 마지막에 그대로 둔 것 (좁은 줄에서 잘려도 경고가 먼저 보인다) */
const COUNT_ORDER: BodyCount['id'][] = [
  'futa',
  'off',
  'replaced',
  'removed',
  'added',
  'pink',
  'conflict',
  'suspect',
  'unreadable',
  'kept'
]

/**
 * 한 줄 요약 조각들 — 「후타 1명」 「바꿈 3」 「안 바꿈 2」 「pink nipples 1」.
 * futaDrawn 은 요청의 재조립 계획(futaPlan.counts.futa)이 알려 주는 그려지는 후타 수다.
 * 메모로 후타를 짐작하지 않는다 — 상대 여캐의 글을 바꾼 메모도 같은 모양이라 후타가 아닌 캐릭터를 세게 된다
 */
export function bodyCounts(
  notes: readonly BodyNote[],
  futaDrawn?: number,
  futaOff?: number
): BodyCount[] {
  const amount: Record<BodyCount['id'], number> = {
    futa: futaDrawn && futaDrawn > 0 ? futaDrawn : -1,
    off: futaOff && futaOff > 0 ? futaOff : -1,
    replaced: notes.filter((n) => n.kind === 'replaced').length,
    removed: notes.filter((n) => n.kind === 'removed').length,
    added: notes.filter((n) => n.kind === 'added' && !isPinkNote(n)).length,
    pink: notes.filter(isPinkNote).length,
    conflict: notes.filter((n) => n.kind === 'conflict').length,
    suspect: notes.filter((n) => n.kind === 'suspect').length,
    unreadable: notes.filter((n) => n.kind === 'unreadable').length,
    kept: notes.filter((n) => n.kind === 'kept').length
  }
  return COUNT_ORDER.flatMap((id): BodyCount[] => {
    const n = amount[id]
    if (id === 'futa') return n < 0 ? [] : [{ id, label: `후타 ${n}명`, tone: 'info', loud: false }]
    // 재조립이 꺼져 있는데 후타 카드가 그려진다 — 후타를 못 알아본 게 아니라 껐다는 것을 알린다
    if (id === 'off')
      return n < 0
        ? []
        : [{ id, label: `후타 카드 ${n}장 · 재조립 꺼짐`, tone: 'mute', loud: false }]
    if (n <= 0) return []
    const meta = id === 'pink' ? { label: 'pink nipples', tone: 'ok' as const } : KIND_META[id]
    return [{ id, label: `${meta.label} ${n}`, tone: meta.tone, loud: id !== 'kept' }]
  })
}

/**
 * 저장된 펼침이 없을 때 처음부터 펴 둘까 — 바뀐 것이나 눈여겨볼 것이 있으면 편다 (접어 두면 바뀐 태그를 못 본다).
 * 알몸 여캐마다 붙는 pink nipples 와, 바뀐 것 없이 「못 읽음」뿐일 때는 접힌 줄의 요약(색이 있다)으로 충분해 펴지 않는다
 */
export const opensByDefault = (counts: readonly BodyCount[]): boolean =>
  counts.some((c) => c.loud && c.id !== 'pink' && c.id !== 'unreadable')

/** 한 줄 요약 글 — 「후타 1명 · 바꿈 3 · 안 바꿈 2 · pink nipples 1」 */
export const bodySummaryText = (notes: readonly BodyNote[]): string =>
  bodyCounts(notes)
    .map((c) => c.label)
    .join(' · ')

/** 메모 한 곳이 어느 캐릭터 것인가를 가리는 데 쓰는 최소 모양 (카드) */
interface CharLike {
  id: number
  name: string
}

/**
 * 한 캐릭터(카드)의 메모 — 메모에 카드 id(charId)가 실려 있으면 그것으로 가린다 (이름이 같은 다른 카드와 섞이지 않는다).
 * id 가 없는 메모만 자동 젖힘 메모의 charIndex 로, 그것도 없으면 카드 이름으로 맞춘다.
 * 캐릭터를 모르는 메모와 이름이 비어 있는 메모는 어느 카드에도 붙이지 않는다.
 */
export function bodyNotesOfChar(
  notes: readonly BodyNote[] | undefined,
  card: CharLike,
  exposeNotes?: readonly ExposeNote[]
): BodyNote[] {
  const indexes = new Set(
    (exposeNotes ?? []).filter((n) => n.charId === card.id).map((n) => n.charIndex)
  )
  return (notes ?? []).filter((n) => {
    if (n.charId != null) return n.charId === card.id
    return (
      (n.charIndex != null && indexes.has(n.charIndex)) ||
      (!!n.name && n.name.trim() === card.name.trim())
    )
  })
}

/** 캐릭터 줄 배지 — 후타 · 후타 의심 · 충돌 · 못 읽음 · pink nipples, 배지마다 자기 호버 글 */
export interface BodyCharBadge {
  /** 이 카드가 후타로 읽혔는가 (요청의 futaPlan.chars) */
  futa: boolean
  pink: boolean
  /** 눈여겨볼 종류 (충돌·후타 의심·못 읽음) */
  attention: BodyKind[]
  /** 배지 하나의 호버 글 — 그 배지가 가리키는 메모만 한 줄씩 */
  titleOf: (id: 'futa' | 'pink' | BodyKind) => string
  /** 모든 메모의 호버 글 */
  title: string
}

/**
 * futa 는 부모가 요청의 계획(futaPlan.chars)으로 알려 준다. 메모로는 짐작하지 않는다 —
 * 후타의 상대 여캐도 글을 바꾼 메모를 받는데 후타는 아니다.
 */
export function bodyCharBadge(notes: readonly BodyNote[], futa = false): BodyCharBadge {
  const attention = KIND_ORDER.filter(
    (k) => BODY_ATTENTION.has(k) && notes.some((n) => n.kind === k)
  )
  const lines = (list: readonly BodyNote[]): string =>
    list.length ? ['몸·후타', ...sorted(list).map(bodyNoteLine)].join('\n') : ''
  return {
    futa,
    pink: notes.some(isPinkNote),
    attention,
    titleOf: (id) =>
      lines(
        id === 'futa'
          ? notes.filter(isFutaNote)
          : id === 'pink'
            ? notes.filter(isPinkNote)
            : notes.filter((n) => n.kind === id)
      ),
    title: lines(notes)
  }
}

export interface BodyRoundNotes {
  label: string
  notes: BodyNote[]
  /** 이 회차에 그려지는 후타 수 (요청의 futaPlan.counts.futa) */
  futa?: number
  /** 후타 자동 재조립이 꺼져 있는데 그려지는 후타 카드 수 (futaCardsOff) — 꺼서 바꾸지 않았다는 것을 알리려는 값 */
  futaOff?: number
}

interface BodyGroup {
  label: string | null
  notes: BodyNote[]
  futa?: number
  futaOff?: number
}

/**
 * 후타 자동 재조립이 꺼져 있을 때, 요청에 실린 캐릭터 가운데 카드에 futanari 가 있는 카드 수 (같은 카드가 여러 자리에 앉아도 한 장).
 * 화면에 알리기만 하는 값이다 — 요청은 건드리지 않는다
 */
export function futaCardsOff(
  prompts: readonly { prompt: string; name?: string }[] | undefined
): number {
  const names = new Set<string>()
  ;(prompts ?? []).forEach((p, i) => {
    if (readBody(null, [p.prompt], true).body.futa) names.add(p.name ?? `#${i}`)
  })
  return names.size
}

/** 회차(큐 반복 항목)마다 결과가 같으면 한 묶음으로, 다르면 회차별로 */
export function groupBodyRounds(rounds: readonly BodyRoundNotes[]): BodyGroup[] {
  if (rounds.length <= 1)
    return rounds.map((r) => ({ label: null, notes: r.notes, futa: r.futa, futaOff: r.futaOff }))
  const same = (r: BodyRoundNotes): string =>
    JSON.stringify([r.notes, r.futa ?? null, r.futaOff ?? null])
  const first = same(rounds[0])
  if (rounds.every((r) => same(r) === first))
    return [
      { label: null, notes: rounds[0].notes, futa: rounds[0].futa, futaOff: rounds[0].futaOff }
    ]
  return rounds.map((r) => ({ label: r.label, notes: r.notes, futa: r.futa, futaOff: r.futaOff }))
}

/**
 * 여러 회차의 요약을 한 줄로 — 같은 조각은 가장 큰 값을 쓴다.
 * 첫 회차만 보이면 다른 회차에만 있는 충돌·후타 의심이 접힌 줄에서 가려진다.
 */
export function mergedBodyCounts(groups: readonly BodyGroup[]): BodyCount[] {
  const best = new Map<BodyCount['id'], { count: BodyCount; value: number }>()
  for (const g of groups) {
    for (const c of bodyCounts(g.notes, g.futa, g.futaOff)) {
      const value = Number(/\d+/.exec(c.label)?.[0] ?? 0)
      const prev = best.get(c.id)
      if (!prev || value > prev.value) best.set(c.id, { count: c, value })
    }
  }
  return COUNT_ORDER.flatMap((id) => {
    const hit = best.get(id)
    return hit ? [hit.count] : []
  })
}
