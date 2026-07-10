import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Loader2,
  Plus,
  RotateCw,
  Wifi,
  X,
  ZoomIn,
  ZoomOut
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WebviewTag } from 'electron'
import { askConfirm, askText } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { cn } from '../lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'

/**
 * 웹 모드 — 내장 브라우저 (NAIS2 WebView 이식).
 * 단보루 등 참고 사이트를 앱 안에서 탐색. 퀵링크는 settings KV에 영속.
 * App에서 hidden으로 유지 렌더 — 모드를 오가도 페이지가 유지된다.
 */

interface QuickLink {
  name: string
  url: string
}

const DEFAULT_LINKS: QuickLink[] = [
  // shima 미러 — 우회(프록시) 없이 접속됨 (커스텀)
  { name: 'Danbooru', url: 'https://shima.donmai.us/' },
  { name: '태그 사전', url: 'https://danbooru-tag.mephistopheles.moe/' },
  { name: 'novelai.app', url: 'https://novelai.app/' },
  // 이미지 호스팅 — 여기서 로그인해두면 드래그앤드롭으로 바로 업로드 (커스텀)
  { name: 'itimg.kr 업로드', url: 'https://itimg.kr/' },
  { name: '구글 번역', url: 'https://translate.google.co.kr/?sl=ko&tl=en&op=translate' }
]

const LINKS_KEY = 'web_quick_links'
// itimg 링크를 기존 사용자에게 한 번만 주입했는지 표시 (커스텀)
const ITIMG_INJECTED_KEY = 'web_itimg_link_injected'
// 저장된 Danbooru 링크를 shima 미러로 한 번만 교체했는지 (커스텀)
const SHIMA_MIGRATED_KEY = 'web_shima_migrated'
const PROXY_KEY = 'web_proxy_rules'

function normalizeUrl(raw: string): string {
  const s = raw.trim()
  if (!s) return ''
  if (s.startsWith('http://') || s.startsWith('https://')) return s
  return `https://${s}`
}

