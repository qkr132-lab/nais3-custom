/** 전체 화면 그림 보기 — 좌우 스와이프, 저장(공유), 삭제, 정보 */
import type { CloudImageItem } from '@shared/cloud-contract'
import { useEffect, useRef, useState } from 'preact/hooks'
import {
  askConfirm,
  closeViewer,
  deleteImage,
  errorMessage,
  loadMoreGallery,
  setViewerIndex,
  syncViewer,
  toast
} from '../actions'
import { imageCache, loadFullBlob, thumbLoader } from '../client'
import { useBlobUrl, useDialogFocus, useOverlayHistory } from '../hooks'
import { ApiError } from '../lib/api'
import { deleteConfirmBody, formatSize } from '../lib/format'
import { resolveViewerIndex } from '../lib/gallery'
import { useStore } from '../lib/store'
import { saveImage } from '../lib/thumb'
import { formatDateTime } from '../lib/time'
import { findScene, gallery, scenes, viewer } from '../stores'
import { Icon } from '../ui/icons'
import { Spinner } from '../ui/primitives'

export function ViewerHost() {
  const cur = useStore(viewer, (s) => s.current)
  const galleryItems = useStore(gallery, (s) => s.items)
  if (!cur) return null
  const items = cur.source === 'gallery' ? galleryItems : cur.items
  // 보던 그림의 id 로 찾는다 — 목록 앞에 새 그림이 끼어도 같은 그림에 머문다
  const index = resolveViewerIndex(items, cur.id, cur.index)
  return <Viewer items={items} index={index} source={cur.source} />
}

/** 두 손가락으로 확대한 상태인가 — 확대 중에는 스와이프로 넘기지 않는다 */
function isZoomed(): boolean {
  return (window.visualViewport?.scale ?? 1) > 1.02
}

