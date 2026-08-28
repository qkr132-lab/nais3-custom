import { useMemo, useState } from 'react'
import { Crosshair } from 'lucide-react'
import type { CharacterCard } from '@shared/types'
import { modelCaps } from '@shared/nai-models'
import { cn } from '../lib/utils'
import { useCharactersStore } from '../stores/characters-store'
import { useSceneExtrasStore } from '../stores/scene-extras-store'
import { toast } from '../stores/toast-store'
import { useGenerationStore } from '../stores/generation-store'
import { PlacementCanvas, distributed } from './placement-canvas'
import { PromptEditor } from './prompt-editor'
import { Button } from './ui/button'
import { Switch } from './ui/switch'

/**
 * 캐릭터 배치판 (커스텀) — 상단 '배치' 탭의 알맹이.
 *
 * 캐릭터 카드마다 팝오버를 열어 좌표를 하나씩 찍던 방식은 여러 명을 한 화면에
 * 놓고 볼 수가 없어 만화·다인 구도에서 쓰기 어려웠다. 여기서는 활성 캐릭터 전원을
 * 실제 생성 비율의 판 위에 올려놓고 끌어서 배치하고, 고른 캐릭터의 프롬프트를
 * 바로 옆에서 넉넉한 칸으로 고친다.
 */

function label(char: CharacterCard, index: number): string {
  const name = char.name.trim() || char.prompt.split(',')[0]?.trim() || `캐릭터 ${index + 1}`
  return name.length > 12 ? name.slice(0, 12) + '…' : name
}

export function CompositionBoard(): React.JSX.Element {
  const items = useCharactersStore((s) => s.items)
  const updateCard = useCharactersStore((s) => s.updateCard)
  const setCenterLive = useCharactersStore((s) => s.setCenterLive)
  const request = useGenerationStore((s) => s.request)
  const patch = useGenerationStore((s) => s.patchRequest)
  const caps = modelCaps(request.model)

  const chars = useMemo(() => items.filter((c) => c.enabled && c.prompt.trim()), [items])
  const clearCoordOverrides = useSceneExtrasStore((s) => s.clearCoordOverrides)
  // 항목 배열/맵을 직접 구독해 오버라이드 수를 파생 (끄면 배너가 바로 사라지게)
  const extrasEntries = useSceneExtrasStore((s) => s.entries)
  const extrasAdditions = useSceneExtrasStore((s) => s.additions)
  const overrides = useMemo(() => {
    let additions = 0
    for (const scenes of Object.values(extrasAdditions))
      for (const a of Object.values(scenes)) if (a.useCoords !== undefined) additions++
    return { additions, entries: extrasEntries.filter((e) => e.useCoords !== undefined).length }
  }, [extrasEntries, extrasAdditions])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const selected = chars.find((c) => c.id === selectedId) ?? chars[0] ?? null

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-medium">
        <span>캐릭터 배치</span>
        <span className="font-mono text-[11px] text-faint">
          {chars.length}/{caps.maxCharacters}
        </span>
        <span className="text-[11.5px] font-normal text-muted">
          {caps.freeformCharacterPosition ? '자유 배치 (V5)' : '5×5 격자 (V4.5)'}
        </span>
        <label className="ml-auto flex shrink-0 items-center gap-1.5 text-[11.5px] font-normal text-muted">
          위치 지정
          <Switch checked={request.useCoords} onCheckedChange={(v) => patch({ useCoords: v })} />
        </label>
      </div>

      <div className="flex min-h-0 flex-1 flex-wrap gap-4">
        <PlacementCanvas
          chars={chars.map((c, i) => ({
            id: c.id,
            label: label(c, i),
            center: c.center,
            thumbnail: c.thumbnail || undefined
          }))}
          width={request.width}
          height={request.height}
          freeform={caps.freeformCharacterPosition}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          onMove={setCenterLive}
          onDistribute={(axis) =>
            chars.forEach((c, i) =>
              updateCard(c.id, { center: distributed(chars.length, i, axis) })
            )
          }
        />

        <div className="flex min-h-0 min-w-[280px] flex-1 flex-col gap-2">
          {selected ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[12.5px] font-medium">
                  {label(selected, chars.indexOf(selected))}
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
                    {i + 1}. {label(c, i)}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="grid flex-1 place-items-center text-[12.5px] text-faint">
              캐릭터 창에서 캐릭터를 켜면 여기에서 배치할 수 있습니다
            </div>
          )}
        </div>
      </div>

      {!request.useCoords && chars.length > 0 && (
        <p className="mt-2 text-[11.5px] text-muted">
          위치 지정이 꺼져 있어 지금 배치는 생성에 반영되지 않습니다. 오른쪽 위 스위치를 켜세요.
        </p>
      )}

      {/* 전역을 꺼도 위치가 계속 적용되는 요인 — 숨어 있으면 "껐는데 유지된다"로 보인다 */}
      {!request.useCoords && (overrides.additions > 0 || overrides.entries > 0) && (
        <p className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-[11.5px] text-muted">
          <span>
            이 스위치는 메인 탭 전용입니다. 씬별 추가 {overrides.additions}건 · 큐 반복{' '}
            {overrides.entries}건에 <b className="text-ink">위치 적용</b>이 켜져 있어 그 씬들은
            좌표를 씁니다.
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px] text-danger"
            onClick={() => {
              clearCoordOverrides()
              toast('씬별·큐 반복의 위치 적용 오버라이드를 모두 껐습니다', 'success')
            }}
          >
            전부 끄기
          </Button>
        </p>
      )}
      {!request.useCoords && (
        <p className="mt-1 text-[11px] text-faint">
          씬에 하는쪽/당하는쪽 역할 위치를 지정해 뒀다면 그 씬도 좌표가 강제로 켜집니다 — 씬 우클릭
          → 역할 위치에서 해제하세요.
        </p>
      )}
    </div>
  )
}
