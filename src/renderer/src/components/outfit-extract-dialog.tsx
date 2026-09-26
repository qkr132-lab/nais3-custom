import { useEffect, useState } from 'react'
import type { CharacterCard } from '@shared/types'
import type { TagKind } from '@shared/outfit'
import { cn } from '../lib/utils'
import { useCharactersStore } from '../stores/characters-store'
import { useOutfitsStore } from '../stores/outfits-store'
import { toast } from '../stores/toast-store'
import { pushUndo } from '../stores/undo-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'

/**
 * 카드에서 옷 떼어내기 (커스텀).
 *
 * 카드 태그를 하나씩 보여주고, 앱이 옷·알몸으로 본 것은 "복장으로", 나머지는 "카드에 남김"으로
 * 미리 정해둔다. 누르면 바뀐다. 확인하면 복장을 만들고, 카드엔 남긴 태그만 두고,
 * 그 복장을 카드의 기본 복장으로 건다 — 그래서 생성 결과는 떼어내기 전과 같다
 * (옷 태그 자리가 몸 태그 뒤로 옮겨지는 것만 다르다). Ctrl+Z로 되돌린다.
 */
export function OutfitExtractDialog({
  card,
  onClose
}: {
  card: CharacterCard | null
  onClose: () => void
}): React.JSX.Element {
  const updateCard = useCharactersStore((s) => s.updateCard)
  const createOutfit = useOutfitsStore((s) => s.create)
  const removeOutfit = useOutfitsStore((s) => s.remove)
  const [tokens, setTokens] = useState<{ token: string; kind: TagKind; label: string }[]>([])
  const [toOutfit, setToOutfit] = useState<Set<number>>(new Set())
  const [hasData, setHasData] = useState(true)
  // 입력 전엔 "카드 이름 + 복장"을 보여준다 (카드가 바뀔 때 상태를 다시 맞추지 않아도 되게)
  const [nameInput, setNameInput] = useState<string | null>(null)
  const name = nameInput ?? `${card?.name.trim() || '캐릭터'} 복장`
  const setName = setNameInput
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!card) return
    void window.nais.invoke('outfits:analyzeCard', { charId: card.id }).then((r) => {
      setTokens(r.tokens)
      setHasData(r.hasData)
      setToOutfit(
        new Set(r.tokens.flatMap((t, i) => (t.kind === 'cloth' || t.kind === 'bare' ? [i] : [])))
      )
    })
  }, [card])

  const flip = (i: number): void => {
    const next = new Set(toOutfit)
    if (next.has(i)) next.delete(i)
    else next.add(i)
    setToOutfit(next)
  }

  const kept = tokens.filter((_, i) => !toOutfit.has(i))
  const moved = tokens.filter((_, i) => toOutfit.has(i))

  const apply = async (): Promise<void> => {
    if (!card || !moved.length) return
    setBusy(true)
    const before = { prompt: card.prompt, outfitId: card.outfitId }
    // 태그(또는 가중치 묶음) 하나가 조각 하나 — 전부 기본으로 켜서 지금 모습 그대로
    const outfitId = await createOutfit(
      name,
      moved.map((t, i) => ({ id: `p${i + 1}`, name: t.label || t.token, tags: t.token, on: true }))
    )
    updateCard(card.id, { prompt: kept.map((t) => t.token).join(', '), outfitId })
    pushUndo(`옷 떼어내기: ${card.name || '캐릭터'}`, async () => {
      updateCard(card.id, before)
      await removeOutfit(outfitId)
    })
    setBusy(false)
    toast(`'${name}' 복장을 만들고 카드에 기본 복장으로 걸었습니다 (Ctrl+Z로 되돌리기)`, 'success')
    close()
  }

  const close = (): void => {
    setNameInput(null)
    onClose()
  }

  const chip = (t: { token: string; kind: TagKind; label: string }, i: number): React.JSX.Element => (
    <button
      key={i}
      title={t.label ? `${t.token} — ${t.label}` : t.token}
      className={cn(
        'rounded-md border px-2 py-0.5 text-left text-[11.5px] transition-colors',
        toOutfit.has(i)
          ? t.kind === 'bare'
            ? 'border-violet-500/60 bg-violet-500/15'
            : 'border-emerald-500/60 bg-emerald-500/15'
          : 'border-line bg-surface-2 hover:border-accent'
      )}
      onClick={() => flip(i)}
    >
      <span className="font-mono">{t.token}</span>
      {t.label && <span className="ml-1 text-[10.5px] text-faint">{t.label}</span>}
    </button>
  )

  return (
    <Dialog open={!!card} onOpenChange={(o) => !o && close()}>
      <DialogContent className="flex max-h-[86vh] w-[min(760px,94vw)] max-w-none flex-col p-5">
        <DialogTitle className="mb-2">옷 떼어내기</DialogTitle>
        <p className="mb-3 text-[11.5px] text-muted">
          태그를 누르면 &lsquo;카드에 남김&rsquo;과 &lsquo;복장으로&rsquo;가 바뀝니다. 옮긴 태그는
          전부 켜진 조각이 되고, 이 복장이 카드의 기본 복장으로 걸려서 생성 결과는 지금과 같습니다.
          {!hasData && (
            <span className="text-danger">
              {' '}
              태그 분류 자료가 없어 흔한 옷 이름만 알아봤습니다 — 빠진 옷은 직접 눌러 옮기세요.
            </span>
          )}
        </p>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
          <section>
            <p className="mb-1 text-[12px] font-medium text-muted">
              카드에 남김 <span className="font-mono text-faint">{kept.length}</span>
            </p>
            <div className="flex flex-wrap gap-1">
              {tokens.map((t, i) => (toOutfit.has(i) ? null : chip(t, i)))}
            </div>
          </section>
          <section>
            <p className="mb-1 text-[12px] font-medium text-muted">
              복장으로 <span className="font-mono text-faint">{moved.length}</span>
              <span className="ml-1.5 text-[11px] font-normal text-faint">
                초록 = 옷 · 보라 = 알몸·노출
              </span>
            </p>
            <div className="flex flex-wrap gap-1">
              {tokens.map((t, i) => (toOutfit.has(i) ? chip(t, i) : null))}
              {!moved.length && (
                <span className="text-[11.5px] text-faint">옮길 태그를 위에서 누르세요</span>
              )}
            </div>
          </section>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-[12px] text-muted">복장 이름</span>
          <Input
            className="h-8 w-56 text-[12.5px]"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={close}>
            취소
          </Button>
          <Button size="sm" disabled={busy || !moved.length} onClick={() => void apply()}>
            떼어내기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
