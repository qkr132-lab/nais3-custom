import { useState } from 'react'
import { AlertTriangle, FolderTree, Link2, ListOrdered, UserRound } from 'lucide-react'
import type { CharacterBackupPreview } from '@shared/types'
import { cn } from '../lib/utils'
import { askConfirm } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { useCharactersStore } from '../stores/characters-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'

/**
 * 캐릭터 완전 백업 복원 창 (커스텀).
 *
 * 되돌리기 어려운 작업이라 "무엇이 들어오는지" 먼저 보여주고 방식을 고르게 한다.
 * 전체 교체를 골라도 기존 카드는 영구 삭제가 아니라 휴지통으로 간다.
 */

type Mode = 'skip-identical' | 'always-copy' | 'replace-all'

const MODES: { value: Mode; label: string; desc: string }[] = [
  {
    value: 'skip-identical',
    label: '같은 건 건너뛰기',
    desc: '태그·이름·역할·위치가 완전히 같으면 넘어가고, 하나라도 다르면 새로 만듭니다'
  },
  {
    value: 'always-copy',
    label: '전부 새로 만들기',
    desc: '중복 판정 없이 파일에 있는 만큼 그대로 추가합니다'
  },
  {
    value: 'replace-all',
    label: '싹 비우고 복원',
    desc: '지금 캐릭터를 전부 휴지통으로 보내고 파일 내용만 남깁니다'
  }
]

export function CharacterBackupDialog({
  preview,
  onClose
}: {
  preview: CharacterBackupPreview | null
  onClose: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('skip-identical')
  const [busy, setBusy] = useState(false)
  const load = useCharactersStore((s) => s.load)

  const run = async (): Promise<void> => {
    if (!preview?.filePath) return
    if (mode === 'replace-all') {
      const ok = await askConfirm('지금 캐릭터를 모두 치우고 복원', {
        message:
          '현재 캐릭터가 전부 휴지통으로 갑니다. 휴지통이나 Ctrl+Z로 되살릴 수 있지만, 보관 기간이 지나면 사라집니다.',
        confirmLabel: '비우고 복원',
        danger: true,
        important: true
      })
      if (!ok) return
    }
    setBusy(true)
    const r = await window.nais.invoke('chars:importBackup', { filePath: preview.filePath, mode })
    setBusy(false)
    await load()
    onClose()
    toast(
      `캐릭터 ${r.created}개 복원` +
        (r.skipped ? ` · ${r.skipped}개 건너뜀` : '') +
        (r.removed ? ` · 기존 ${r.removed}개 휴지통행` : '') +
        (r.sceneLinks ? ` · 씬 연결 ${r.sceneLinks}건` : '') +
        (r.queueEntries ? ` · 큐 항목 ${r.queueEntries}건` : '') +
        (r.droppedLinks ? ` · 못 찾은 연결 ${r.droppedLinks}건` : ''),
      'success'
    )
  }

  return (
    <Dialog open={!!preview} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex w-[min(560px,94vw)] max-w-none flex-col p-5">
        <DialogTitle className="mb-3">캐릭터 백업 복원</DialogTitle>

        {preview && (
          <>
            <div className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-surface-2/50 p-3 text-[12px]">
              <span className="flex items-center gap-1.5">
                <UserRound size={13} className="text-faint" /> 캐릭터{' '}
                <b className="font-mono">{preview.characters}</b>
                {preview.identical > 0 && (
                  <span className="text-faint">(같은 것 {preview.identical})</span>
                )}
              </span>
              <span className="flex items-center gap-1.5">
                <FolderTree size={13} className="text-faint" /> 폴더{' '}
                <b className="font-mono">{preview.folders}</b>
              </span>
              <span className="flex items-center gap-1.5">
                <Link2 size={13} className="text-faint" /> 씬별 추가 연결{' '}
                <b className="font-mono">{preview.sceneLinks}</b>
              </span>
              <span className="flex items-center gap-1.5">
                <ListOrdered size={13} className="text-faint" /> 큐 반복 항목{' '}
                <b className="font-mono">{preview.queueEntries}</b>
              </span>
            </div>

            <div className="mt-3 flex flex-col gap-1.5">
              {MODES.map((m) => (
                <button
                  key={m.value}
                  className={cn(
                    'rounded-md border px-3 py-2 text-left transition-colors',
                    mode === m.value
                      ? 'border-accent bg-accent-soft'
                      : 'border-line hover:bg-surface-2'
                  )}
                  onClick={() => setMode(m.value)}
                >
                  <span
                    className={cn(
                      'text-[12.5px] font-medium',
                      m.value === 'replace-all' && 'text-danger'
                    )}
                  >
                    {m.label}
                  </span>
                  <span className="block text-[11.5px] text-muted">{m.desc}</span>
                </button>
              ))}
            </div>

            <p className="mt-3 flex items-start gap-1.5 text-[11.5px] text-muted">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-faint" />
              <span>
                씬별 추가·큐 반복 연결은 <b>이름이 맞는 씬</b>을 찾아 다시 잇습니다. 씬 이름이
                바뀌었거나 없으면 그 연결만 빠지고 나머지는 복원됩니다. 가져온 카드는 모두 꺼진
                상태로 들어옵니다.
              </span>
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={onClose}>
                취소
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void run()}>
                {busy ? '복원 중…' : '복원'}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
