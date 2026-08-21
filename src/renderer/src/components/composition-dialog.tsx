import { useCallback, useMemo, useRef, useState } from 'react'
import { AlignVerticalJustifyCenter, AlignHorizontalJustifyCenter, Crosshair } from 'lucide-react'
import type { CharacterCard } from '@shared/types'
import { modelCaps } from '@shared/nai-models'
import { cn } from '../lib/utils'
import { useCharactersStore } from '../stores/characters-store'
import { useGenerationStore } from '../stores/generation-store'
import { POSITION_GRID } from './position-picker'
import { PromptEditor } from './prompt-editor'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Switch } from './ui/switch'

/**
 * 캐릭터 배치 종합 창 (커스텀).
 *
 * 캐릭터 카드마다 팝오버를 열어 좌표를 하나씩 찍던 방식은, 여러 명을 한 화면에
 * 놓고 볼 수가 없어 만화·다인 구도에서 쓰기 어려웠다. 여기서는 활성 캐릭터 전원을
 * 실제 생성 비율의 캔버스 위에 올려놓고 끌어서 배치하고, 고른 캐릭터의 프롬프트를
 * 바로 옆에서 넉넉한 칸으로 고친다.
 *
 * V5는 자유 배치, V4.5는 5×5 격자만 허용하므로 모델에 따라 스냅 여부가 갈린다.
 */

function round3(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000
}

/** V4.5는 격자값으로 스냅 */
function snapToGrid(v: number): number {
  return POSITION_GRID.reduce((best, g) => (Math.abs(g - v) < Math.abs(best - v) ? g : best))
}

function shortLabel(char: CharacterCard, index: number): string {
  const name = char.name.trim() || char.prompt.split(',')[0]?.trim() || `캐릭터 ${index + 1}`
  return name.length > 10 ? name.slice(0, 10) + '…' : name
}

