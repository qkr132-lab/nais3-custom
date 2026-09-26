import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, Plus, Shirt, Trash2, X } from 'lucide-react'
import { newPieceId, type Outfit, type OutfitPiece } from '@shared/outfit'
import { cn } from '../lib/utils'
import { askConfirm } from '../stores/dialog-store'
import { useOutfitsStore } from '../stores/outfits-store'
import { PromptEditor } from './prompt-editor'
import { Button } from './ui/button'
import { Input } from './ui/input'

/**
 * 복장 탭 (커스텀).
 *
 * 복장 = 조각 목록. 기본으로 켜진 조각이 평소 모습이고, 꺼진 조각은 씬에서 켤 수 있는 상태다.
 *   ☑ 재킷 · ☑ 셔츠 · ☑ 치마 · ☐ 지퍼 오픈 · ☐ 치마 들춤
 * 씬에서 재킷을 끄면 벗고, 치마 들춤을 켜면 들춘다. 태그는 조각마다 직접 적는다 —
 * 옷마다 맞는 상태가 달라서(치마엔 skirt lift, 바지엔 pants pull) 미리 채우지 않는다.
 */
export function OutfitMode(): React.JSX.Element {
  const items = useOutfitsStore((s) => s.items)
  const load = useOutfitsStore((s) => s.load)
  const create = useOutfitsStore((s) => s.create)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  const selected = items.find((o) => o.id === selectedId) ?? items[0] ?? null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 gap-4 overflow-hidden p-4">
      {/* 복장 목록 */}
      <div className="flex w-60 shrink-0 flex-col gap-2">
        <Button
          size="sm"
          className="gap-1.5"
          onClick={async () => setSelectedId(await create('새 복장'))}
        >
          <Plus size={14} /> 새 복장
        </Button>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto">
          {items.map((o) => (
            <button
              key={o.id}
              className={cn(
                'flex items-center gap-2 rounded-md border px-2.5 py-2 text-left transition-colors',
                selected?.id === o.id
                  ? 'border-accent bg-accent-soft'
                  : 'border-line bg-surface-2 hover:border-accent/50'
              )}
              onClick={() => setSelectedId(o.id)}
            >
              <Shirt size={14} className="shrink-0 text-muted" />
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{o.name}</span>
              <span className="shrink-0 font-mono text-[10.5px] text-faint">
                {o.pieces.filter((p) => p.on).length}/{o.pieces.length}
              </span>
            </button>
          ))}
          {items.length === 0 && (
            <p className="px-1 text-[11.5px] text-faint">
              복장이 없습니다. 새로 만들거나, 캐릭터 카드에서 &lsquo;옷 떼어내기&rsquo;로 만드세요.
            </p>
          )}
        </div>
      </div>

      {/* 조각 편집 */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        {selected ? (
          <OutfitEditor key={selected.id} outfit={selected} onDeleted={() => setSelectedId(null)} />
        ) : (
          <div className="grid flex-1 place-items-center text-[12.5px] text-faint">
            왼쪽에서 복장을 고르세요
          </div>
        )}
      </div>
    </div>
  )
}