export function WebMode(): React.JSX.Element {
  const webviewRef = useRef<WebviewTag | null>(null)
  const [inputUrl, setInputUrl] = useState(DEFAULT_LINKS[0].url)
  const [currentUrl, setCurrentUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canForward, setCanForward] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [links, setLinks] = useState<QuickLink[]>(DEFAULT_LINKS)
  const [editLinks, setEditLinks] = useState(false)
  const [proxyOpen, setProxyOpen] = useState(false)
  const [proxy, setProxy] = useState('')

  // 퀵링크 + 프록시 설정 로드
  useEffect(() => {
    void (async () => {
      const { value } = await window.nais.invoke('settings:get', { key: LINKS_KEY })
      if (value) {
        try {
          const parsed = JSON.parse(value) as QuickLink[]
          if (Array.isArray(parsed) && parsed.length > 0) {
            let next = parsed
            let changed = false

            // 저장된 danbooru.donmai.us 링크를 shima 미러로 한 번만 교체 (우회 없이 접속)
            const { value: shimaMigrated } = await window.nais.invoke('settings:get', {
              key: SHIMA_MIGRATED_KEY
            })
            if (!shimaMigrated) {
              if (next.some((l) => l.url.includes('danbooru.donmai.us'))) {
                next = next.map((l) =>
                  l.url.includes('danbooru.donmai.us')
                    ? { ...l, url: l.url.replace(/https?:\/\/danbooru\.donmai\.us\/?/, 'https://shima.donmai.us/') }
                    : l
                )
                changed = true
              }
              void window.nais.invoke('settings:set', { key: SHIMA_MIGRATED_KEY, value: '1' })
            }

            // 기존 사용자에게도 itimg 업로드 링크를 한 번만 주입 (이후 삭제하면 다시 안 넣음)
            const { value: injected } = await window.nais.invoke('settings:get', {
              key: ITIMG_INJECTED_KEY
            })
            if (!injected) {
              if (!next.some((l) => l.url.includes('itimg.kr'))) {
                next = [...next, { name: 'itimg.kr 업로드', url: 'https://itimg.kr/' }]
                changed = true
              }
              void window.nais.invoke('settings:set', { key: ITIMG_INJECTED_KEY, value: '1' })
            }

            if (changed)
              void window.nais.invoke('settings:set', { key: LINKS_KEY, value: JSON.stringify(next) })
            setLinks(next)
          }
        } catch {
          // 손상된 값 무시
        }
      }
      const { value: px } = await window.nais.invoke('settings:get', { key: PROXY_KEY })
      if (px) {
        setProxy(px)
        void window.nais.invoke('web:setProxy', { rules: px })
      }
    })()
  }, [])

  const applyProxy = (rules: string): void => {
    setProxy(rules)
    void window.nais.invoke('settings:set', { key: PROXY_KEY, value: rules })
    void window.nais.invoke('web:setProxy', { rules }).then((r) => {
      if (r.ok)
        toast(rules.trim() ? '프록시 적용됨 — 새로고침하세요' : '프록시 해제됨', 'success')
    })
  }

  const saveLinks = (next: QuickLink[]): void => {
    setLinks(next)
    void window.nais.invoke('settings:set', { key: LINKS_KEY, value: JSON.stringify(next) })
  }

  // webview 이벤트 바인딩
  useEffect(() => {
    const wv = webviewRef.current
    if (!wv) return
    const sync = (): void => {
      setCurrentUrl(wv.getURL())
      setInputUrl(wv.getURL())
      setCanBack(wv.canGoBack())
      setCanForward(wv.canGoForward())
    }
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      sync()
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', sync)
    wv.addEventListener('did-navigate-in-page', sync)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', sync)
      wv.removeEventListener('did-navigate-in-page', sync)
    }
  }, [])

  const navigate = (url: string): void => {
    const target = normalizeUrl(url)
    if (!target) return
    void webviewRef.current?.loadURL(target)
  }

  const applyZoom = (next: number): void => {
    const clamped = Math.max(0.25, Math.min(3, Math.round(next * 100) / 100))
    setZoom(clamped)
    webviewRef.current?.setZoomFactor(clamped)
  }

  const addLink = async (): Promise<void> => {
    const name = await askText('퀵링크 이름', '')
    if (!name) return
    const url = await askText('퀵링크 URL', 'https://')
    if (!url) return
    saveLinks([...links, { name, url: normalizeUrl(url) }])
  }

  const removeLink = async (index: number): Promise<void> => {
    if (
      await askConfirm('퀵링크 삭제', {
        message: `"${links[index].name}" 링크를 삭제합니다.`,
        confirmLabel: '삭제',
        danger: true
      })
    )
      saveLinks(links.filter((_, i) => i !== index))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-surface">
      {/* 툴바: 네비게이션 + URL + 줌 */}
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        <NavBtn tip="뒤로" disabled={!canBack} onClick={() => webviewRef.current?.goBack()}>
          <ArrowLeft size={15} />
        </NavBtn>
        <NavBtn tip="앞으로" disabled={!canForward} onClick={() => webviewRef.current?.goForward()}>
          <ArrowRight size={15} />
        </NavBtn>
        <NavBtn tip="새로고침" onClick={() => webviewRef.current?.reload()}>
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RotateCw size={15} />}
        </NavBtn>
        <form
          className="mx-1 flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-paper px-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            navigate(inputUrl)
          }}
        >
          <Globe size={13} className="shrink-0 text-faint" />
          <input
            className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onFocus={(e) => e.target.select()}
            spellCheck={false}
            placeholder="URL 입력 후 Enter"
          />
        </form>
        <NavBtn tip="축소" onClick={() => applyZoom(zoom - 0.1)}>
          <ZoomOut size={15} />
        </NavBtn>
        <button
          className="min-w-11 rounded-md px-1 py-1 text-[12px] text-muted transition-colors hover:bg-surface-2 hover:text-fg"
          onClick={() => applyZoom(1)}
          title="줌 초기화"
        >
          {Math.round(zoom * 100)}%
        </button>
        <NavBtn tip="확대" onClick={() => applyZoom(zoom + 0.1)}>
          <ZoomIn size={15} />
        </NavBtn>
        <div className="mx-1 h-5 w-px bg-line" />
        {/* 프록시 설정 (커스텀 — 단보루 등 우회) */}
        <Popover open={proxyOpen} onOpenChange={setProxyOpen}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    'grid size-8 place-items-center rounded-md transition-colors hover:bg-surface-2',
                    proxy.trim() ? 'text-accent' : 'text-muted hover:text-fg'
                  )}
                >
                  <Wifi size={15} />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>프록시 설정 (접속 우회)</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-80 p-3">
            <p className="text-[13px] font-semibold text-ink">프록시 (접속 우회)</p>
            <p className="mt-1 text-[11.5px] leading-relaxed text-muted">
              단보루 등이 한국에서 막혀 있으면, 사용 중인 프록시/VPN 주소를 넣어 우회할 수
              있습니다. 예: <code className="text-accent">socks5://127.0.0.1:1080</code> 또는{' '}
              <code className="text-accent">http://호스트:포트</code>. 프록시가 없으면 접속 자체를
              뚫을 수는 없어요(VPN 앱을 켜두면 비워둬도 됩니다).
            </p>
            <ProxyInput initial={proxy} onApply={applyProxy} onClose={() => setProxyOpen(false)} />
          </PopoverContent>
        </Popover>
        <NavBtn
          tip="기본 브라우저로 열기"
          onClick={() => currentUrl && window.open(currentUrl)}
        >
          <ExternalLink size={15} />
        </NavBtn>
      </div>

      {/* 퀵링크 바 */}
      <div className="flex items-center gap-1 border-b border-line px-2 py-1.5">
        {links.map((link, i) => (
          <button
            key={`${link.url}-${i}`}
            className={cn(
              'flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[12px] transition-colors',
              currentUrl.startsWith(link.url.replace(/\/$/, ''))
                ? 'border-accent/50 bg-accent/10 text-accent'
                : 'text-muted hover:bg-surface-2 hover:text-fg'
            )}
            onClick={() => (editLinks ? void removeLink(i) : navigate(link.url))}
            title={editLinks ? '클릭하여 삭제' : link.url}
          >
            {editLinks && <X size={11} className="text-danger" />}
            {link.name}
          </button>
        ))}
        <button
          className="grid size-6 place-items-center rounded-full border border-dashed border-line text-faint transition-colors hover:border-accent hover:text-accent"
          onClick={() => void addLink()}
          title="퀵링크 추가"
        >
          <Plus size={12} />
        </button>
        <div className="flex-1" />
        <button
          className={cn(
            'rounded-md px-2 py-1 text-[12px] transition-colors',
            editLinks ? 'bg-accent text-white' : 'text-faint hover:bg-surface-2 hover:text-fg'
          )}
          onClick={() => setEditLinks(!editLinks)}
        >
          {editLinks ? '완료' : '편집'}
        </button>
      </div>

      {/* 웹뷰 */}
      <webview
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ref={webviewRef as any}
        src={DEFAULT_LINKS[0].url}
        partition="persist:webmode"
        className="min-h-0 w-full flex-1"
      />
    </div>
  )
}

/** 프록시 입력 + 적용/해제 (커스텀) */
function ProxyInput({
  initial,
  onApply,
  onClose
}: {
  initial: string
  onApply: (rules: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <div className="mt-2.5 space-y-2">
      <input
        className="h-8 w-full rounded-md border border-line bg-paper px-2.5 text-[12px] outline-none focus:border-accent"
        value={value}
        placeholder="socks5://127.0.0.1:1080"
        spellCheck={false}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onApply(value)
            onClose()
          }
        }}
      />
      <div className="flex justify-end gap-1.5">
        {initial.trim() && (
          <button
            className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-surface-2 hover:text-fg"
            onClick={() => {
              setValue('')
              onApply('')
              onClose()
            }}
          >
            해제
          </button>
        )}
        <button
          className="rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-white hover:bg-accent/90"
          onClick={() => {
            onApply(value)
            onClose()
          }}
        >
          적용
        </button>
      </div>
    </div>
  )
}

function NavBtn({
  tip,
  disabled,
  onClick,
  children
}: {
  tip: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="grid size-8 place-items-center rounded-md text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-35 disabled:hover:bg-transparent"
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