export function CompositionDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const items = useCharactersStore((s) => s.items)
  const updateCard = useCharactersStore((s) => s.updateCard)
  const setCenterLive = useCharactersStore((s) => s.setCenterLive)
  const request = useGenerationStore((s) => s.request)
  const patch = useGenerationStore((s) => s.patchRequest)
  const caps = modelCaps(request.model)
  const freeform = caps.freeformCharacterPosition

  const chars = useMemo(() => items.filter((c) => c.enabled && c.prompt.trim()), [items])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selected = chars.find((c) => c.id === selectedId) ?? chars[0] ?? null

  const boxRef = useRef<HTMLDivElement>(null)
  const draggingId = useRef<number | null>(null)

  const moveTo = useCallback(
    (id: number, clientX: number, clientY: number) => {
      const box = boxRef.current?.getBoundingClientRect()
      if (!box?.width || !box.height) return
      const x = (clientX - box.left) / box.width
      const y = (clientY - box.top) / box.height
      setCenterLive(
        id,
        freeform ? { x: round3(x), y: round3(y) } : { x: snapToGrid(x), y: snapToGrid(y) }
      )
    },
    [freeform, setCenterLive]
  )

  /** 세로/가로로 균등 배치 — 만화 컷처럼 줄 세울 때 */
  const distribute = (axis: 'x' | 'y'): void => {
    const n = chars.length
    if (!n) return
    chars.forEach((c, i) => {
      const p = round3((i + 0.5) / n)
      updateCard(c.id, { center: axis === 'y' ? { x: 0.5, y: p } : { x: p, y: 0.5 } })
    })
  }

  // 실제 생성 비율대로 캔버스를 그린다 (세로 만화면 세로로 길게)
  const ratio = request.width / request.height

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[86vh] w-[min(1040px,94vw)] max-w-none flex-col p-5">
        <DialogTitle className="mb-3 flex items-center gap-2">
          캐릭터 배치
          <span className="font-mono text-[11px] text-faint">
            {chars.length}/{caps.maxCharacters}
          </span>
          <span className="text-[11.5px] font-normal text-muted">
            {freeform ? '자유 배치 (V5)' : '5×5 격자 (V4.5)'}
          </span>
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-[11.5px] font-normal text-muted">
            좌표 사용
            <Switch checked={request.useCoords} onCheckedChange={(v) => patch({ useCoords: v })} />
          </label>
        </DialogTitle>

        <div className="flex min-h-0 flex-1 gap-4">
          {/* 캔버스 */}
          <div className="flex min-h-0 shrink-0 flex-col gap-2">
            <div
              className="relative overflow-hidden rounded-lg border border-line bg-paper"
              style={{ height: 'min(58vh, 520px)', aspectRatio: String(ratio) }}
              ref={boxRef}
              onPointerMove={(e) => {
                if (draggingId.current !== null) moveTo(draggingId.current, e.clientX, e.clientY)
              }}
              onPointerUp={() => {
                draggingId.current = null
              }}
            >
              {/* 삼분할 안내선 — 만화 컷 경계 가늠용 */}
              {[1 / 3, 2 / 3].map((f) => (
                <div
                  key={`v${f}`}
                  className="pointer-events-none absolute inset-y-0 w-px bg-line"
                  style={{ left: `${f * 100}%` }}
                />
              ))}
              {[1 / 3, 2 / 3].map((f) => (
                <div
                  key={`h${f}`}
                  className="pointer-events-none absolute inset-x-0 h-px bg-line"
                  style={{ top: `${f * 100}%` }}
                />
              ))}

              {chars.map((char, i) => {
                const isSel = selected?.id === char.id
                return (
                  <button
                    key={char.id}
                    className={cn(
                      'absolute flex -translate-x-1/2 -translate-y-1/2 cursor-grab items-center gap-1 rounded-full border py-0.5 pl-0.5 pr-2 text-[11px] shadow-sm transition-colors active:cursor-grabbing',
                      isSel
                        ? 'z-10 border-accent bg-accent text-white'
                        : 'border-line bg-surface-2 text-ink hover:border-accent'
                    )}
                    style={{ left: `${char.center.x * 100}%`, top: `${char.center.y * 100}%` }}
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId)
                      draggingId.current = char.id
                      setSelectedId(char.id)
                    }}
                    onPointerMove={(e) => {
                      if (draggingId.current === char.id) moveTo(char.id, e.clientX, e.clientY)
                    }}
                    onPointerUp={(e) => {
                      e.currentTarget.releasePointerCapture(e.pointerId)
                      draggingId.current = null
                    }}
                  >
                    <span
                      className={cn(
                        'grid size-5 shrink-0 place-items-center rounded-full font-mono text-[10px]',
                        isSel ? 'bg-white/25' : 'bg-paper text-muted'
                      )}
                    >
                      {i + 1}
                    </span>
                    {shortLabel(char, i)}
                  </button>
                )
              })}

              {!chars.length && (
                <div className="grid h-full place-items-center text-[12.5px] text-faint">
                  활성 캐릭터가 없습니다
                </div>
              )}
            </div>

            <div className="flex items-center gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-[11.5px]"
                title="세로로 균등 배치 (세로 만화 컷용)"
                onClick={() => distribute('y')}
              >
                <AlignVerticalJustifyCenter size={14} /> 세로 균등
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1 px-2 text-[11.5px]"
                title="가로로 균등 배치"
                onClick={() => distribute('x')}
              >
                <AlignHorizontalJustifyCenter size={14} /> 가로 균등
              </Button>
              <div className="flex-1" />
              <span className="font-mono text-[11px] text-faint">
                {request.width}×{request.height}
              </span>
            </div>
          </div>

          {/* 고른 캐릭터 편집 */}
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            {selected ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[12.5px] font-medium">
                    {shortLabel(selected, chars.indexOf(selected))}
                  </span>
                  <span className="flex items-center gap-1 font-mono text-[11px] text-faint">
                    <Crosshair size={12} />
                    <span className="inline-block w-[86px] tabular-nums">
                      {selected.center.x.toFixed(3)}, {selected.center.y.toFixed(3)}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => updateCard(selected.id, { center: { x: 0.5, y: 0.5 } })}
                  >
                    가운데
                  </Button>
                </div>
                <PromptEditor
                  autoGrow
                  className="max-h-[300px] min-h-[120px] bg-surface-2"
                  value={selected.prompt}
                  placeholder="girl, ..."
                  onValueChange={(v) => updateCard(selected.id, { prompt: v })}
                />
                <PromptEditor
                  negative
                  autoGrow
                  className="max-h-[200px] min-h-[64px] bg-surface-2"
                  value={selected.negativePrompt}
                  placeholder="캐릭터 네거티브"
                  onValueChange={(v) => updateCard(selected.id, { negativePrompt: v })}
                />
                <div className="flex flex-wrap gap-1">
                  {chars.map((c, i) => (
                    <button
                      key={c.id}
                      className={cn(
                        'rounded-md border px-2 py-1 text-[11.5px] transition-colors',
                        c.id === selected.id
                          ? 'border-accent bg-accent-soft text-accent'
                          : 'border-line text-muted hover:bg-surface-2'
                      )}
                      onClick={() => setSelectedId(c.id)}
                    >
                      {i + 1}. {shortLabel(c, i)}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="grid flex-1 place-items-center text-[12.5px] text-faint">
                캐릭터를 켜면 여기에서 배치할 수 있습니다
              </div>
            )}
          </div>
        </div>

        {!request.useCoords && chars.length > 0 && (
          <p className="mt-2 text-[11.5px] text-muted">
            좌표 사용이 꺼져 있어 지금 배치는 생성에 반영되지 않습니다. 위 스위치를 켜세요.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
