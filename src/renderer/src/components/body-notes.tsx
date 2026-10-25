import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { BodyNote } from '@shared/types'
import {
  KIND_META,
  bodyCharBadge,
  bodyNoteLine,
  groupBodyRounds,
  mergeBodyRows,
  mergedBodyCounts,
  opensByDefault,
  type BodyKind,
  type BodyRoundNotes
} from '../lib/body-notes'
import type { NoteTone } from '../lib/expose-notes'
import { useFutaReassembly } from '../lib/use-futa-settings'
import { cn } from '../lib/utils'

/**
 * 몸·후타 자동 재조립 — 바꾼 것·뺀 것·더한 것과 안 바꾼 것을 화면에 보이는 조각들 (커스텀).
 * 판정은 요청에 실려 온 메모(BodyNote)를 그대로 읽는다. 여기서 다시 따지지 않는다.
 * 색은 자동 젖힘(expose-notes.tsx)과 같은 토큰을 쓴다 — 어느 테마에서도 글자 대비가 4.5:1 안팎이다.
 */

const TONE_CLASS: Record<NoteTone, string> = {
  ok: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  info: 'bg-surface-2 text-ink',
  warn: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  danger: 'bg-danger/15 text-danger',
  mute: 'bg-paper text-muted'
}

const TONE_TEXT: Record<NoteTone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  info: 'text-ink',
  warn: 'text-amber-700 dark:text-amber-400',
  danger: 'text-danger',
  mute: 'text-muted'
}

/** 종류 이름표 — 바꿈 · 뺌 · 더함 · 안 바꿈 · 못 읽음 · 후타 의심 · 충돌 */
export function BodyKindBadge({ kind }: { kind: BodyKind }): React.JSX.Element {
  const meta = KIND_META[kind]
  return (
    <span
      data-body-kind={kind}
      title={meta.hint}
      className={cn(
        'shrink-0 whitespace-nowrap rounded px-1.5 py-px text-[10.5px] font-medium',
        TONE_CLASS[meta.tone]
      )}
    >
      {meta.label}
    </span>
  )
}

/** 태그·구절 칩 — 긴 문장 토막도 줄바꿈이 된다 */
function Chip({
  children,
  className
}: {
  children: string
  className?: string
}): React.JSX.Element {
  return (
    <code
      className={cn(
        'max-w-full whitespace-normal break-words rounded bg-paper px-1 font-mono text-[11px]',
        className
      )}
    >
      {children}
    </code>
  )
}

/** 줄 하나 — 위치 · 종류 · 이전 → 이후 · 근거 · 이유 (같은 바뀜이면 위치를 합쳐 한 줄) */
function BodyRowView({
  row
}: {
  row: ReturnType<typeof mergeBodyRows>[number]
}): React.JSX.Element {
  const n = row.note
  const before = n.before?.trim()
  const after = n.after?.trim()
  return (
    <li
      data-body-row=""
      data-kind={n.kind}
      data-where={row.members.map((m) => m.where).join(' ')}
      title={row.members.map(bodyNoteLine).join('\n')}
      className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[11.5px]"
    >
      <span className="max-w-full break-words text-muted">{row.places.join(' · ')}</span>
      <BodyKindBadge kind={n.kind} />
      {n.kind === 'replaced' ? (
        <>
          {before && <Chip className="text-muted line-through decoration-muted/60">{before}</Chip>}
          {before && after && <span className="text-muted">→</span>}
          {after && <Chip className={TONE_TEXT.ok}>{after}</Chip>}
        </>
      ) : n.kind === 'removed' ? (
        before && <Chip className="text-muted line-through decoration-muted/60">{before}</Chip>
      ) : n.kind === 'added' ? (
        after && <Chip className={TONE_TEXT.ok}>{`+${after}`}</Chip>
      ) : (
        (before || after) && <Chip className="text-muted">{before || after || ''}</Chip>
      )}
      {n.evidence && <span className="text-muted">(근거 {n.evidence})</span>}
      {n.reason && <span className="basis-full pl-[34px] text-[11px] text-muted">{n.reason}</span>}
    </li>
  )
}

/** 메모 목록 — 같은 바뀜이면 위치를 합쳐 한 줄 */
export function BodyNoteRows({ notes }: { notes: BodyNote[] }): React.JSX.Element | null {
  const rows = mergeBodyRows(notes)
  if (!rows.length) return null
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row, i) => (
        <BodyRowView key={`${i}:${row.note.kind}:${row.note.before ?? ''}`} row={row} />
      ))}
    </ul>
  )
}

/**
 * 캐릭터 줄 옆 배지 — 「후타」 · 「후타 의심」 · 「후타 충돌」 · 「후타 못 읽음」 · 「pink nipples」.
 * 「후타」는 이 카드가 후타로 읽혔을 때만 단다 (futa — 요청의 재조립 계획이 알려 준다. 메모로는 짐작하지 않는다).
 * 호버하면 그 배지가 가리키는 메모가 줄마다 나오고, 키보드·스크린리더에는 같은 글이 배지마다 aria-label 로 읽힌다.
 */
export function FutaCharBadges({
  notes,
  futa = false
}: {
  notes: BodyNote[]
  futa?: boolean
}): React.JSX.Element | null {
  const badge = bodyCharBadge(notes, futa)
  if (!badge.title && !futa) return null
  const item = (
    id: 'futa' | 'pink' | BodyKind,
    text: string,
    tone: NoteTone
  ): React.JSX.Element => {
    const title =
      badge.titleOf(id) || (id === 'futa' ? '몸·후타\n후타로 읽은 카드 — 바꾼 것 없음' : '')
    return (
      <span
        key={id}
        data-body-badge={id}
        tabIndex={0}
        aria-label={title.replace(/\n/g, '. ')}
        className={cn('text-[10px]', TONE_TEXT[tone])}
        title={title}
      >
        {text}
      </span>
    )
  }
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {badge.futa && item('futa', '후타', 'ok')}
      {badge.attention.map((k) =>
        item(k, k === 'suspect' ? '후타 의심' : `후타 ${KIND_META[k].label}`, KIND_META[k].tone)
      )}
      {badge.pink && !badge.futa && item('pink', 'pink nipples', 'ok')}
    </span>
  )
}

