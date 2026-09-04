import { useEffect, useRef, useState } from 'react'
import { Check, Plus, RotateCcw, User } from 'lucide-react'
import type { CharPositions, CharRole, CharRoles, CharacterCard } from '@shared/types'
import { modelCaps } from '@shared/nai-models'
import { seatSlots } from '@shared/scene-request'
import { cn } from '../lib/utils'
import { useCharactersStore } from '../stores/characters-store'
import { useGenerationStore } from '../stores/generation-store'
import { PlacementCanvas, distributed } from './placement-canvas'
import { PromptEditor } from './prompt-editor'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Switch } from './ui/switch'

/**
 * 씬 캐릭터 배치 창 (커스텀).
 *
 * 씬의 '위치 적용'은 캐릭터마다 작은 팝오버로 좌표를 하나씩 찍는 방식이라,
 * 이 씬에 누가 들어 있는지·서로 어디에 서는지를 한눈에 볼 수 없었다.
 * 여기서는 씬에 들어간 캐릭터 전원을 실제 생성 비율 판 위에 올려놓고 끌어서
 * 배치하며, 아래 목록에서 캐릭터를 넣고 뺄 수도 있다.
 *
 * 좌표는 씬 전용 오버라이드(positions)에만 쓴다 — 캐릭터 카드의 기본 좌표는 건드리지 않고,
 * 씬 생성도 카드 좌표를 쓰지 않는다 (배치 탭에서 끌어놓은 위치가 씬으로 새지 않게).
 *
 * 자리(slots): 캐릭터 없이 좌표만 먼저 잡아두는 칸. "이 씬은 2명, 여기랑 여기"를 짜두고
 * 나중에 자리를 골라 캐릭터를 꽂는다. **같은 카드를 여러 자리에 앉힐 수 있고**, 자리마다
 * 다른 태그·역할을 걸 수 있다 — 한 카드로 같은 인물을 여럿 그리는 구도용.
 *
 * 태그는 두 층이다. 자리 태그·이 씬 태그는 여기서만 얹히고 카드는 그대로 남는다.
 * 카드 자체를 고치려면 편집칸에서 '카드'로 바꿔야 한다 (모든 씬에 반영된다).
 */

/**
 * 씬 전용 태그 입력칸 (자리 태그·이 씬 태그 공용).
 *
 * 씬별 추가 설정은 저장할 때 설정 전체(모든 씬의 추가 선택 + 큐 항목)를 통째로 다시 쓴다.
 * 글자마다 저장하면 그 덩어리를 매번 디스크에 쓰므로, 잠깐 모았다가 넘긴다.
 * 창을 닫거나 다른 자리를 골라 사라질 때도 마지막 입력을 흘리지 않게 한 번 더 넘긴다.
 */
function SceneTagEditor({
  value,
  placeholder,
  onCommit
}: {
  value: string
  placeholder: string
  onCommit: (text: string) => void
}): React.JSX.Element {
  const [text, setText] = useState(value)
  const latest = useRef(text)
  const dirty = useRef(false)
  const commit = useRef(onCommit)

  // 사라질 때 넘길 최신값을 들고 있는다 (렌더 중에 ref를 건드리지 않게 효과에서 갱신)
  useEffect(() => {
    commit.current = onCommit
    latest.current = text
  })

  useEffect(() => {
    if (!dirty.current) return
    const timer = setTimeout(() => commit.current(text), 400)
    return () => clearTimeout(timer)
  }, [text])

  useEffect(
    () => () => {
      if (dirty.current) commit.current(latest.current)
    },
    []
  )

  return (
    <PromptEditor
      autoGrow
      tokensOverride={null}
      className="max-h-[120px] min-h-[52px] bg-paper"
      value={text}
      placeholder={placeholder}
      onValueChange={(v) => {
        dirty.current = true
        setText(v)
      }}
    />
  )
}

const roleName = (role: CharRole): string => (role === 'source' ? '하는쪽' : '당하는쪽')

function charLabel(c: CharacterCard, index: number): string {
  const name = c.name.trim() || c.prompt.split(',')[0]?.trim() || `캐릭터 ${index + 1}`
  return name.length > 12 ? name.slice(0, 12) + '…' : name
}

