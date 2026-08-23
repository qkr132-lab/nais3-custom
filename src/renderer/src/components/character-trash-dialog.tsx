import { useEffect, useState } from 'react'
import { RotateCcw, Trash2, UserRound } from 'lucide-react'
import type { TrashedCharacter } from '@shared/types'
import { cn } from '../lib/utils'
import { askConfirm } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { useCharactersStore } from '../stores/characters-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

/**
 * 캐릭터 휴지통 (커스텀).
 *
 * 폴더를 통째로 지우면 안의 카드까지 함께 사라지는데, 잘못 지웠을 때 되돌릴 길이 없으면
 * 손실이 크다. 그래서 카드 삭제는 전부 소프트삭제로 두고 여기서 되살린다.
 * 보관 기간은 씬 휴지통과 같은 설정(trash_retention_days)을 따른다.
 */

/** 'YYYY-MM-DD HH:MM:SS'(UTC) → 로컬 표시 */
function formatDeletedAt(utc: string): string {
  const date = new Date(utc.replace(' ', 'T') + 'Z')
  if (Number.isNaN(date.getTime())) return utc
  return date.toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function CharacterTrashDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [items, setItems] = useState<TrashedCharacter[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const load = useCharactersStore((s) => s.load)

  const refresh = (): void => {
    void window.nais.invoke('chars:trash', undefined).then((r) => {
      setItems(r.items)
      setSelected(new Set())
    })
  }
  useEffect(() => {
    if (open) refresh()
  }, [open])

  const toggle = (id: number): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const targets = (item?: TrashedCharacter): number[] => (item ? [item.id] : [...selected])

  const restore = async (item?: TrashedCharacter): Promise<void> => {
    const ids = targets(item)
    if (!ids.length) return
    await window.nais.invoke('chars:restore', { ids })
    await load()
    refresh()
    toast(`${ids.length}개를 되살렸습니다`, 'success')
  }

  const purge = async (item?: TrashedCharacter): Promise<void> => {
    const ids = targets(item)
    if (!ids.length) return
    const ok = await askConfirm('영구 삭제', {
      message: `${ids.length}개를 완전히 지웁니다. 이건 되돌릴 수 없습니다.`,
      confirmLabel: '영구 삭제',
      danger: true,
      important: true
    })
    if (!ok) return
    await window.nais.invoke('chars:purge', { ids })
    refresh()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] w-[min(680px,94vw)] max-w-none flex-col p-5">
        <DialogTitle className="mb-3 flex flex-wrap items-center gap-2">
          캐릭터 휴지통
          <span className="font-mono text-[11px] font-normal text-faint">{items.length}개</span>
          {selected.size > 0 && (
            <>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11.5px]"
                onClick={() => void restore()}
              >
                <RotateCcw size={12} /> 선택 되살리기 ({selected.size})
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11.5px] text-danger"
                onClick={() => void purge()}
              >
                <Trash2 size={12} /> 선택 영구 삭제
              </Button>
            </>
          )}
        </DialogTitle>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {items.length === 0 ? (
            <p className="py-12 text-center text-[12.5px] text-faint">휴지통이 비어 있습니다</p>
          ) : (
            <div className="flex flex-col gap-1">
              {items.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    'flex items-center gap-2 rounded-md border px-2 py-1.5 transition-colors',
                    selected.has(item.id)
                      ? 'border-accent bg-accent-soft'
                      : 'border-line bg-surface-2'
                  )}
                  onClick={() => toggle(item.id)}
                >
                  <UserRound size={13} className="shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">
                    {item.name || item.prompt.slice(0, 40) || '빈 캐릭터'}
                  </span>
                  {item.folderName && (
                    <span className="shrink-0 rounded bg-paper px-1.5 py-0.5 text-[10.5px] text-muted">
                      {item.folderName}
                    </span>
                  )}
                  <span className="shrink-0 text-[10.5px] text-faint">
                    {formatDeletedAt(item.deletedAt)}
                  </span>
                  <button
                    className="grid size-6 shrink-0 place-items-center rounded text-faint hover:text-accent"
                    title="되살리기"
                    onClick={(e) => {
                      e.stopPropagation()
                      void restore(item)
                    }}
                  >
                    <RotateCcw size={12} />
                  </button>
                  <button
                    className="grid size-6 shrink-0 place-items-center rounded text-faint hover:text-danger"
                    title="영구 삭제"
                    onClick={(e) => {
                      e.stopPropagation()
                      void purge(item)
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="mt-3 text-[11.5px] text-faint">
          보관 기간이 지나면 자동으로 비워집니다 (씬 휴지통과 같은 설정을 따릅니다).
        </p>
      </DialogContent>
    </Dialog>
  )
}
