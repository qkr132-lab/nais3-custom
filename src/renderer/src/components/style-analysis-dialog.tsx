import { Copy, Loader2, Palette } from 'lucide-react'
import { useEffect, useState } from 'react'
import { imageUrl } from '../lib/constants'
import { toast } from '../stores/toast-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

/**
 * 스타일(작가) 태그 분석 다이얼로그 (NAIS2 스마트 도구 이식).
 * Kaloscope HF Space로 이미지의 작가 태그를 추정한다.
 */
export function StyleAnalysisDialog({
  filePath,
  onClose
}: {
  filePath: string | null
  onClose: () => void
}): React.JSX.Element {
  const open = filePath != null
  const [loading, setLoading] = useState(false)
  const [tags, setTags] = useState<{ label: string; score: number }[]>([])

  useEffect(() => {
    if (!filePath) {
      setTags([])
      return
    }
    let cancelled = false
    setLoading(true)
    void window.nais.invoke('tools:analyzeStyle', { filePath }).then((res) => {
      if (cancelled) return
      setLoading(false)
      if ('error' in res) {
        toast(res.error, 'error')
        onClose()
      } else {
        setTags(res.tags.filter((t) => t.score > 0.1).sort((a, b) => b.score - a.score))
      }
    })
    return () => {
      cancelled = true
    }
  }, [filePath]) // eslint-disable-line react-hooks/exhaustive-deps

  const tagString = tags.map((t) => t.label).join(', ')

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="flex max-h-[80vh] max-w-[720px] flex-col">
        <div className="border-b border-line px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <Palette size={15} /> 스타일 태그 분석
          </DialogTitle>
          <DialogDescription className="mt-0.5">
            이미지에서 추정한 작가 태그입니다 (Kaloscope). 인터넷 연결이 필요합니다.
          </DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1 gap-4 p-4">
          <div className="grid w-2/5 shrink-0 place-items-center overflow-hidden rounded-md border border-line bg-paper">
            {filePath && (
              <img src={imageUrl(filePath)} className="max-h-full max-w-full object-contain" alt="" />
            )}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {loading ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-md border border-line bg-paper text-muted">
                <Loader2 size={22} className="animate-spin" />
                <span className="text-[12px]">스타일 분석 중…</span>
              </div>
            ) : (
              <textarea
                readOnly
                value={tagString}
                placeholder="감지된 스타일이 없습니다"
                className="min-h-32 flex-1 resize-none rounded-md border border-line bg-paper p-2.5 font-mono text-[12px] leading-relaxed outline-none"
              />
            )}
            <Button
              size="sm"
              disabled={!tagString || loading}
              onClick={() => {
                void navigator.clipboard.writeText(tagString)
                toast('복사됨', 'success')
              }}
            >
              <Copy size={13} /> 태그 복사
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