export function ScenePlacementDialog({
  open,
  onOpenChange,
  characterIds,
  positions,
  useCoords,
  slots,
  slotOf,
  slotChars,
  slotRoles,
  slotTags,
  charTags,
  onPatch
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  characterIds: number[]
  positions?: CharPositions
  useCoords?: boolean
  /** 미리 잡아둔 자리 */
  slots?: { x: number; y: number }[]
  /** (구형) 캐릭터 id → 자리 번호 */
  slotOf?: Record<number, number>
  /** 자리 번호 → 그 자리에 앉은 캐릭터 id */
  slotChars?: Record<number, number>
  /** 자리 번호 → 행위 역할 */
  slotRoles?: Record<number, CharRole | null>
  /** 자리 번호 → 그 자리에 앉는 캐릭터에게 덧붙는 태그 */
  slotTags?: Record<number, string>
  /** 캐릭터 id → 이 씬에서만 덧붙는 태그 */
  charTags?: Record<number, string>
  /** 캐릭터별 행위 역할 (자리 역할이 있으면 그쪽이 이긴다) */
  roles?: CharRoles
  onPatch: (patch: {
    characterIds?: number[]
    positions?: CharPositions
    useCoords?: boolean
    slots?: { x: number; y: number }[]
    slotOf?: Record<number, number>
    slotChars?: Record<number, number>
    slotRoles?: Record<number, CharRole | null>
    slotTags?: Record<number, string>
    charTags?: Record<number, string>
    roles?: CharRoles
  }) => void
}): React.JSX.Element {
  const items = useCharactersStore((s) => s.items)
  const updateCard = useCharactersStore((s) => s.updateCard)
  const request = useGenerationStore((s) => s.request)
  const caps = modelCaps(request.model)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [pickedSlot, setPickedSlot] = useState<number | null>(null)
  // 편집칸이 카드를 고치는 중인지 — 기본은 씬 전용 태그 (카드는 실수로 바뀌면 안 된다)
  const [editCard, setEditCard] = useState(false)

  const picked = characterIds
    .map((id) => items.find((c) => c.id === id))
    .filter((c): c is CharacterCard => !!c)

  // 미지정은 0.5 고정 — 카드 기본 좌표는 씬 생성에 쓰이지 않는다 (배치 탭 좌표가 새지 않게)
  const centerOf = (c: CharacterCard): { x: number; y: number } =>
    positions?.[c.id] ?? { x: 0.5, y: 0.5 }

  const setPos = (id: number, center: { x: number; y: number }): void =>
    onPatch({ positions: { ...(positions ?? {}), [id]: center } })

  const resetPos = (id: number): void => {
    const next = { ...(positions ?? {}) }
    delete next[id]
    onPatch({ positions: next })
  }

  const slotList = slots ?? []
  // 좌석표는 생성과 같은 규칙을 쓴다 (seatSlots) — 창에서 본 배치와 실제 생성이 어긋나지 않게
  const seating = seatSlots(picked, { slots: slotList, slotChars, slotOf })
  const charAtSlot = (index: number): CharacterCard | undefined => {
    const id = seating.bySlot.get(index)
    return id == null ? undefined : picked.find((c) => c.id === id)
  }
  const seatsOf = (id: number): number[] => seating.bySlots.get(id) ?? []

  /** 이 자리를 차지한 캐릭터가 카드 번호로 자동 배정된 것인지 */
  const isAutoAt = (index: number): boolean => {
    const c = charAtSlot(index)
    return !!c && slotChars?.[index] == null && slotOf?.[c.id] == null
  }

  const slotOccupant = pickedSlot != null ? charAtSlot(pickedSlot) : undefined
  const selectedChar = picked.find((c) => c.id === selectedId)
  // 실제로 그려질 인물 수 — 자리에 여러 번 앉은 캐릭터는 그만큼 늘어난다
  const figures = picked.reduce((n, c) => n + Math.max(1, seatsOf(c.id).length), 0)

  const addSlot = (): void => {
    // 새 자리는 가로로 고르게 — n+1개를 균등 배치한 마지막 자리
    const next = [...slotList, { x: 0.5, y: 0.5 }]
    onPatch({ slots: next.map((_, i) => distributed(next.length, i, 'x')) })
  }

  /** 자리를 지우면 그 뒤 번호는 하나씩 당긴다 — 좌석·역할·태그가 모두 번호로 엮여 있다 */
  const removeSlot = (index: number): void => {
    const shift = <V,>(map: Record<number, V> | undefined): Record<number, V> => {
      const next: Record<number, V> = {}
      for (const [at, v] of Object.entries(map ?? {})) {
        const n = Number(at)
        if (n === index) continue
        next[n > index ? n - 1 : n] = v
      }
      return next
    }
    const nextSlotOf: Record<number, number> = {}
    for (const [id, at] of Object.entries(slotOf ?? {})) {
      if (at === index) continue
      nextSlotOf[Number(id)] = at > index ? at - 1 : at
    }
    onPatch({
      slots: slotList.filter((_, i) => i !== index),
      slotOf: nextSlotOf,
      slotChars: shift(slotChars),
      slotRoles: shift(slotRoles),
      slotTags: shift(slotTags)
    })
    setPickedSlot(null)
  }

  /** 자리 태그 — 그 자리에 앉는 캐릭터 뒤에 붙는다 (카드는 안 건드림) */
  const setSlotTag = (index: number, text: string): void => {
    const next = { ...(slotTags ?? {}) }
    if (text.trim()) next[index] = text
    else delete next[index]
    onPatch({ slotTags: next })
  }

  /** 이 씬에서만 이 캐릭터에 얹는 태그 (카드는 안 건드림) */
  const setCharTag = (id: number, text: string): void => {
    const next = { ...(charTags ?? {}) }
    if (text.trim()) next[id] = text
    else delete next[id]
    onPatch({ charTags: next })
  }

  const moveSlot = (index: number, center: { x: number; y: number }): void =>
    onPatch({ slots: slotList.map((s, i) => (i === index ? center : s)) })

  /** 자리에 역할 지정 — 그 자리에 앉은 캐릭터가 이 역할로 생성된다 (자리마다 따로) */
  const setSlotRole = (index: number, role: CharRole | null): void => {
    const next = { ...(slotRoles ?? {}) }
    if (role) next[index] = role
    else delete next[index]
    onPatch({ slotRoles: next })
  }

  /**
   * 고른 자리에 캐릭터를 앉힌다 (씬에 없으면 함께 추가).
   * 다른 자리에 앉아 있어도 빼지 않는다 — 같은 카드를 여러 자리에 앉히는 게 목적이다.
   */
  const assignToSlot = (index: number, charId: number): void => {
    // 구형 배정이 이 캐릭터를 다른 자리에 묶어두고 있으면 풀어준다 (새 배치가 이겨야 한다)
    const nextSlotOf = { ...(slotOf ?? {}) }
    delete nextSlotOf[charId]
    onPatch({
      slotChars: { ...(slotChars ?? {}), [index]: charId },
      slotOf: nextSlotOf,
      ...(characterIds.includes(charId) ? {} : { characterIds: [...characterIds, charId] })
    })
    setPickedSlot(null)
  }

  const clearSlot = (index: number): void => {
    const nextChars = { ...(slotChars ?? {}) }
    delete nextChars[index]
    // 구형 배정으로 앉아 있던 경우도 같이 푼다 (안 그러면 비워도 다시 앉는다)
    const nextSlotOf: Record<number, number> = {}
    for (const [id, at] of Object.entries(slotOf ?? {})) if (at !== index) nextSlotOf[Number(id)] = at
    onPatch({ slotChars: nextChars, slotOf: nextSlotOf })
  }

  /** 씬에서 캐릭터를 빼면 앉아 있던 자리와 이 씬 태그도 함께 정리한다 */
  const removeChar = (id: number): void => {
    const nextChars: Record<number, number> = {}
    for (const [at, charId] of Object.entries(slotChars ?? {}))
      if (charId !== id) nextChars[Number(at)] = charId
    const nextSlotOf = { ...(slotOf ?? {}) }
    delete nextSlotOf[id]
    const nextCharTags = { ...(charTags ?? {}) }
    delete nextCharTags[id]
    onPatch({
      characterIds: characterIds.filter((x) => x !== id),
      slotChars: nextChars,
      slotOf: nextSlotOf,
      charTags: nextCharTags
    })
  }

  const toggleChar = (id: number): void => {
    if (characterIds.includes(id)) removeChar(id)
    else onPatch({ characterIds: [...characterIds, id] })
  }

  const pickChar = (id: number): void => {
    setPickedSlot(null)
    setSelectedId(id)
    setEditCard(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[min(1000px,94vw)] max-w-none flex-col p-5">
        <DialogTitle className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          씬 캐릭터 배치
          <span
            className={cn(
              'font-mono text-[11px] font-normal',
              figures > caps.maxCharacters ? 'text-danger' : 'text-faint'
            )}
            title="실제로 그려질 인물 수 — 여러 자리에 앉힌 캐릭터는 자리 수만큼 셉니다"
          >
            인물 {figures}/{caps.maxCharacters}
          </span>
          <span className="text-[11.5px] font-normal text-muted">
            {caps.freeformCharacterPosition ? '자유 배치 (V5)' : '5×5 격자 (V4.5)'}
          </span>
          <label className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] font-normal text-muted">
            위치 적용
            <Switch checked={!!useCoords} onCheckedChange={(v) => onPatch({ useCoords: v })} />
          </label>
        </DialogTitle>

        <div className="flex min-h-0 flex-1 flex-wrap gap-4 overflow-auto">
          <div className="flex min-w-[320px] flex-col gap-2">
            <PlacementCanvas
              chars={[
                // 자리 — 음수 id로 구분. 비었으면 번호만, 차 있으면 캐릭터 이름
                ...slotList.map((pos, i) => {
                  const occupant = charAtSlot(i)
                  return {
                    id: -(i + 1),
                    label:
                      (slotRoles?.[i] === 'source'
                        ? '하 '
                        : slotRoles?.[i] === 'target'
                          ? '당 '
                          : '') +
                      (occupant ? `${i + 1}. ${charLabel(occupant, i)}` : `${i + 1}. 빈 자리`),
                    center: pos,
                    thumbnail: occupant?.thumbnail || undefined,
                    tags: occupant?.prompt,
                    extraTags: [charTags?.[occupant?.id ?? -1], slotTags?.[i]]
                      .filter((t) => t?.trim())
                      .join(', ')
                  }
                }),
                // 자리에 앉지 않은 캐릭터만 따로 (앉은 캐릭터는 자리 표식이 대신 그린다)
                ...picked
                  .filter((c) => seatsOf(c.id).length === 0)
                  .map((c, i) => ({
                    id: c.id,
                    label: charLabel(c, i),
                    center: centerOf(c),
                    thumbnail: c.thumbnail || undefined,
                    isDefault: !positions?.[c.id],
                    tags: c.prompt,
                    extraTags: charTags?.[c.id]
                  }))
              ]}
              width={request.width}
              height={request.height}
              freeform={caps.freeformCharacterPosition}
              selectedId={pickedSlot != null ? -(pickedSlot + 1) : selectedId}
              onSelect={(id) => {
                if (id < 0) setPickedSlot(-id - 1)
                else pickChar(id)
              }}
              onMove={(id, center) => (id < 0 ? moveSlot(-id - 1, center) : setPos(id, center))}
              onDistribute={(axis) =>
                onPatch({
                  positions: {
                    ...(positions ?? {}),
                    ...Object.fromEntries(
                      picked.map((c, i) => [c.id, distributed(picked.length, i, axis)])
                    )
                  }
                })
              }
              maxHeight="min(46vh, 400px)"
            />

            {/* 고른 표식의 태그 — 판에서 누른 그 자리/캐릭터를 여기서 바로 고친다 (커스텀) */}
            {pickedSlot != null ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2/50 p-2.5">
                <p className="text-[12px] font-medium text-muted">
                  {pickedSlot + 1}번 자리 태그
                  <span className="ml-1.5 text-[11px] font-normal text-faint">
                    이 자리에 앉는 캐릭터 뒤에 붙습니다 · 카드는 그대로
                  </span>
                </p>
                {slotRoles?.[pickedSlot] && (
                  <p className="text-[11px] text-faint">
                    이 자리는 <b className="text-muted">{roleName(slotRoles[pickedSlot])}</b>이라
                    <code className="mx-0.5 text-accent">sex</code> 같은 행위 태그를 적으면
                    <code className="mx-0.5 text-accent">
                      {slotRoles[pickedSlot]}#sex
                    </code>
                    로 알아서 붙습니다. 표정·포즈는 그대로 들어갑니다.
                  </p>
                )}
                <SceneTagEditor
                  key={`slot-${pickedSlot}`}
                  value={slotTags?.[pickedSlot] ?? ''}
                  placeholder="smile, looking at viewer"
                  onCommit={(v) => setSlotTag(pickedSlot, v)}
                />
                {slotOccupant ? (
                  <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-faint">
                    <span>
                      <b className="text-muted">{charLabel(slotOccupant, pickedSlot)}</b> 가 앉아
                      있습니다
                    </span>
                    <button
                      className="rounded px-1.5 py-0.5 text-accent hover:bg-paper"
                      onClick={() => pickChar(slotOccupant.id)}
                    >
                      이 캐릭터 태그 보기
                    </button>
                  </p>
                ) : (
                  <p className="text-[11px] text-faint">
                    빈 자리입니다 — 아래에서 캐릭터를 누르면 이 자리에 앉고 위 태그를 물려받습니다.
                  </p>
                )}
              </div>
            ) : selectedChar ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2/50 p-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[12px] font-medium text-muted">
                    {charLabel(selectedChar, picked.indexOf(selectedChar))}
                  </span>
                  <span className="flex overflow-hidden rounded border border-line">
                    {[
                      { v: false, t: '이 씬만' },
                      { v: true, t: '카드' }
                    ].map(({ v, t }) => (
                      <button
                        key={t}
                        className={cn(
                          'px-1.5 py-0.5 text-[11px] transition-colors',
                          editCard === v
                            ? v
                              ? 'bg-danger text-white'
                              : 'bg-accent text-white'
                            : 'text-faint hover:bg-paper hover:text-muted'
                        )}
                        onClick={() => setEditCard(v)}
                      >
                        {t}
                      </button>
                    ))}
                  </span>
                  <span className="text-[11px] text-faint">
                    {editCard
                      ? '카드를 직접 고칩니다 — 캐릭터 창과 다른 씬도 같이 바뀝니다'
                      : '이 씬에서만 카드 태그 뒤에 얹습니다'}
                  </span>
                </div>
                {editCard ? (
                  <PromptEditor
                    autoGrow
                    tokensOverride={null}
                    className="max-h-[140px] min-h-[52px] bg-paper"
                    value={selectedChar.prompt}
                    placeholder="girl, ..."
                    onValueChange={(v) => updateCard(selectedChar.id, { prompt: v })}
                  />
                ) : (
                  <SceneTagEditor
                    key={`char-${selectedChar.id}`}
                    value={charTags?.[selectedChar.id] ?? ''}
                    placeholder="school uniform, blush"
                    onCommit={(v) => setCharTag(selectedChar.id, v)}
                  />
                )}
                {seatsOf(selectedChar.id).length > 1 && (
                  <p className="text-[11px] text-faint">
                    {seatsOf(selectedChar.id)
                      .map((i) => i + 1)
                      .join('·')}
                    번 자리에 앉아 있습니다 — 이 태그는 모든 자리에 붙고, 자리마다 다른 태그는 자리
                    태그로 겁니다.
                  </p>
                )}
              </div>
            ) : (
              <p className="rounded-lg border border-dashed border-line px-2.5 py-2 text-[11.5px] text-faint">
                판에서 표식을 누르면 그 자리·캐릭터의 태그를 여기에서 고칠 수 있습니다. 커서를 올리면
                무슨 태그가 걸려 있는지 바로 보입니다.
              </p>
            )}
          </div>

          <div className="flex min-h-0 min-w-[260px] flex-1 flex-col gap-3">
            {/* 미리 잡아둔 자리 — 캐릭터 없이 위치·인원부터 정한다 */}
            <div>
              <p className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted">
                자리
                <span className="font-mono text-[11px] text-faint">{slotList.length}칸</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 gap-1 px-2 text-[11px]"
                  onClick={addSlot}
                >
                  <Plus size={12} /> 자리 추가
                </Button>
              </p>
              {slotList.length === 0 ? (
                <p className="text-[11.5px] text-faint">
                  자리를 먼저 잡아두면 캐릭터 없이도 이 씬의 인원과 배치를 짜둘 수 있습니다.
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {slotList.map((pos, i) => {
                    const occupant = charAtSlot(i)
                    return (
                      <div
                        key={i}
                        className={cn(
                          'flex items-center gap-2 rounded-md border px-1.5 py-1 transition-colors',
                          pickedSlot === i
                            ? 'border-accent bg-accent-soft'
                            : 'border-line bg-surface-2'
                        )}
                        onClick={() => setPickedSlot(pickedSlot === i ? null : i)}
                      >
                        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-paper font-mono text-[10px] text-muted">
                          {i + 1}
                        </span>
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate text-[11.5px]',
                            !occupant && 'text-faint'
                          )}
                        >
                          {occupant ? charLabel(occupant, i) : '비어 있음 — 눌러서 채우기'}
                          {isAutoAt(i) && (
                            <span className="ml-1 text-[10px] text-emerald-500">번호 자동</span>
                          )}
                          {slotTags?.[i]?.trim() && (
                            <span className="ml-1 text-[10px] text-accent" title={slotTags[i]}>
                              +태그
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
                          {pos.x.toFixed(2)},{pos.y.toFixed(2)}
                        </span>
                        {/* 자리 역할 — 이 자리에 앉는 캐릭터가 이 역할로 생성된다 */}
                        <span
                          className="flex shrink-0 gap-0.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {[
                            { v: 'source' as const, t: '하', title: '하는쪽' },
                            { v: 'target' as const, t: '당', title: '당하는쪽' }
                          ].map(({ v, t, title }) => (
                            <button
                              key={v}
                              title={`${title} — 이 자리에 앉는 캐릭터가 이 역할을 받습니다`}
                              className={cn(
                                'rounded px-1 text-[10.5px] font-medium transition-colors',
                                slotRoles?.[i] === v
                                  ? v === 'source'
                                    ? 'bg-accent text-white'
                                    : 'bg-violet-500 text-white'
                                  : 'text-faint hover:bg-paper hover:text-muted'
                              )}
                              onClick={() => setSlotRole(i, slotRoles?.[i] === v ? null : v)}
                            >
                              {t}
                            </button>
                          ))}
                        </span>
                        {occupant && (
                          <button
                            className="shrink-0 rounded px-1 text-[11px] text-faint hover:text-ink"
                            title="이 자리 비우기"
                            onClick={(e) => {
                              e.stopPropagation()
                              clearSlot(i)
                            }}
                          >
                            비우기
                          </button>
                        )}
                        <button
                          className="shrink-0 rounded px-1 text-[11px] text-faint hover:text-danger"
                          title="자리 삭제"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeSlot(i)
                          }}
                        >
                          삭제
                        </button>
                      </div>
                    )
                  })}
                  {pickedSlot != null && (
                    <p className="text-[11px] text-accent">
                      {pickedSlot + 1}번 자리를 고른 상태 — 아래에서 캐릭터를 누르면 이 자리에
                      앉습니다. 이미 다른 자리에 앉은 캐릭터를 골라도 됩니다.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* 이 씬에 들어간 캐릭터 */}
            <div>
              <p className="mb-1.5 text-[12px] font-medium text-muted">이 씬의 캐릭터</p>
              {picked.length === 0 ? (
                <p className="text-[11.5px] text-faint">아래에서 캐릭터를 골라 넣으세요.</p>
              ) : (
                <div className="flex flex-col gap-1">
                  {picked.map((c, i) => {
                    const seats = seatsOf(c.id)
                    const center = centerOf(c)
                    const overridden = !!positions?.[c.id]
                    return (
                      <div
                        key={c.id}
                        className={cn(
                          'flex items-center gap-2 rounded-md border px-1.5 py-1 transition-colors',
                          selectedId === c.id
                            ? 'border-accent bg-accent-soft'
                            : 'border-line bg-surface-2'
                        )}
                        onClick={() => pickChar(c.id)}
                      >
                        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-paper font-mono text-[10px] text-muted">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px]">
                          {charLabel(c, i)}
                          {charTags?.[c.id]?.trim() && (
                            <span className="ml-1 text-[10px] text-accent" title={charTags[c.id]}>
                              +태그
                            </span>
                          )}
                        </span>
                        {seats.length > 0 ? (
                          <span
                            className={cn(
                              'shrink-0 font-mono text-[10.5px] tabular-nums',
                              seats.length > 1 ? 'text-emerald-500' : 'text-faint'
                            )}
                            title={
                              seats.length > 1
                                ? '같은 카드가 여러 자리에 앉아 그 수만큼 그려집니다'
                                : '앉은 자리'
                            }
                          >
                            자리 {seats.map((s) => s + 1).join('·')}
                          </span>
                        ) : (
                          <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
                            {center.x.toFixed(2)},{center.y.toFixed(2)}
                            {!overridden && <span className="ml-1">(미지정)</span>}
                          </span>
                        )}
                        {overridden && seats.length === 0 && (
                          <button
                            className="grid size-5 shrink-0 place-items-center rounded text-faint hover:text-ink"
                            title="위치 지정 지우기"
                            onClick={(e) => {
                              e.stopPropagation()
                              resetPos(c.id)
                            }}
                          >
                            <RotateCcw size={11} />
                          </button>
                        )}
                        <button
                          className="shrink-0 rounded px-1 text-[11px] text-faint hover:text-danger"
                          title="이 씬에서 빼기"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeChar(c.id)
                          }}
                        >
                          빼기
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>

            {/* 넣을 캐릭터 고르기 */}
            <div className="min-h-0 flex-1">
              <p className="mb-1.5 text-[12px] font-medium text-muted">캐릭터 넣기</p>
              <div className="flex max-h-[240px] flex-wrap gap-1 overflow-auto">
                {items.map((c, i) => {
                  const on = characterIds.includes(c.id)
                  return (
                    <button
                      key={c.id}
                      className={cn(
                        'flex items-center gap-1 rounded-md border px-2 py-1 text-[11.5px] transition-colors',
                        on
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-line text-muted hover:bg-surface-2'
                      )}
                      onClick={() =>
                        pickedSlot != null ? assignToSlot(pickedSlot, c.id) : toggleChar(c.id)
                      }
                    >
                      {c.thumbnail ? (
                        <img
                          src={`data:image/webp;base64,${c.thumbnail}`}
                          className="size-4 rounded-full object-cover"
                          alt=""
                        />
                      ) : (
                        <User size={11} />
                      )}
                      {charLabel(c, i)}
                      {pickedSlot != null ? <Plus size={11} /> : on ? <Check size={11} /> : <Plus size={11} />}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {figures > caps.maxCharacters && (
          <p className="mt-2 text-[11.5px] text-danger">
            인물이 {figures}명이라 앞에서 {caps.maxCharacters}명까지만 생성에 들어갑니다.
          </p>
        )}
        {!useCoords && picked.length > 0 && (
          <p className="mt-2 text-[11.5px] text-muted">
            위치 적용이 꺼져 있어 지금 배치는 생성에 반영되지 않습니다. 오른쪽 위 스위치를 켜세요.
            (자리 태그·이 씬 태그는 위치와 상관없이 붙습니다)
          </p>
        )}

        <div className="mt-3 flex justify-end">
          <Button size="sm" onClick={() => onOpenChange(false)}>
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
