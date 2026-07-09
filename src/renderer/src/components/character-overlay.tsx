import {
  Copy,
  Crosshair,
  FolderPlus,
  ImageOff,
  ImagePlus,
  Link2,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserRound,
  X
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CharacterCard } from '@shared/types'
import { cn } from '../lib/utils'
import { buildDisplayRows } from '../lib/folder-list'
import { useCharactersStore, MAX_CHARACTERS } from '../stores/characters-store'
import { useCharRefsStore } from '../stores/refs-store'
import { useGenerationStore } from '../stores/generation-store'
import { askText } from '../stores/dialog-store'
import { FolderListView } from './folder-list-view'
import { PromptEditor } from './prompt-editor'
import { ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Slider } from './ui/slider'
import { Switch } from './ui/switch'

/** NAI 웹의 5×5 수동 배치 그리드 (실캡처: 0.1~0.9) */
const GRID = [0.1, 0.3, 0.5, 0.7, 0.9]

function PositionPicker({
  center,
  onPick
}: {
  center: { x: number; y: number }
  onPick: (center: { x: number; y: number }) => void
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-5 gap-0.5">
      {GRID.map((y) =>
        GRID.map((x) => (
          <button
            key={`${x}-${y}`}
            className={cn(
              'size-6 rounded-[4px] border border-line transition-colors',
              center.x === x && center.y === y ? 'bg-accent' : 'bg-paper'
            )}
            title={`(${x}, ${y})`}
            onClick={() => onPick({ x, y })}
          />
        ))
      )}
    </div>
  )
}

