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
 * 좌표는 씬 전용 오버라이드(positions)에만 쓴다 — 캐릭터 카드의 기본 좌표는
 * 건드리지 않는다. 아직 지정하지 않은 캐릭터는 카드 기본값을 (기본)으로 보여준다.
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
  onPatch
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  characterIds: number[]
  positions?: CharPositions
  useCoords?: boolean
  onPatch: (patch: {
    characterIds?: number[]
    positions?: CharPositions
    useCoords?: boolean
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
            chars={picked.map((c, i) => ({
              id: c.id,
              label: charLabel(c, i),
              center: centerOf(c),
              thumbnail: c.thumbnail || undefined,
              isDefault: !positions?.[c.id]
            }))}
            width={request.width}
            height={request.height}
            freeform={caps.freeformCharacterPosition}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMove={setPos}
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
                      onClick={() => toggleChar(c.id)}
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
