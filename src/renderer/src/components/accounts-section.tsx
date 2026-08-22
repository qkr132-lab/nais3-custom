import { useEffect, useState } from 'react'
import { Check, Plus, Trash2, UserRound } from 'lucide-react'
import type { NaiAccountInfo } from '@shared/types'
import { cn } from '../lib/utils'
import { askConfirm, askText } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { useGenerationStore } from '../stores/generation-store'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Switch } from './ui/switch'

/**
 * NAI 계정 여러 개 관리 (커스텀).
 *
 * V5부터 Opus 무료 생성분이 한도제라, 계정을 둘 이상 등록해 두면 한도가 바닥난
 * 계정에서 여유 있는 계정으로 생성 직전에 갈아탈 수 있다.
 * 자동 전환은 V5에서만, 그리고 한도가 확실히 소진된 경우에만 동작한다.
 */
export function AccountsSection(): React.JSX.Element {
  const [accounts, setAccounts] = useState<NaiAccountInfo[]>([])
  const [autoSwitch, setAutoSwitch] = useState(false)
  const [draftToken, setDraftToken] = useState('')
  const refreshAnlas = useGenerationStore((s) => s.refreshAnlas)

  useEffect(() => {
    void window.nais.invoke('accounts:list', undefined).then((r) => setAccounts(r.accounts))
    void window.nais
      .invoke('settings:get', { key: 'auto_switch_account' })
      .then((r) => setAutoSwitch(r.value === '1'))
  }, [])

  const add = async (): Promise<void> => {
    const token = draftToken.trim()
    if (!token) return
    const label = await askText('계정 이름', `계정 ${accounts.length + 1}`)
    if (label === null) return // 취소
    const { accounts: next } = await window.nais.invoke('accounts:add', { label, token })
    setAccounts(next)
    setDraftToken('')
    toast('계정을 추가했습니다', 'success')
  }

  const activate = async (id: string): Promise<void> => {
    const { accounts: next } = await window.nais.invoke('accounts:setActive', { id })
    setAccounts(next)
    await refreshAnlas()
    toast('계정을 바꿨습니다', 'success')
  }

  const remove = async (account: NaiAccountInfo): Promise<void> => {
    const ok = await askConfirm('계정 삭제', {
      message: `"${account.label}"의 토큰을 지웁니다. 되돌릴 수 없습니다.`,
      confirmLabel: '삭제',
      danger: true
    })
    if (!ok) return
    const { accounts: next } = await window.nais.invoke('accounts:remove', { id: account.id })
    setAccounts(next)
    await refreshAnlas()
  }

  const rename = async (account: NaiAccountInfo): Promise<void> => {
    const label = await askText('계정 이름', account.label)
    if (!label) return
    const { accounts: next } = await window.nais.invoke('accounts:rename', {
      id: account.id,
      label
    })
    setAccounts(next)
  }

  return (
    <div className="rounded-lg border border-line bg-surface-2/50 p-3">
      <p className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-ink">
        <UserRound size={13} /> 계정
        <span className="font-normal text-faint">여러 개 등록해 한도 소진 시 갈아타기</span>
      </p>

      <div className="flex flex-col gap-1">
        {accounts.map((account) => (
          <div
            key={account.id}
            className={cn(
              'flex items-center gap-2 rounded-md border px-2 py-1.5',
              account.active ? 'border-accent bg-accent-soft' : 'border-line bg-paper'
            )}
          >
            {account.active ? (
              <Check size={13} className="shrink-0 text-accent" />
            ) : (
              <span className="size-[13px] shrink-0" />
            )}
            <button
              className="min-w-0 flex-1 truncate text-left text-[12.5px]"
              title="눌러서 이름 변경"
              onClick={() => void rename(account)}
            >
              {account.label}
            </button>
            <span className="shrink-0 font-mono text-[10.5px] text-faint">
              {account.prefix}••••
            </span>
            {!account.active && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[11px]"
                onClick={() => void activate(account.id)}
              >
                사용
              </Button>
            )}
            <button
              className="grid size-6 shrink-0 place-items-center rounded text-faint hover:text-danger"
              title="계정 삭제"
              onClick={() => void remove(account)}
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
        {!accounts.length && (
          <p className="py-2 text-[11.5px] text-faint">
            아직 등록된 계정이 없습니다. 위에서 토큰을 저장하면 첫 계정으로 들어갑니다.
          </p>
        )}
      </div>

      <div className="mt-2 flex gap-1.5">
        <Input
          className="h-8 flex-1 font-mono text-[12px]"
          value={draftToken}
          placeholder="추가할 계정의 토큰 (pst-...)"
          onChange={(e) => setDraftToken(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add()
          }}
        />
        <Button size="sm" className="h-8 gap-1 px-2 text-[12px]" onClick={() => void add()}>
          <Plus size={13} /> 추가
        </Button>
      </div>

      <label className="mt-3 flex items-start gap-2 text-[12px] text-muted">
        <Switch
          checked={autoSwitch}
          onCheckedChange={(v) => {
            setAutoSwitch(v)
            void window.nais.invoke('settings:set', {
              key: 'auto_switch_account',
              value: v ? '1' : '0'
            })
          }}
        />
        <span>
          한도 소진 시 자동으로 계정 바꾸기
          <span className="block text-[11px] text-faint">
            V5에서만, 한도가 확실히 소진됐을 때만 옮깁니다. 게이지가 0%로만 보이는 구간에서는 남은
            무료분을 버리지 않도록 그대로 둡니다.
          </span>
        </span>
      </label>
    </div>
  )
}
