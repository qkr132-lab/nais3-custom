import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import type { ExposeNote } from '@shared/types'
import {
  AREA_LABEL,
  ATTENTION,
  STATUS_META,
  TAG_ROLE,
  charBadge,
  countLabel,
  displayReason,
  groupByChar,
  groupRounds,
  mergeRows,
  mergedCounts,
  noteLine,
  noteMeta,
  type NoteRow as NoteRowData,
  type NoteStatus,
  type NoteTone,
  type RoundNotes
} from '../lib/expose-notes'
import { cn } from '../lib/utils'

/**
 * 입은 옷 자동 젖힘 — 붙은 태그와 안 붙은 이유를 화면에 보이는 조각들 (커스텀).
 * 판정은 요청에 실려 온 메모(ExposeNote)를 그대로 읽는다. 여기서 다시 따지지 않는다.
 * 색은 테마 토큰(muted·ink·danger)과 라이트/다크 쌍(-700 / -400)으로 — 어느 테마에서도 글자 대비가 4.5:1 안팎이다.
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

/** 상태 이름표 — 붙음 · 이미 있음 · 조각이 맡음 · 알몸 · 옷 위 · 화면 밖 · 부정문 · 섹스 뒤 · 옷 못 읽음 · 판단 못 함 · 충돌 · 막음 · 근거 없음 */
export function ExposeStatusBadge({
  status,
  note
}: {
  status: NoteStatus
  /** 옷 글이 없는 조용한 「옷 못 읽음」은 이름표가 다르다 — 메모를 주면 그것까지 맞춘다 */
  note?: ExposeNote
}): React.JSX.Element {
  const meta = note ? noteMeta(note) : STATUS_META[status]
  return (
    <span
      data-expose-status={status}
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

/** 줄 하나 — 부위 · 상태 · 태그 · 옷/근거 · 이유 (같은 말이면 부위를 합쳐 한 줄) */
function NoteRowView({ row }: { row: NoteRowData }): React.JSX.Element {
  const note = row.note
  const added = note.status === 'added'
  const reason = displayReason(note)
  const facts = [
    note.garments.length ? `옷 ${note.garments.join(', ')}` : '',
    row.evidence.length ? `근거 ${row.evidence.join(', ')}` : ''
  ].filter(Boolean)
  return (
    <li
      data-expose-row=""
      data-status={note.status}
      data-area={row.areas.join(' ')}
      title={row.members.map(noteLine).join('\n')}
      className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-[11.5px]"
    >
      <span className="shrink-0 whitespace-nowrap text-muted">
        {row.areas.map((a) => AREA_LABEL[a]).join(' · ')}
      </span>
      <ExposeStatusBadge status={note.status} note={note} />
      {note.tags.length > 0 && TAG_ROLE[note.status] && (
        <span className="text-[10.5px] text-muted">{TAG_ROLE[note.status]}</span>
      )}
      {note.tags.map((tag, i) => (
        <code
          key={`${i}:${tag}`}
          className={cn(
            'rounded bg-paper px-1 font-mono text-[11px]',
            added
              ? TONE_TEXT.ok
              : note.status === 'vetoed'
                ? 'text-muted line-through decoration-muted/60'
                : 'text-muted'
          )}
        >
          {added ? '+' : ''}
          {tag}
        </code>
      ))}
      {facts.length > 0 && <span className="text-muted">({facts.join(' · ')})</span>}
      {reason && <span className="basis-full pl-[34px] text-[11px] text-muted">{reason}</span>}
    </li>
  )
}

/**
 * 메모 목록 — 같은 말이면 부위를 합쳐 한 줄로 (알몸·근거 없음이 부위마다 되풀이되지 않는다).
 * 씬 상세 블록과 복장 선택이 같은 모양을 쓴다.
 */
export function ExposeNoteRows({ notes }: { notes: ExposeNote[] }): React.JSX.Element | null {
  const rows = mergeRows(notes)
  if (!rows.length) return null
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((row, i) => (
        <NoteRowView key={`${i}:${row.areas.join('')}:${row.note.status}`} row={row} />
      ))}
    </ul>
  )
}

/**
 * 캐릭터 줄 옆 배지 — 「자동 +N」과 충돌·판단 못 함·옷 못 읽음(부위). 호버하면 부위별 이유가 나오고,
 * 키보드·스크린리더에는 같은 글이 aria-label 로 읽힌다. 줄을 누르면 복장 선택에 같은 메모가 줄로 펼쳐진다.
 * 이름이 길어 말줄임이 돼도 경고가 먼저 잘리지 않게 이름 칸 밖(shrink-0)에 둔다.
 */
