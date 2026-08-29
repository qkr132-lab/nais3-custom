import { useState } from 'react'
import { Check, Plus, RotateCcw, User } from 'lucide-react'
import type { CharPositions, CharacterCard } from '@shared/types'
import { modelCaps } from '@shared/nai-models'
import { cn } from '../lib/utils'
import { useCharactersStore } from '../stores/characters-store'
import { useGenerationStore } from '../stores/generation-store'
import { PlacementCanvas, distributed } from './placement-canvas'
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
 * 나중에 자리를 골라 캐릭터를 꽂는다. 배정된 캐릭터는 그 자리 좌표로 생성된다.
 */

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
  onPatch
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  characterIds: number[]
  positions?: CharPositions
  useCoords?: boolean
  /** 미리 잡아둔 자리 */
  slots?: { x: number; y: number }[]
  /** 캐릭터 id → 자리 번호 */
  slotOf?: Record<number, number>
  onPatch: (patch: {
    characterIds?: number[]
    positions?: CharPositions
    useCoords?: boolean
    slots?: { x: number; y: number }[]
    slotOf?: Record<number, number>
  }) => void
}): React.JSX.Element {
  const items = useCharactersStore((s) => s.items)
  const request = useGenerationStore((s) => s.request)
  const caps = modelCaps(request.model)
  const [selectedId, setSelectedId] = useState<number | null>(null)

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
  const assign = slotOf ?? {}
  // 자리 → 그 자리에 배정된 캐릭터
  const charAtSlot = (index: number): CharacterCard | undefined =>
    picked.find((c) => assign[c.id] === index)
  const [pickedSlot, setPickedSlot] = useState<number | null>(null)

  const addSlot = (): void => {
    // 새 자리는 가로로 고르게 — n+1개를 균등 배치한 마지막 자리
    const next = [...slotList, { x: 0.5, y: 0.5 }]
    onPatch({ slots: next.map((_, i) => distributed(next.length, i, 'x')) })
  }

  const removeSlot = (index: number): void => {
    const next = slotList.filter((_, i) => i !== index)
    // 배정 재정렬: 지운 자리보다 뒤 번호는 하나씩 당긴다
    const nextAssign: Record<number, number> = {}
    for (const [id, at] of Object.entries(assign)) {
      if (at === index) continue
      nextAssign[Number(id)] = at > index ? at - 1 : at
    }
    onPatch({ slots: next, slotOf: nextAssign })
    setPickedSlot(null)
  }

  const moveSlot = (index: number, center: { x: number; y: number }): void =>
    onPatch({ slots: slotList.map((s, i) => (i === index ? center : s)) })

  /** 고른 자리에 캐릭터를 꽂는다 (씬에 없으면 함께 추가) */
  const assignToSlot = (index: number, charId: number): void => {
    const nextAssign: Record<number, number> = {}
    // 한 자리엔 한 명 — 기존 배정자는 자리에서 빠진다
    for (const [id, at] of Object.entries(assign)) {
      if (at === index || Number(id) === charId) continue
      nextAssign[Number(id)] = at
    }
    nextAssign[charId] = index
    onPatch({
      slotOf: nextAssign,
      ...(characterIds.includes(charId) ? {} : { characterIds: [...characterIds, charId] })
    })
    setPickedSlot(null)
  }

  const clearSlot = (index: number): void => {
    const nextAssign: Record<number, number> = {}
    for (const [id, at] of Object.entries(assign)) if (at !== index) nextAssign[Number(id)] = at
    onPatch({ slotOf: nextAssign })
  }

  const toggleChar = (id: number): void =>
    onPatch({
      characterIds: characterIds.includes(id)
        ? characterIds.filter((x) => x !== id)
        : [...characterIds, id]
    })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[min(1000px,94vw)] max-w-none flex-col p-5">
        <DialogTitle className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1">
          씬 캐릭터 배치
          <span className="font-mono text-[11px] font-normal text-faint">
            {picked.length}/{caps.maxCharacters}
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
          <PlacementCanvas
            chars={[
              // 자리 — 음수 id로 구분. 비었으면 번호만, 차 있으면 캐릭터 이름
              ...slotList.map((pos, i) => {
                const occupant = charAtSlot(i)
                return {
                  id: -(i + 1),
                  label: occupant ? `${i + 1}. ${charLabel(occupant, i)}` : `${i + 1}. 빈 자리`,
                  center: pos,
                  thumbnail: occupant?.thumbnail || undefined
                }
              }),
              // 자리에 배정되지 않은 캐릭터만 따로
              ...picked
                .filter((c) => assign[c.id] === undefined)
                .map((c, i) => ({
                  id: c.id,
                  label: charLabel(c, i),
                  center: centerOf(c),
                  thumbnail: c.thumbnail || undefined,
                  isDefault: !positions?.[c.id]
                }))
            ]}
            width={request.width}
            height={request.height}
            freeform={caps.freeformCharacterPosition}
            selectedId={pickedSlot != null ? -(pickedSlot + 1) : selectedId}
            onSelect={(id) => {
              if (id < 0) setPickedSlot(-id - 1)
              else {
                setPickedSlot(null)
                setSelectedId(id)
              }
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
            maxHeight="min(52vh, 460px)"
          />

          <div className="flex min-h-0 min-w-[260px] flex-1 flex-col gap-3">
            {/* 미리 잡아둔 자리 — 캐릭터 없이 위치·인원부터 정한다 */}
            <div>
              <p className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-muted">
                자리
                <span className="font-mono text-[11px] text-faint">{slotList.length}명</span>
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
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
                          {pos.x.toFixed(2)},{pos.y.toFixed(2)}
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
                      들어갑니다.
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
                        onClick={() => setSelectedId(c.id)}
                      >
                        <span className="grid size-5 shrink-0 place-items-center rounded-full bg-paper font-mono text-[10px] text-muted">
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[11.5px]">
                          {charLabel(c, i)}
                        </span>
                        <span className="shrink-0 font-mono text-[10.5px] tabular-nums text-faint">
                          {center.x.toFixed(2)},{center.y.toFixed(2)}
                          {!overridden && <span className="ml-1">(미지정)</span>}
                        </span>
                        {overridden && (
                          <button
                            className="grid size-5 shrink-0 place-items-center rounded text-faint hover:text-ink"
                            title="카드 기본 위치로 되돌리기"
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
                            toggleChar(c.id)
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
                      {on ? <Check size={11} /> : <Plus size={11} />}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>

        {!useCoords && picked.length > 0 && (
          <p className="mt-2 text-[11.5px] text-muted">
            위치 적용이 꺼져 있어 지금 배치는 생성에 반영되지 않습니다. 오른쪽 위 스위치를 켜세요.
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
