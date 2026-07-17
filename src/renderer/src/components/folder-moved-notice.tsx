import { FolderOpen, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

/**
 * 데이터 폴더 분리 1회성 안내 (커스텀, v1.5.0~).
 * 공식 NAIS3와 폴더를 공유하던 사용자가 업데이트로 자체 폴더(NAIS3 Custom)로
 * 이관됐을 때, 데이터가 어디로 갔는지·백업됐는지 알려 당황하지 않게 한다.
 * migrate-data가 실제 이관 시 settings `folder_moved_notice='1'`을 심고,
 * 여기서 한 번 보여준 뒤 '0'으로 끈다.
 */
export function FolderMovedNotice(): React.JSX.Element {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    void window.nais.invoke('settings:get', { key: 'folder_moved_notice' }).then(({ value }) => {
      if (value === '1') setOpen(true)
    })
  }, [])

  const dismiss = (): void => {
    setOpen(false)
    void window.nais.invoke('settings:set', { key: 'folder_moved_notice', value: '0' })
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && dismiss()}>
      <DialogContent className="max-w-[480px] p-0">
        <div className="border-b border-line px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <FolderOpen size={17} className="text-accent" /> 데이터 폴더가 옮겨졌어요
          </DialogTitle>
          <DialogDescription className="mt-1">
            공식 NAIS3와 폴더를 함께 쓰던 방식에서 <b className="text-ink">전용 폴더</b>로 분리했습니다.
          </DialogDescription>
        </div>
        <div className="space-y-3 px-5 py-4 text-[13px] leading-relaxed text-muted">
          <p>
            그동안 만든 씬·캐릭터·라이브러리·이미지는 <b className="text-ink">전부 자동으로 복사</b>됐고, 되돌리기
            전 원본도 그대로 보존됩니다. 없어진 것은 없어요.
          </p>
          <div className="rounded-lg border border-line bg-surface-2/60 p-3 text-[12.5px]">
            <p>
              • 새 위치: <code>%APPDATA%\NAIS3 Custom</code>
            </p>
            <p className="mt-1">
              • 예전 공식 NAIS3 폴더(<code>%APPDATA%\NAIS3</code>)는 공식 앱이 다시 열 수 있게 복구해뒀습니다.
            </p>
          </div>
          <p className="flex items-start gap-1.5 text-[12px] text-faint">
            <ShieldCheck size={14} className="mt-px shrink-0" />
            혹시 몰라 백업이 필요하면 새 폴더를 통째로 복사해두세요. (설정 → 저장에서 자동 백업도 매일 돕니다)
          </p>
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <Button
            variant="ghost"
            className="gap-1.5"
            onClick={() => void window.nais.invoke('app:openDataFolder', undefined)}
          >
            <FolderOpen size={14} /> 새 폴더 열기
          </Button>
          <Button onClick={dismiss}>확인</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