function OutfitEditor({
  outfit,
  onDeleted
}: {
  outfit: Outfit
  onDeleted: () => void
}): React.JSX.Element {
  const update = useOutfitsStore((s) => s.update)
  const remove = useOutfitsStore((s) => s.remove)
  const duplicate = useOutfitsStore((s) => s.duplicate)
  const pieces = outfit.pieces

  const setPieces = (next: OutfitPiece[]): void => update(outfit.id, { pieces: next })
  const patchPiece = (id: string, patch: Partial<OutfitPiece>): void =>
    setPieces(pieces.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  const addPiece = (piece: Omit<OutfitPiece, 'id'>): void =>
    setPieces([...pieces, { ...piece, id: newPieceId(pieces) }])
  const move = (index: number, dir: -1 | 1): void => {
    const to = index + dir
    if (to < 0 || to >= pieces.length) return
    const next = [...pieces]
    ;[next[index], next[to]] = [next[to], next[index]]
    setPieces(next)
  }

  const onDelete = async (): Promise<void> => {
    const { cards } = await window.nais.invoke('outfits:usage', { id: outfit.id })
    const ok = await askConfirm(`'${outfit.name}' 삭제`, {
      message: cards
        ? `이 복장을 기본으로 입는 캐릭터가 ${cards}명 있습니다. 지우면 그 캐릭터들은 옷 없이 카드 태그만으로 나갑니다.`
        : '이 복장을 지웁니다.',
      confirmLabel: '삭제',
      danger: true
    })
    if (!ok) return
    await remove(outfit.id)
    onDeleted()
  }

  // 그 옷에 맞는 상태 후보 — 기본으로 켜진 조각(평소 옷)의 태그 기준
  const wornTags = useMemo(
    () =>
      pieces
        .filter((p) => p.on)
        .flatMap((p) => p.tags.split(','))
        .map((t) =>
          t
            .trim()
            .replace(/^-?\d*\.?\d+::|::$/g, '')
            .trim()
        )
        .filter(Boolean),
    [pieces]
  )
  const [candidates, setCandidates] = useState<{ tag: string; ko: string; count: number }[]>([])
  useEffect(() => {
    if (!wornTags.length) return
    const timer = setTimeout(() => {
      void window.nais
        .invoke('outfits:stateCandidates', { tags: wornTags })
        .then((r) => setCandidates(r.items))
    }, 400)
    return () => clearTimeout(timer)
  }, [wornTags])
  const present = new Set(pieces.map((p) => p.tags.trim().toLowerCase()))
  // 입은 옷이 없으면 후보도 없다 (지난 후보를 비우려 상태를 바꾸지 않고 여기서 거른다)
  const fresh = wornTags.length ? candidates.filter((c) => !present.has(c.tag)) : []

  return (
    <div className="flex max-w-[860px] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-9 max-w-[320px] text-[14px] font-medium"
          value={outfit.name}
          onChange={(e) => update(outfit.id, { name: e.target.value })}
          placeholder="복장 이름"
        />
        <div className="flex-1" />
        <Button size="sm" variant="ghost" className="gap-1" onClick={() => void duplicate(outfit.id)}>
          <Copy size={13} /> 복제
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1 text-danger"
          onClick={() => void onDelete()}
        >
          <Trash2 size={13} /> 삭제
        </Button>
      </div>

      <p className="text-[11.5px] text-muted">
        <b className="text-ink">기본</b>이 켜진 조각이 평소 모습입니다. 꺼진 조각은 씬에서 켤 수 있는
        상태예요 — 씬에서 기본 조각을 끄면 벗고, 꺼진 조각을 켜면 그 상태가 됩니다.
      </p>

      <div className="flex flex-col gap-1.5">
        {pieces.map((p, i) => (
          <div
            key={p.id}
            className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 p-2"
          >
            <button
              title={p.on ? '평소에 입음 (씬에서 끄면 벗음)' : '평소엔 꺼짐 (씬에서 켜는 상태)'}
              className={cn(
                'mt-1 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors',
                p.on ? 'bg-emerald-500 text-white' : 'bg-paper text-faint hover:text-muted'
              )}
              onClick={() => patchPiece(p.id, { on: !p.on })}
            >
              {p.on ? '기본' : '상태'}
            </button>
            <Input
              className="mt-0.5 h-7 w-32 shrink-0 text-[12px]"
              value={p.name}
              placeholder="조각 이름"
              onChange={(e) => patchPiece(p.id, { name: e.target.value })}
            />
            <div className="min-w-0 flex-1">
              <PromptEditor
                autoGrow
                tokensOverride={null}
                className="max-h-[120px] min-h-[34px] bg-paper"
                value={p.tags}
                placeholder="태그"
                onValueChange={(v) => patchPiece(p.id, { tags: v })}
              />
            </div>
            <div className="flex shrink-0 flex-col">
              <button
                className="rounded p-0.5 text-faint hover:text-ink disabled:opacity-30"
                disabled={i === 0}
                title="위로"
                onClick={() => move(i, -1)}
              >
                <ArrowUp size={12} />
              </button>
              <button
                className="rounded p-0.5 text-faint hover:text-ink disabled:opacity-30"
                disabled={i === pieces.length - 1}
                title="아래로"
                onClick={() => move(i, 1)}
              >
                <ArrowDown size={12} />
              </button>
            </div>
            <button
              className="mt-1 shrink-0 rounded p-0.5 text-faint hover:text-danger"
              title="조각 삭제"
              onClick={() => setPieces(pieces.filter((x) => x.id !== p.id))}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <Button
          size="sm"
          variant="ghost"
          className="w-fit gap-1"
          onClick={() => addPiece({ name: '', tags: '', on: true })}
        >
          <Plus size={13} /> 조각 추가
        </Button>
      </div>

      {/* 상태 후보 — 입은 옷에 맞는 것만 */}
      <div className="rounded-lg border border-line p-2.5">
        <p className="mb-1.5 text-[12px] font-medium text-muted">
          이 옷에 맞는 상태 후보
          <span className="ml-1.5 text-[11px] font-normal text-faint">
            누르면 꺼진 상태 조각으로 추가됩니다 · 숫자는 단보루 사용 수
          </span>
        </p>
        {fresh.length === 0 ? (
          <p className="text-[11.5px] text-faint">
            {wornTags.length
              ? '맞는 후보가 없습니다. 태그 자료가 없는 PC에선 후보가 안 나올 수 있습니다.'
              : '기본 조각에 옷 태그를 넣으면 그 옷에 맞는 상태를 찾아 드립니다.'}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {fresh.map((c) => (
              <button
                key={c.tag}
                className="rounded-md border border-line px-2 py-1 text-[11.5px] text-muted transition-colors hover:border-accent hover:text-ink"
                title={c.tag}
                onClick={() => addPiece({ name: c.ko || c.tag, tags: c.tag, on: false })}
              >
                {c.ko || c.tag}
                <span className="ml-1 font-mono text-[10px] text-faint">{c.tag}</span>
                <span className="ml-1 font-mono text-[10px] text-faint">
                  {c.count.toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