export function ExposeCharBadges({ notes }: { notes: ExposeNote[] }): React.JSX.Element | null {
  const badge = charBadge(notes)
  if (!badge.title) return null
  const label = badge.title.replace(/\n/g, '. ')
  // 붙은 게 없으면 「자동 0」은 군더더기 — 붙은 게 있을 때만 알린다
  return (
    <span className="flex shrink-0 items-center gap-1">
      {badge.added > 0 && (
        <span
          data-expose-badge="auto"
          tabIndex={0}
          aria-label={label}
          className={cn('text-[10px]', TONE_TEXT.ok)}
          title={badge.title}
        >
          자동 +{badge.added}
        </span>
      )}
      {badge.attention.map((a) => (
        <span
          key={a.status}
          data-expose-badge={a.status}
          tabIndex={0}
          aria-label={label}
          className={cn('text-[10px]', TONE_TEXT[STATUS_META[a.status].tone])}
          title={badge.title}
        >
          {STATUS_META[a.status].label}({a.areas.map((x) => AREA_LABEL[x]).join('·')})
        </span>
      ))}
    </span>
  )
}

const OPEN_KEY = 'scene_expose_open'

/** 저장된 펼침 상태 — 저장한 적이 없으면 null (붙은 것이나 눈여겨볼 것이 있을 때만 처음부터 펴 둔다) */
function readOpen(): boolean | null {
  try {
    const v = localStorage.getItem(OPEN_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/**
 * 씬 상세의 접이식 「자동 젖힘」 블록.
 * 접어도 한 줄 요약(붙음 3개 · 충돌 1명 …)이 보이고, 펴면 캐릭터·부위마다 붙은 태그와 안 붙은 이유가 나온다.
 * rounds 는 큐 반복 회차마다의 메모 — 회차끼리 같으면 한 번만 보이고, 다르면 접힌 줄에는 모든 회차의 눈여겨볼 상태가 합쳐진다.
 */
export function ExposeBlock({
  rounds,
  enabled
}: {
  rounds: RoundNotes[]
  /** 설정 「입은 옷 자동 젖힘」 */
  enabled: boolean
}): React.JSX.Element {
  const groups = groupRounds(rounds)
  const counts = mergedCounts(groups)
  const summary = counts.map(countLabel).join(' · ')
  // 저장된 펼침이 없으면 붙은 태그나 눈여겨볼 상태가 있을 때 처음부터 펴 둔다 (접어 두면 붙은 태그를 못 본다)
  const worthOpening = counts.some((c) => c.status === 'added' || ATTENTION.has(c.status))
  const [saved, setSaved] = useState<boolean | null>(readOpen)
  const open = saved ?? (enabled && worthOpening)
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
  const nothing = groups.every((g) => g.notes.length === 0)
  return (
    <section data-testid="expose-block" className="rounded-lg border border-line bg-surface-2/40">
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
        <span className="shrink-0 font-medium">자동 젖힘</span>
        <span
          data-testid="expose-summary"
          title={enabled ? summary : undefined}
          className="min-w-0 flex-1 truncate text-[11.5px] text-muted"
        >
          {!enabled ? (
            '꺼짐'
          ) : nothing || counts.length === 0 ? (
            '붙은 것 없음'
          ) : (
            <>
              {counts.map((c, i) => (
                <span key={c.status}>
                  {i > 0 && ' · '}
                  {/* 붙음과 눈여겨볼 상태(충돌·판단 못 함·옷 못 읽음)는 접어도 색으로 보인다 */}
                  <span
                    className={
                      c.status === 'added' || ATTENTION.has(c.status)
                        ? TONE_TEXT[STATUS_META[c.status].tone]
                        : undefined
                    }
                  >
                    {countLabel(c)}
                  </span>
                </span>
              ))}
              {groups.length > 1 && ' · 회차마다 다름'}
            </>
          )}
        </span>
      </button>
      {open && (
        <div id={bodyId} className="flex flex-col gap-2 border-t border-line px-2.5 py-2">
          {!enabled ? (
            <p className="text-[11.5px] text-muted">
              설정의 「입은 옷 자동 젖힘」이 꺼져 있어 입은 옷에 맞춘 젖힘 태그를 붙이지 않습니다
              (복장의 nsfw 조각은 그대로 켜집니다).
            </p>
          ) : nothing ? (
            <p className="text-[11.5px] text-muted">
              그림에 나오는 캐릭터가 없어 따로 보여 줄 판정이 없습니다.
            </p>
          ) : (
            groups.map((g, gi) => (
              <div key={g.label ?? gi} className="flex flex-col gap-2">
                {g.label && <p className="text-[11.5px] font-medium text-muted">{g.label}</p>}
                {groupByChar(g.notes).map((c) => (
                  <div
                    key={c.charIndex}
                    data-expose-char={c.charIndex}
                    className="flex flex-col gap-1"
                  >
                    <p className="text-[12px] font-medium">
                      {c.name || `캐릭터 ${c.charIndex + 1}`}
                      {c.charId != null && (
                        <span className="ml-1.5 font-mono text-[10.5px] font-normal text-muted">
                          #{c.charId}
                        </span>
                      )}
                    </p>
                    <ExposeNoteRows notes={c.notes} />
                  </div>
                ))}
              </div>
            ))
          )}
          {enabled && (
            <p className="text-[11px] text-muted">
              막으려면 카드나 씬 태그에 음수 가중치로 적으세요 (예: -1::skirt lift::). 씬 위쪽 「옷
              벗기기」가 둘 다·남캐만·여캐만인 캐릭터는 알몸이 먼저입니다.
            </p>
          )}
        </div>
      )}
    </section>
  )
}