function Viewer({
  items,
  index,
  source
}: {
  items: CloudImageItem[]
  index: number
  source: 'gallery' | 'list'
}) {
  const i = Math.max(0, index)
  const item: CloudImageItem | undefined = items[i]
  const [showInfo, setShowInfo] = useState(false)
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const slideRef = useRef<HTMLDivElement>(null)

  useOverlayHistory(closeViewer)
  useDialogFocus(rootRef, closeViewer)

  // 마지막 한 장을 지우면 닫는다
  useEffect(() => {
    if (!item) closeViewer()
  }, [item])

  // 목록이 바뀌어 위치가 달라졌거나 보던 그림이 지워져 이웃 그림이 보이게 됐으면, 기억하는 그림을 지금 것으로 맞춘다
  const itemId = item?.id ?? null
  useEffect(() => {
    if (itemId != null) syncViewer(itemId, i)
  }, [itemId, i])

  // 갤러리에서 열었으면 끝이 가까워질 때 다음 페이지를 미리 받는다
  useEffect(() => {
    if (source === 'gallery' && i >= items.length - 4) void loadMoreGallery()
  }, [source, i, items.length])

  // 좌우 이동 (키보드·스와이프가 같은 함수를 쓴다)
  const nav = useRef({ i, length: items.length })
  nav.current = { i, length: items.length }
  const go = (delta: number): void => {
    const target = nav.current.i + delta
    if (target >= 0 && target < nav.current.length) setViewerIndex(target)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === 'ArrowRight') go(1)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const el = rootRef.current
    const slide = slideRef.current
    if (!el || !slide) return
    let tracking = false
    let startX = 0
    let startY = 0
    let dx = 0
    const reset = (animate: boolean): void => {
      slide.style.transition = animate ? 'transform 0.18s ease-out' : 'none'
      slide.style.transform = ''
    }
    const onStart = (e: TouchEvent): void => {
      tracking = e.touches.length === 1 && !isZoomed()
      if (!tracking) return
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
      dx = 0
    }
    const onMove = (e: TouchEvent): void => {
      if (!tracking) return
      if (e.touches.length !== 1) {
        tracking = false
        reset(true)
        return
      }
      dx = e.touches[0].clientX - startX
      const dy = e.touches[0].clientY - startY
      if (Math.abs(dx) > Math.abs(dy)) {
        slide.style.transition = 'none'
        slide.style.transform = `translateX(${dx * 0.6}px)`
      }
    }
    const onEnd = (): void => {
      if (!tracking) return
      tracking = false
      reset(true)
      if (Math.abs(dx) > 64) go(dx < 0 ? 1 : -1)
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: true })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    return () => {
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
    }
  }, [])

  if (!item) return null
  const fullKey = `f:${item.id}`

  async function save(target: CloudImageItem): Promise<void> {
    const blob = imageCache.peekBlob(`f:${target.id}`)
    if (!blob) {
      toast('그림을 아직 불러오는 중입니다')
      return
    }
    setBusy('save')
    try {
      const result = await saveImage(blob, `nais3-${target.id}`)
      if (result === 'downloaded') toast('내려받기를 시작했습니다')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const confirmDelete = (pcPending: boolean): Promise<boolean> =>
    askConfirm({
      title: '이 그림을 삭제할까요?',
      body: deleteConfirmBody(pcPending),
      confirmLabel: '삭제',
      danger: true
    })

  async function remove(target: CloudImageItem): Promise<void> {
    // PC로 아직 옮기지 않은 그림은 이 사본이 유일하다 — 그 사실을 알리는 확인을 받고 force 로 지운다
    let forced = target.pcPending
    if (!(await confirmDelete(forced))) return
    setBusy('delete')
    try {
      try {
        await deleteImage(target.id, { force: forced })
      } catch (err) {
        // 목록을 받은 뒤에 PC로 옮기지 않은 상태가 됐다면 서버가 막는다(409) — 문구를 바꿔 한 번 더 묻는다
        if (forced || !(err instanceof ApiError) || err.status !== 409) throw err
        if (!(await confirmDelete(true))) return
        forced = true
        await deleteImage(target.id, { force: true })
      }
      toast(forced ? '그림을 삭제했습니다' : '클라우드 사본을 삭제했습니다')
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      class="viewer"
      role="dialog"
      aria-modal="true"
      aria-label="그림 보기"
      tabIndex={-1}
      ref={rootRef}
    >
      <div class="viewer__stage">
        <div class="viewer__slide" ref={slideRef}>
          <ViewerImage key={item.id} item={item} fullKey={fullKey} />
        </div>
        {i > 0 && (
          <button
            type="button"
            class="viewer__nav viewer__nav--prev"
            aria-label="이전 그림"
            onClick={() => go(-1)}
          >
            <Icon name="chevronLeft" size={26} />
          </button>
        )}
        {i < items.length - 1 && (
          <button
            type="button"
            class="viewer__nav viewer__nav--next"
            aria-label="다음 그림"
            onClick={() => go(1)}
          >
            <Icon name="chevronRight" size={26} />
          </button>
        )}
      </div>

      <div class="viewer__top">
        <button type="button" class="icon-btn" aria-label="닫기" onClick={closeViewer}>
          <Icon name="x" />
        </button>
        <span class="viewer__count" aria-live="polite">
          {i + 1} / {items.length}
        </span>
        <button
          type="button"
          class={showInfo ? 'icon-btn is-on' : 'icon-btn'}
          aria-label="정보"
          aria-pressed={showInfo}
          onClick={() => setShowInfo((v) => !v)}
        >
          <Icon name="info" />
        </button>
      </div>

      {showInfo && <InfoPanel item={item} />}

      <div class="viewer__bottom">
        <button
          type="button"
          class="btn viewer__btn"
          disabled={busy !== null}
          onClick={() => void save(item)}
        >
          {busy === 'save' ? <Spinner size={18} /> : <Icon name="upload" size={18} />}
          저장
        </button>
        {!item.id.startsWith('d:') && (
          <button
            type="button"
            class="btn btn--danger viewer__btn"
            disabled={busy !== null}
            onClick={() => void remove(item)}
          >
            {busy === 'delete' ? <Spinner size={18} /> : <Icon name="trash" size={18} />}
            삭제
          </button>
        )}
      </div>
    </div>
  )
}

function ViewerImage({ item, fullKey }: { item: CloudImageItem; fullKey: string }) {
  // 전체 크기가 올 때까지 이미 받아 둔 썸네일을 흐리게 깔아 둔다
  const full = useBlobUrl(fullKey, () => loadFullBlob(item.id), true)
  const thumb = useBlobUrl(`t:${item.id}`, thumbLoader(item.id, item.hasThumb))
  if (full.url) return <img class="viewer__img" src={full.url} alt="" draggable={false} />
  return (
    <>
      {thumb.url && (
        <img class="viewer__img viewer__img--soft" src={thumb.url} alt="" draggable={false} />
      )}
      {full.error ? (
        <p class="viewer__msg" role="alert">
          {full.error}
        </p>
      ) : (
        <span class="viewer__spin" role="status" aria-label="불러오는 중">
          <Spinner size={26} />
        </span>
      )}
    </>
  )
}

function InfoPanel({ item }: { item: CloudImageItem }) {
  const sceneName = useStore(scenes, (s) => findScene(s, item.sceneId)?.name ?? null)
  const isDrive = item.id.startsWith('d:')
  const sceneText = isDrive
    ? item.id.slice(2)
    : item.sceneId == null
      ? '메인 생성'
      : (sceneName ?? `씬 #${item.sceneId}`)
  const rows: [string, string][] = [
    [isDrive ? '폴더 경로' : '씬', sceneText],
    ...(isDrive
      ? []
      : ([
          ['시드', item.seed == null ? '-' : String(item.seed)],
          ['크기', formatSize(item.width, item.height)],
          ['만든 시각', formatDateTime(item.createdAt)]
        ] as [string, string][])),
    ['출처', isDrive ? 'PC 폴더' : item.source === 'cloud' ? '클라우드 생성' : 'PC']
  ]
  return (
    <dl class="viewer__info">
      {rows.map(([k, v]) => (
        <div key={k} class="viewer__info-row">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}