export function CharacterOverlay(): React.JSX.Element {
  const setOverlayOpen = useCharactersStore((s) => s.setOverlayOpen)
  const folders = useCharactersStore((s) => s.folders)
  const items = useCharactersStore((s) => s.items)
  const createCard = useCharactersStore((s) => s.createCard)
  const updateCard = useCharactersStore((s) => s.updateCard)
  const disableAll = useCharactersStore((s) => s.disableAll)
  const removeCard = useCharactersStore((s) => s.removeCard)
  const duplicateCard = useCharactersStore((s) => s.duplicateCard)
  const pickThumbnail = useCharactersStore((s) => s.pickThumbnail)
  const clearThumbnail = useCharactersStore((s) => s.clearThumbnail)
  const createFolder = useCharactersStore((s) => s.createFolder)
  const renameFolder = useCharactersStore((s) => s.renameFolder)
  const toggleCollapse = useCharactersStore((s) => s.toggleCollapse)
  const setFolderColor = useCharactersStore((s) => s.setFolderColor)
  const removeFolder = useCharactersStore((s) => s.removeFolder)
  const move = useCharactersStore((s) => s.move)
  const useCoords = useGenerationStore((s) => s.request.useCoords)
  const patch = useGenerationStore((s) => s.patchRequest)

  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  /** 썸네일 호버 미리보기 — 카드 오른쪽 바깥에 고정 위치로 (카드 내용을 가리지 않게) */
  const [hoverPreview, setHoverPreview] = useState<{
    src: string
    top: number
    left: number
  } | null>(null)

  const showPreview = (e: React.MouseEvent, src: string): void => {
    const card = (e.currentTarget as HTMLElement).closest('[data-char-card]')
    if (!card) return
    const rect = card.getBoundingClientRect()
    const size = 176
    const top = Math.max(
      8,
      Math.min(rect.top + rect.height / 2 - size / 2, window.innerHeight - size - 8)
    )
    setHoverPreview({ src, top, left: rect.right + 10 })
  }

  const searching = search.trim().length > 0
  const rows = useMemo(() => {
    const all = buildDisplayRows(folders, items)
    if (!searching) return all
    const q = search.trim().toLowerCase()
    return all.filter(
      (r) =>
        r.type === 'item' &&
        (r.item.name.toLowerCase().includes(q) || r.item.prompt.toLowerCase().includes(q))
    )
  }, [folders, items, searching, search])

  const enabledCount = items.filter((c) => c.enabled && c.prompt.trim()).length

  // 기본 프롬프트 + 캐릭터 프롬프트가 512 토큰을 합산 공유 (공홈 실측)
  const basePrompt = useGenerationStore((s) => s.request.prompt)
  const positiveTexts = useMemo(
    () =>
      [
        basePrompt,
        ...items.filter((c) => c.enabled && c.prompt.trim()).map((c) => c.prompt)
      ].filter((t) => t.trim()),
    [basePrompt, items]
  )
  const [charTokens, setCharTokens] = useState<number | null>(null)
  useEffect(() => {
    if (positiveTexts.length === 0) {
      const timer = setTimeout(() => setCharTokens(null))
      return () => clearTimeout(timer)
    }
    const timer = setTimeout(() => {
      void window.nais.invoke('tokens:count', { texts: positiveTexts }).then(({ counts }) => {
        // 공홈은 캡션별 EOS를 각각 포함해 그대로 합산
        setCharTokens(counts.reduce((a, b) => a + b, 0))
      })
    }, 300)
    return () => clearTimeout(timer)
  }, [positiveTexts])

  const renderHeader = (char: CharacterCard): React.ReactNode => (
    <div
      data-char-card
      className={cn('flex h-10 items-center gap-2 px-2', !char.enabled && 'opacity-55')}
    >
      <Switch checked={char.enabled} onCheckedChange={(v) => updateCard(char.id, { enabled: v })} />
      {char.thumbnail ? (
        <img
          src={`data:image/webp;base64,${char.thumbnail}`}
          className="size-8 shrink-0 rounded-md object-cover"
          alt=""
          onMouseEnter={(e) => showPreview(e, char.thumbnail)}
          onMouseLeave={() => setHoverPreview(null)}
        />
      ) : (
        <div className="grid size-8 shrink-0 place-items-center rounded-md bg-surface-2 text-faint">
          <UserRound size={15} strokeWidth={1.5} />
        </div>
      )}
      <button
        className="min-w-0 flex-1 truncate text-left text-[13px] text-ink"
        title="눌러서 수정"
        onClick={() => setExpandedId(expandedId === char.id ? null : char.id)}
      >
        {char.name || char.prompt.slice(0, 40) || <span className="text-faint">빈 캐릭터</span>}
      </button>
      {/* 연결된 캐릭레퍼 표시 (커스텀) — 이 캐릭터가 포함되면 레퍼런스도 자동 적용 */}
      <LinkedRefBadge charRefId={char.charRefId} onHover={showPreview} onLeave={() => setHoverPreview(null)} />
      {useCoords && char.enabled && (
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-1.5 font-mono text-[11px]">
              <Crosshair size={13} />
              {char.center.x},{char.center.y}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto">
            <PositionPicker
              center={char.center}
              onPick={(c) => updateCard(char.id, { center: c })}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  )

  const renderExpanded = (char: CharacterCard): React.ReactNode => (
    <div className="flex flex-col gap-1.5 px-2 pb-2">
      <div className="flex gap-1.5">
        <Input
          className="h-8 flex-1 bg-surface-2 text-[12.5px]"
          value={char.name}
          placeholder="이름"
          onChange={(e) => updateCard(char.id, { name: e.target.value })}
        />
        {/* F12: 썸네일이 있으면 "이미지 제거"로 (옆의 캐릭터 삭제와 구분되게 이미지 아이콘 명시) */}
        {char.thumbnail ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1 px-2 text-[12px] hover:text-danger"
            title="캐릭터 썸네일 제거"
            onClick={() => void clearThumbnail(char.id)}
          >
            <ImageOff size={14} /> 제거
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1 px-2 text-[12px]"
            onClick={() => void pickThumbnail(char.id)}
          >
            <ImagePlus size={14} /> 이미지
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0 hover:text-danger"
          title="캐릭터 삭제"
          onClick={() => removeCard(char.id)}
        >
          <Trash2 size={14} />
        </Button>
      </div>
      {/* resize-y: 우하단 핸들로 세로 크기 조절. 초기 크기 상향 (F11) */}
      <PromptEditor
        className="h-40 max-h-[520px] min-h-20 resize-y bg-surface-2"
        value={char.prompt}
        placeholder="girl, ..."
        onValueChange={(v) => updateCard(char.id, { prompt: v })}
      />
      <PromptEditor
        negative
        className="h-24 max-h-96 min-h-14 resize-y bg-surface-2"
        value={char.negativePrompt}
        placeholder="캐릭터 네거티브"
        onValueChange={(v) => updateCard(char.id, { negativePrompt: v })}
      />
      {/* 캐릭레퍼 연결 (커스텀) — 이 캐릭터가 생성에 포함되면 레퍼런스도 자동 적용 */}
      <RefLinkRow char={char} onLink={(refId) => updateCard(char.id, { charRefId: refId })} />
    </div>
  )

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title="닫기"
          onClick={() => setOverlayOpen(false)}
        >
          <X size={15} />
        </Button>
        <span className="text-[13px] font-medium">캐릭터</span>
        {enabledCount > 0 && (
          <span
            className={cn(
              'rounded-full px-1.5 font-mono text-[10.5px]',
              enabledCount >= MAX_CHARACTERS
                ? 'bg-danger/15 text-danger'
                : 'bg-accent-soft text-accent'
            )}
            title={`활성 캐릭터 ${enabledCount}/${MAX_CHARACTERS} (NAI는 6명까지)`}
          >
            {enabledCount}/{MAX_CHARACTERS}
          </span>
        )}
        {enabledCount > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            title="활성 캐릭터 전체 해제"
            onClick={disableAll}
          >
            전체 해제
          </Button>
        )}
        {charTokens !== null && (
          <span
            className={cn(
              'font-mono text-[10.5px]',
              charTokens > 512 ? 'text-danger' : 'text-faint'
            )}
            title="기본 프롬프트 + 캐릭터 프롬프트 합산 (512 토큰 공유)"
          >
            {charTokens}/512
          </span>
        )}
        <div className="flex-1" />
        <label
          className="flex items-center gap-1.5 text-[11.5px] text-muted"
          title="끄면 AI's Choice (NAI가 위치 결정)"
        >
          위치 지정
          <Switch checked={useCoords} onCheckedChange={(v) => patch({ useCoords: v })} />
        </label>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            className="pl-7"
            value={search}
            placeholder="이름·프롬프트 검색"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="ghost"
          title="폴더 추가"
          onClick={() => void createFolder('새 폴더')}
        >
          <FolderPlus size={14} />
        </Button>
        <Button size="sm" variant="accent" className="gap-1" onClick={() => void createCard(null)}>
          <Plus size={13} /> 캐릭터
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden no-scrollbar">
        <FolderListView
          rows={rows}
          searching={searching}
          expandedId={expandedId}
          folderActions={{
            rename: renameFolder,
            toggleCollapse,
            setColor: setFolderColor,
            remove: removeFolder,
            addItem: (folderId) => void createCard(folderId)
          }}
          onMove={move}
          itemClassName={(char) =>
            cn(
              'transition-colors hover:border-muted/60', // F2: 호버 강조
              char.enabled && 'border-accent/60 bg-accent-soft' // F3: 활성 강조
            )
          }
          renderHeader={renderHeader}
          renderExpanded={renderExpanded}
          itemContextMenu={(char) => (
            <>
              <ContextMenuItem
                onSelect={async () => {
                  const name = await askText('이름 변경', char.name)
                  if (name != null) updateCard(char.id, { name })
                }}
              >
                <Pencil size={13} /> 이름 변경
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void duplicateCard(char.id)}>
                <Copy size={13} /> 복제
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem danger onSelect={() => removeCard(char.id)}>
                <Trash2 size={13} /> 삭제
              </ContextMenuItem>
            </>
          )}
          emptyText={items.length === 0 ? '캐릭터를 추가해보세요' : '검색 결과 없음'}
        />
      </div>

      {hoverPreview &&
        createPortal(
          <img
            src={`data:image/webp;base64,${hoverPreview.src}`}
            className="pointer-events-none fixed z-50 size-44 rounded-lg border border-line object-cover shadow-2xl"
            style={{ top: hoverPreview.top, left: hoverPreview.left }}
            alt=""
          />,
          document.body
        )}
    </div>
  )
}

