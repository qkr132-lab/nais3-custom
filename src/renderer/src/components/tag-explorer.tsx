import { BookOpen, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { TAG_TAXONOMY } from '../lib/tag-taxonomy'
import { cn } from '../lib/utils'
import { appendPrompt } from '../stores/scenes-store'
import { useGenerationStore } from '../stores/generation-store'
import { toast } from '../stores/toast-store'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

/**
 * 태그 탐색기 (커스텀) — 신체/의상/악세서리 등 하드코딩 분류로 태그를 훑어보고
 * 클릭 한 번으로 프롬프트에 추가. "이런 태그도 있구나" 발견용.
 */

interface TagInfo {
  tag: string
  count: number
  type: string
  ko?: string
}

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(count)
}

export function TagExplorer({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [categoryIx, setCategoryIx] = useState(0)
  // 카테고리별 태그 정보 캐시 (한 번 조회하면 유지)
  const [cache, setCache] = useState<Record<number, Map<string, TagInfo>>>({})
  const [loading, setLoading] = useState(false)

  const category = TAG_TAXONOMY[categoryIx]

  useEffect(() => {
    if (!open || cache[categoryIx]) return
    const names = category.groups.flatMap((g) => g.tags)
    setLoading(true)
    void window.nais.invoke('tags:lookup', { tags: names }).then(({ items }) => {
      setCache((c) => ({ ...c, [categoryIx]: new Map(items.map((i) => [i.tag, i])) }))
      setLoading(false)
    })
  }, [open, categoryIx, category, cache])

  const info = cache[categoryIx]

  const insertTag = (tag: string): void => {
    const gen = useGenerationStore.getState()
    if (gen.promptSplitEnabled && gen.request.promptParts) {
      // 3분할 모드면 디테일 칸 뒤에
      const parts = {
        ...gen.request.promptParts,
        detail: appendPrompt(gen.request.promptParts.detail, tag)
      }
      gen.patchRequest({ promptParts: parts, prompt: appendPrompt(gen.request.prompt, tag) })
    } else {
      gen.patchRequest({ prompt: appendPrompt(gen.request.prompt, tag) })
    }
    toast(`프롬프트에 추가: ${tag}`, 'success')
  }

  const groups = useMemo(
    () =>
      category.groups.map((g) => ({
        name: g.name,
        // 실존 태그만 (lookup 결과에 있는 것)
        tags: info ? g.tags.filter((t) => info.has(t)) : []
      })),
    [category, info]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[86vh] max-w-[980px] flex-col">
        <div className="border-b border-line px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <BookOpen size={15} /> 태그 탐색기
          </DialogTitle>
          <DialogDescription className="mt-0.5">
            카테고리별로 단부루 태그를 둘러보고 클릭하면 프롬프트에 추가됩니다.
          </DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* 좌측 카테고리 */}
          <div className="w-32 shrink-0 space-y-0.5 overflow-y-auto border-r border-line p-2">
            {TAG_TAXONOMY.map((c, i) => (
              <button
                key={c.name}
                className={cn(
                  'w-full rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors',
                  i === categoryIx
                    ? 'bg-accent/12 font-semibold text-accent'
                    : 'text-muted hover:bg-surface-2 hover:text-fg'
                )}
                onClick={() => setCategoryIx(i)}
              >
                {c.name}
              </button>
            ))}
          </div>
          {/* 우측 그룹/태그 */}
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            {loading && !info ? (
              <div className="grid h-40 place-items-center text-muted">
                <Loader2 size={20} className="animate-spin" />
              </div>
            ) : (
              groups.map((g) => (
                <div key={g.name}>
                  <h3 className="mb-1.5 text-[12px] font-semibold text-muted">{g.name}</h3>
                  <div className="flex flex-wrap gap-1.5">
                    {g.tags.map((tag) => {
                      const t = info?.get(tag)
                      return (
                        <button
                          key={tag}
                          className="group flex flex-col rounded-md border border-line bg-paper px-2 py-1 text-left transition-colors hover:border-accent/60 hover:bg-accent/5"
                          title={`클릭하면 프롬프트에 추가 · 사용 ${t ? formatCount(t.count) : '?'}회`}
                          onClick={() => insertTag(tag)}
                        >
                          <span className="font-mono text-[12px] leading-tight text-ink">
                            {tag}
                            <span className="ml-1.5 text-[10px] text-faint">
                              {t ? formatCount(t.count) : ''}
                            </span>
                          </span>
                          {t?.ko && (
                            <span className="max-w-52 truncate text-[10.5px] leading-tight text-muted">
                              {t.ko}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
