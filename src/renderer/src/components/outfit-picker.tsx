import type { CharacterCard } from '@shared/types'
import { activePieces, pieceDefaultOn, togglePiece, type OutfitChoice } from '@shared/outfit'
import { isNudePiece, undressOutfit } from '@shared/nude-strip'
import { neededAreas, triggerAreas, type ExposeArea } from '@shared/auto-expose'
import { cn } from '../lib/utils'
import { useOutfitsStore } from '../stores/outfits-store'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

/**
 * 씬에서 캐릭터에게 옷 입히기 (커스텀) — 복장 고르기 + 조각 켜고 끄기.
 *
 * 고르지 않으면 카드의 기본 복장을 입는다. 조각을 누르면 그 씬에서만 켜지고 꺼진다 —
 * 기본 조각을 끄면 벗고, 꺼진 상태 조각을 켜면 그 상태가 된다.
 * nsfw 아래·가슴 조각은 씬 태그를 보고 저절로 켜지고, 누르면 이 씬에서만 반대로 된다.
 */
export function OutfitPicker({
  card,
  choice,
  sceneContexts,
  partnerContexts = [],
  onChange
}: {
  card: CharacterCard
  choice: OutfitChoice | undefined
  /** 이 씬에서 이 캐릭터에게 걸린 장면 태그 — nsfw 조각이 켜질지 본다. 없으면 씬을 모름 (큐 항목) */
  sceneContexts?: string[]
  /** 당하는쪽이면 하는쪽 태그 — 하는쪽이 상대 몸에 하는 행위도 조각을 켠다 */
  partnerContexts?: string[]
  onChange: (choice: OutfitChoice | undefined) => void
}): React.JSX.Element {
  const items = useOutfitsStore((s) => s.items)
  const stripOnNude = useOutfitsStore((s) => s.stripOnNude)
  const kinds = useOutfitsStore((s) => s.kinds)
  const acts = useOutfitsStore((s) => s.acts)
  const cardOutfit = items.find((o) => o.id === card.outfitId)
  // 고른 복장이 지워졌으면 생성도 카드 기본으로 물러난다 (resolveOutfitTags) — 화면도 같게
  const chosenId = choice?.outfitId
  const chosen = chosenId != null ? items.find((o) => o.id === chosenId) : undefined
  if (choice && !chosen) choice = undefined
  const outfit = chosen ?? cardOutfit
  // 카드 기본 복장을 그대로 입는 중이면 조각 켜고 끈 기록도 없다
  const current: OutfitChoice | undefined = choice ?? (outfit ? { outfitId: outfit.id } : undefined)
  // nsfw 조각이 켜지는 부위 — 생성과 같은 규칙 (triggerAreas). 씬을 모르면 따지지 않는다
  const auto = sceneContexts
    ? triggerAreas(sceneContexts, acts, current, partnerContexts)
    : undefined
  const need: Partial<Record<ExposeArea, string>> = sceneContexts
    ? neededAreas(sceneContexts, acts)
    : {}
  const autoOn = current?.auto !== false
  const active = outfit ? new Set(activePieces(outfit, current, auto).map((p) => p.id)) : new Set()
  // 실제로 붙는 옷 태그 — nsfw(누드) 조각을 켜면 다른 조각의 몸 옷이 빠진 채로 보여준다
  const worn = outfit
    ? undressOutfit(outfit, current, stripOnNude, (tag) => kinds[tag] ?? 'unknown', auto)
    : ''
  /** nsfw 조각 설명 — 이 씬에서 저절로 켜지는지와 그 까닭 */
  const triggerNote = (when: 'nsfw-lower' | 'nsfw-chest', byDefault: boolean): string => {
    const area = when === 'nsfw-lower' ? '아래가' : '가슴이'
    if (!sceneContexts) return `${area} 드러나는 장면이면 씬마다 저절로 켜짐`
    if (!autoOn) return '이 씬은 nsfw 조각 자동 켜기를 꺼서 저절로 켜지지 않음'
    return byDefault
      ? `이 씬은 ${area} 드러나는 장면이라 저절로 켜짐`
      : `이 씬은 ${area} 드러나는 장면이 아니라 저절로 켜지지 않음`
  }

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
              // 이 씬에서 따로 안 눌러도 켜지는지 — 기본 조각이거나 장면이 맞는 nsfw 조각
              const byDefault = pieceDefaultOn(p, auto)
              const when = p.on ? undefined : p.when
              return (
                <button
                  key={p.id}
                  title={when ? `${p.tags}\n${triggerNote(when, byDefault)}` : p.tags}
                  className={cn(
                    'rounded-md border px-2 py-0.5 text-[11.5px] transition-colors',
                    on
                      ? byDefault
                        ? 'border-emerald-500/60 bg-emerald-500/15 text-ink'
                        : 'border-accent bg-accent-soft text-ink'
                      : 'border-line text-faint line-through decoration-faint/60 hover:text-muted'
                  )}
                  onClick={() => current && onChange(togglePiece(outfit, current, p.id, auto))}
                >
                  {when ? (
                    <span className="mr-1 font-medium text-danger">
                      nsfw {when === 'nsfw-lower' ? '아래' : '가슴'}
                    </span>
                  ) : (
                    isNudePiece(p.tags) && (
                      <span className="mr-1 font-medium text-danger">nsfw</span>
                    )
                  )}
                  {p.name || p.tags || '(이름 없음)'}
                  {when && byDefault && (
                    <span className="ml-1 text-[10px] text-emerald-500">자동</span>
                  )}
                </button>
              )
            })}
          </div>
          <p className="truncate text-[11px] text-faint" title={worn}>
            {worn || '켜진 조각이 없어 옷 태그가 붙지 않습니다'}
          </p>
          {outfit.pieces.some((p) => !p.on && p.when) && (
            // nsfw 조각 자동 켜기 — 씬 태그를 보고 nsfw 아래·가슴 조각을 켤지 (씬마다 끌 수 있다)
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <button
                className={cn(
                  'shrink-0 rounded px-1.5 py-0.5 font-medium transition-colors',
                  autoOn ? 'bg-emerald-500 text-white' : 'bg-paper text-faint hover:text-muted'
                )}
                title="씬 태그를 보고 nsfw 아래·가슴 조각을 저절로 켭니다"
                onClick={() =>
                  current &&
                  onChange({ ...current, ...(autoOn ? { auto: false } : { auto: undefined }) })
                }
              >
                nsfw 조각 자동 켜기 {autoOn ? '켬' : '끔'}
              </button>
              <span className="min-w-0 text-faint">
                {!sceneContexts
                  ? '씬마다 씬 태그를 보고 켭니다'
                  : !autoOn
                    ? '이 씬에선 직접 켠 조각만 켜집니다'
                    : need.lower || need.chest
                      ? `이 씬: ${[
                          need.lower && `아래(${need.lower})`,
                          need.chest && `가슴(${need.chest})`
                        ]
                          .filter(Boolean)
                          .join(' · ')}`
                      : '이 씬엔 아래·가슴이 드러나는 장면 태그가 없습니다'}
              </span>
            </div>
          )}
          {outfit.negative?.trim() && (
            <p className="truncate text-[11px] text-faint" title={outfit.negative}>
              <span className="text-danger/80">네거티브</span> {outfit.negative}
            </p>
          )}
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