/** 헤더의 연결 레퍼런스 미니 표시 (커스텀) */
function LinkedRefBadge({
  charRefId,
  onHover,
  onLeave
}: {
  charRefId: number | null
  onHover: (e: React.MouseEvent, src: string) => void
  onLeave: () => void
}): React.JSX.Element | null {
  const ref = useCharRefsStore((s) =>
    charRefId != null ? s.items.find((c) => c.id === charRefId) : undefined
  )
  if (!ref) return null
  return (
    <span className="relative shrink-0" title={`연결된 레퍼런스: ${ref.name || '이름 없음'}`}>
      {ref.thumbnail ? (
        <img
          src={`data:image/webp;base64,${ref.thumbnail}`}
          className="size-7 rounded-md border border-accent/50 object-cover"
          alt=""
          onMouseEnter={(e) => onHover(e, ref.thumbnail)}
          onMouseLeave={onLeave}
        />
      ) : (
        <span className="grid size-7 place-items-center rounded-md border border-accent/50 bg-surface-2">
          <Link2 size={12} className="text-accent" />
        </span>
      )}
      <Link2
        size={9}
        className="absolute -bottom-1 -right-1 rounded-full bg-accent p-px text-white"
      />
    </span>
  )
}

/** 캐릭레퍼 유형 한글 라벨 (NAI 웹과 동일 항목) */
const REF_TYPE_LABELS: { value: string; label: string }[] = [
  { value: 'character', label: '캐릭터' },
  { value: 'style', label: '스타일' },
  { value: 'character&style', label: '캐릭터+스타일' },
  { value: 'costume', label: '의상' },
  { value: 'delta', label: '델타' }
]