const OPEN_KEY = 'scene_body_open'

/** 저장된 펼침 상태 — 저장한 적이 없으면 null (바뀐 것이나 눈여겨볼 것이 있을 때만 처음부터 펴 둔다) */
function readOpen(): boolean | null {
  try {
    const v = localStorage.getItem(OPEN_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/**
 * 씬 상세·메인 탭의 접이식 「몸·후타」 블록.
 * 접어도 한 줄 요약(후타 1명 · 바꿈 3 · 안 바꿈 2 · pink nipples 1 …)이 보이고, 펴면 바꾼 곳마다 이전 → 이후와 이유가 나온다.
 * 후타가 그려지는데 바꿀 것이 하나도 없으면 「후타 1명 · 바꾼 것 없음」 한 줄만 보인다 (후타로 읽었다는 것은 알린다).
 * 후타도 메모도 없으면 아무것도 그리지 않는다 (후타가 없는 씬에 빈 칸을 늘어놓지 않는다).
 * rounds 는 큐 반복 회차마다의 메모 — 회차끼리 같으면 한 번만 보이고, 다르면 접힌 줄에는 모든 회차의 조각이 합쳐진다.
 * scope 는 이 블록이 어디에 놓였는가 — 안내 문구가 씬 글인지 메인 글인지 맞춘다.
 */
export function BodyBlock({
  rounds,
  scope = 'scene'
}: {
  rounds: BodyRoundNotes[]
  scope?: 'scene' | 'main'
}): React.JSX.Element | null {
  const groups = groupBodyRounds(rounds)
  const counts = mergedBodyCounts(groups)
  const summary = counts.map((c) => c.label).join(' · ')
  const worthOpening = opensByDefault(counts)
  const [reassembly] = useFutaReassembly()
  const [saved, setSaved] = useState<boolean | null>(readOpen)
  const open = saved ?? worthOpening
  const bodyId = useId()
  const toggle = (): void => {
    const next = !open
    setSaved(next)
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0')
    } catch {
      // 저장이 막혀도 이 화면에서는 펴고 접힌다
    }
  }
  if (groups.every((g) => g.notes.length === 0)) {
    // 후타가 그려지는데 바꾼 것이 없다(또는 재조립이 꺼져 있다) — 후타로 읽었다는 것, 껐다는 것만 알린다
    if (!counts.some((c) => c.id === 'futa' || c.id === 'off')) return null
    const drawn = counts.some((c) => c.id === 'futa')
    return (
      <section
        data-testid="body-block"
        data-body-empty=""
        className="flex flex-wrap items-baseline gap-x-2 rounded-lg border border-line bg-surface-2/40 px-2.5 py-1.5 text-[12px]"
      >
        <span className="font-medium">몸·후타</span>
        <span data-testid="body-summary" className="text-[11.5px] text-muted">
          {summary}
          {drawn && ' · 바꾼 것 없음'}
        </span>
      </section>
    )
  }
  const own = scope === 'main' ? '메인에 적은 글' : '씬에 적힌 글'
  return (
    <section data-testid="body-block" className="rounded-lg border border-line bg-surface-2/40">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]"
        onClick={toggle}
      >
        <ChevronRight
          size={13}
          className={cn('shrink-0 transition-transform', open && 'rotate-90')}
        />
        <span className="shrink-0 font-medium">몸·후타</span>
        {/* 접힌 줄이 길어져도 잘리지 않고 줄바꿈 — 충돌·후타 의심이 말줄임에 가려지지 않게 */}
        <span
          data-testid="body-summary"
          title={summary}
          className="min-w-0 flex-1 text-[11.5px] text-muted"
        >
          {counts.map((c, i) => (
            <span key={c.id}>
              {i > 0 && ' · '}
              {/* 바뀐 것과 눈여겨볼 것은 접어도 색으로 보인다 */}
              <span className={c.loud || c.id === 'futa' ? TONE_TEXT[c.tone] : undefined}>
                {c.label}
              </span>
            </span>
          ))}
          {groups.length > 1 && ' · 회차마다 다름'}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="flex flex-col gap-2 border-t border-line px-2.5 py-2">
          {groups.map((g, gi) => (
            <div key={g.label ?? gi} className="flex flex-col gap-1.5">
              {g.label && <p className="text-[11.5px] font-medium text-muted">{g.label}</p>}
              {g.notes.length ? (
                <BodyNoteRows notes={g.notes} />
              ) : (
                <p className="text-[11.5px] text-muted">이 회차는 바꾼 것이 없습니다.</p>
              )}
            </div>
          ))}
          <p className="text-[11px] text-muted">
            바꾼 것은 보낼 때만이고 {own}은 그대로입니다.{' '}
            {reassembly
              ? '설정의 「후타 자동 재조립」을 끄면 후타 글 바꾸기가 모두 꺼집니다'
              : '「후타 자동 재조립」이 꺼져 있어 후타 글은 바꾸지 않습니다'}
            {counts.some((c) => c.id === 'pink') && ' (pink nipples 는 이 설정과 무관합니다)'}.
          </p>
        </div>
      )}
    </section>
  )
}
