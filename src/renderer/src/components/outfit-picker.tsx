import type { CharacterCard } from '@shared/types'
import { activePieces, outfitTags, togglePiece, type OutfitChoice } from '@shared/outfit'
import { cn } from '../lib/utils'
import { useOutfitsStore } from '../stores/outfits-store'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/**
 * 씬에서 캐릭터에게 옷 입히기 (커스텀) — 복장 고르기 + 조각 켜고 끄기.
 *
 * 고르지 않으면 카드의 기본 복장을 입는다. 조각을 누르면 그 씬에서만 켜지고 꺼진다 —
 * 기본 조각을 끄면 벗고, 꺼진 상태 조각을 켜면 그 상태가 된다.
 */
export function OutfitPicker({
  card,
  choice,
  onChange
}: {
  card: CharacterCard
  choice: OutfitChoice | undefined
  onChange: (choice: OutfitChoice | undefined) => void
}): React.JSX.Element {
  const items = useOutfitsStore((s) => s.items)
  const cardOutfit = items.find((o) => o.id === card.outfitId)
  // 고른 복장이 지워졌으면 생성도 카드 기본으로 물러난다 (resolveOutfitTags) — 화면도 같게
  const chosenId = choice?.outfitId
  const chosen = chosenId != null ? items.find((o) => o.id === chosenId) : undefined
  if (choice && !chosen) choice = undefined
  const outfit = chosen ?? cardOutfit
  // 카드 기본 복장을 그대로 입는 중이면 조각 켜고 끈 기록도 없다
  const current: OutfitChoice | undefined = choice ?? (outfit ? { outfitId: outfit.id } : undefined)
  const active = outfit ? new Set(activePieces(outfit, current).map((p) => p.id)) : new Set()

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] font-medium text-muted">복장</span>
        <Select
          value={choice ? String(choice.outfitId) : 'default'}
          onValueChange={(v) => onChange(v === 'default' ? undefined : { outfitId: Number(v) })}
        >
          <SelectTrigger className="h-7 w-52 text-[12px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">
              카드 기본{cardOutfit ? ` (${cardOutfit.name})` : ' (복장 없음)'}
            </SelectItem>
            {items.map((o) => (
              <SelectItem key={o.id} value={String(o.id)}>
                {o.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {choice && (
          <span className="text-[11px] text-faint">이 씬에서만 · 다른 씬은 카드 기본 그대로</span>
        )}
      </div>

      {outfit ? (
        <>
          <div className="flex flex-wrap gap-1">
            {outfit.pieces.map((p) => {
              const on = active.has(p.id)
              return (
                <button
                  key={p.id}
                  title={p.tags}
                  className={cn(
                    'rounded-md border px-2 py-0.5 text-[11.5px] transition-colors',
                    on
                      ? p.on
                        ? 'border-emerald-500/60 bg-emerald-500/15 text-ink'
                        : 'border-accent bg-accent-soft text-ink'
                      : 'border-line text-faint line-through decoration-faint/60 hover:text-muted'
                  )}
                  onClick={() => current && onChange(togglePiece(outfit, current, p.id))}
                >
                  {p.name || p.tags || '(이름 없음)'}
                </button>
              )
            })}
          </div>
          <p className="truncate text-[11px] text-faint" title={outfitTags(outfit, current)}>
            {outfitTags(outfit, current) || '켜진 조각이 없어 옷 태그가 붙지 않습니다'}
          </p>
        </>
      ) : (
        <p className="text-[11px] text-faint">
          복장 없이 카드 태그 그대로 나갑니다. 카드에 옷 태그가 섞여 있으면 캐릭터 창에서 &lsquo;옷
          떼어내기&rsquo;로 복장을 만들 수 있습니다.
        </p>
      )}
    </div>
  )
}