/** 캐릭레퍼 연결 행 (커스텀) — 카드 확장 영역 하단. 클릭하면 큰 연결 창이 열린다 */
function RefLinkRow({
  char,
  onLink
}: {
  char: CharacterCard
  onLink: (refId: number | null) => void
}): React.JSX.Element {
  const refs = useCharRefsStore((s) => s.items)
  const linked = char.charRefId != null ? refs.find((r) => r.id === char.charRefId) : undefined
  const [dialogOpen, setDialogOpen] = useState(false)
  const typeLabel = linked
    ? (REF_TYPE_LABELS.find((t) => t.value === linked.refType)?.label ?? linked.refType)
    : ''

  return (
    <>
      <button
        className="flex w-full items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5 text-left transition-colors hover:bg-surface-2/70"
        onClick={() => setDialogOpen(true)}
        title="클릭하면 레퍼런스 연결 창이 열립니다"
      >
        <Link2 size={13} className={linked ? 'text-accent' : 'text-muted'} />
        <span className="text-[12px] text-muted">레퍼런스 연결</span>
        <div className="flex-1" />
        {linked ? (
          <>
            <span className="truncate text-[11px] text-muted">
              {typeLabel} · 강도 {linked.strength.toFixed(2)} · 충실도 {linked.fidelity.toFixed(2)}
            </span>
            {linked.thumbnail && (
              <img
                src={`data:image/webp;base64,${linked.thumbnail}`}
                className="size-8 shrink-0 rounded-md object-cover"
                alt=""
              />
            )}
          </>
        ) : (
          <span className="text-[11px] text-faint">없음 — 클릭해서 선택</span>
        )}
      </button>
      <CharRefLinkDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        char={char}
        onLink={onLink}
      />
    </>
  )
}

/** 레퍼런스 연결 전용 대형 창 (커스텀) — 큰 그리드로 고르고, 우측 패널에서 유형/게이지 조절 */
function CharRefLinkDialog({
  open,
  onOpenChange,
  char,
  onLink
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  char: CharacterCard
  onLink: (refId: number | null) => void
}): React.JSX.Element {
  const refs = useCharRefsStore((s) => s.items)
  const update = useCharRefsStore((s) => s.update)
  const linked = char.charRefId != null ? refs.find((r) => r.id === char.charRefId) : undefined

  /** 파일 선택 → 라이브러리에 추가 → 전역 적용은 끄고 이 캐릭터에 연결 */
  const addFromFile = async (): Promise<void> => {
    const before = new Set(useCharRefsStore.getState().items.map((r) => r.id))
    const { count } = await window.nais.invoke('crefs:add', { folderId: null })
    if (count === 0) return
    await useCharRefsStore.getState().load()
    const added = useCharRefsStore.getState().items.filter((r) => !before.has(r.id))
    const target = added[added.length - 1]
    if (target) {
      // 연결 전용 — 전역 enabled를 꺼서 이 캐릭터가 포함될 때만 적용되게
      useCharRefsStore.getState().update(target.id, { enabled: false })
      onLink(target.id)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] max-h-[86vh] max-w-[960px] flex-col">
        <div className="border-b border-line px-4 py-3">
          <DialogTitle className="flex items-center gap-2">
            <Link2 size={15} /> 레퍼런스 연결
            {char.name ? ` — ${char.name}` : ''}
          </DialogTitle>
          <DialogDescription className="mt-0.5">
            이 캐릭터가 생성에 포함되면 연결된 레퍼런스가 자동으로 함께 적용됩니다.
          </DialogDescription>
        </div>
        <div className="flex min-h-0 flex-1">
          {/* 좌: 라이브러리 그리드 (크게) */}
          <div className="flex min-w-0 flex-1 flex-col border-r border-line">
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <Button size="sm" className="gap-1.5" onClick={() => void addFromFile()}>
                <ImagePlus size={13} /> 내 파일에서 추가
              </Button>
              <span className="text-[11.5px] text-faint">
                추가한 이미지는 자동으로 이 캐릭터에 연결됩니다
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              {refs.length === 0 ? (
                <p className="py-12 text-center text-[13px] text-faint">
                  라이브러리가 비어 있습니다 — 위 버튼으로 이미지를 추가하세요
                </p>
              ) : (
                <div className="grid grid-cols-4 gap-2.5">
                  {refs.map((r) => (
                    <button
                      key={r.id}
                      className={cn(
                        'group relative aspect-square overflow-hidden rounded-lg border transition',
                        r.id === char.charRefId
                          ? 'border-accent ring-2 ring-accent/40'
                          : 'border-line opacity-75 hover:opacity-100 hover:border-accent/50'
                      )}
                      title={r.name}
                      onClick={() => onLink(r.id === char.charRefId ? null : r.id)}
                    >
                      {r.thumbnail ? (
                        <img
                          src={`data:image/webp;base64,${r.thumbnail}`}
                          className="h-full w-full object-cover"
                          alt=""
                        />
                      ) : (
                        <span className="grid h-full w-full place-items-center bg-surface-2 text-faint">
                          <UserRound size={20} />
                        </span>
                      )}
                      {r.name && (
                        <span className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/75 to-transparent px-1.5 pb-1 pt-4 text-left text-[11px] text-white">
                          {r.name}
                        </span>
                      )}
                      {r.id === char.charRefId && (
                        <span className="absolute right-1.5 top-1.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold text-white">
                          연결됨
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 우: 연결된 레퍼런스 미리보기 + NAI 옵션 */}
          <div className="flex w-72 shrink-0 flex-col gap-3 overflow-y-auto p-3.5">
            {linked ? (
              <>
                <div className="overflow-hidden rounded-lg border border-line bg-paper">
                  {linked.thumbnail ? (
                    <img
                      src={`data:image/webp;base64,${linked.thumbnail}`}
                      className="max-h-64 w-full object-contain"
                      alt=""
                    />
                  ) : (
                    <div className="grid h-40 place-items-center text-faint">
                      <UserRound size={28} />
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <p className="text-[12px] font-medium text-muted">유형</p>
                  <Select value={linked.refType} onValueChange={(v) => update(linked.id, { refType: v })}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {REF_TYPE_LABELS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <p className="text-[12px] font-medium text-muted">
                    강도 <span className="font-mono text-ink">{linked.strength.toFixed(2)}</span>
                  </p>
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={[linked.strength]}
                    onValueChange={([v]) =>
                      update(linked.id, { strength: Math.round(v * 100) / 100 })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <p className="text-[12px] font-medium text-muted">
                    충실도 <span className="font-mono text-ink">{linked.fidelity.toFixed(2)}</span>
                  </p>
                  <Slider
                    min={0}
                    max={1}
                    step={0.05}
                    value={[linked.fidelity]}
                    onValueChange={([v]) =>
                      update(linked.id, { fidelity: Math.round(v * 100) / 100 })
                    }
                  />
                </div>
                <div className="flex-1" />
                <Button
                  variant="ghost"
                  className="w-full gap-1.5 text-danger"
                  onClick={() => onLink(null)}
                >
                  <X size={14} /> 연결 해제
                </Button>
              </>
            ) : (
              <p className="py-12 text-center text-[12.5px] leading-relaxed text-faint">
                왼쪽에서 레퍼런스를 클릭해
                <br />이 캐릭터에 연결하세요
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
