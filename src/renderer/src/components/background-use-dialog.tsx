import { useEffect, useState } from 'react'
import type { Scene, ScenePreset } from '@shared/types'
import { normalizeBackground } from '@shared/background-tags'
import { useScenesStore } from '../stores/scenes-store'
import { useLayoutStore } from '../stores/layout-store'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

/** Applies a snapshot of a tested background. Target scene prompts remain authored text. */
export function BackgroundUseDialog({
  backgroundScene,
  onClose
}: {
  backgroundScene: Scene
  onClose: () => void
}): React.JSX.Element {
  const [presets, setPresets] = useState<ScenePreset[]>([])
  const [presetId, setPresetId] = useState(0)
  const [scenes, setScenes] = useState<Scene[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [background, setBackground] = useState(() => ({
    ...normalizeBackground(backgroundScene.background),
    prompt: backgroundScene.prompt
  }))
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    void window.nais
      .invoke('scenePresets:list', { kind: 'scene' })
      .then(({ items }) => {
        if (!live) return
        setPresets(items)
        setPresetId(items[0]?.id ?? 0)
        if (!items.length) setLoading(false)
      })
      .catch((e) => {
        if (live) {
          setError(String(e))
          setLoading(false)
        }
      })
    return () => {
      live = false
    }
  }, [])
  useEffect(() => {
    if (!presetId) return
    let live = true
    void window.nais
      .invoke('scenes:list', { presetId })
      .then(({ items }) => {
        if (live) {
          setScenes(items)
          setLoading(false)
        }
      })
      .catch((e) => {
        if (live) {
          setError(String(e))
          setLoading(false)
        }
      })
    return () => {
      live = false
    }
  }, [presetId])
  async function apply(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await window.nais.invoke('scenes:setBackground', { ids: [...selected], background })
      // Switch using the same library activation path as the top-level tabs.
      await useScenesStore.getState().activateLibrary('scene')
      await useScenesStore.getState().setActivePreset(presetId)
      if (selected.size === 1) useScenesStore.getState().select([...selected][0])
      useLayoutStore.getState().setCenterMode('scene')
      onClose()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-w-[620px] p-5">
        <DialogTitle>배경을 사용할 씬 선택</DialogTitle>
        <DialogDescription>
          ‘{backgroundScene.name}’의 배경 태그를 선택한 씬에 적용합니다. 씬의 표정·행동 태그는
          유지됩니다.
        </DialogDescription>
        <fieldset disabled={busy} className="mt-4 space-y-3">
          <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-paper p-2 text-xs">
            {background.prompt}
          </pre>
          <select
            aria-label="적용할 씬 모듈"
            className="w-full rounded border border-line bg-paper p-2"
            value={presetId}
            onChange={(e) => {
              setLoading(true)
              setError('')
              setSelected(new Set())
              setScenes([])
              setPresetId(Number(e.target.value))
            }}
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={loading || !scenes.length}
            onClick={() =>
              setSelected(
                selected.size === scenes.length ? new Set() : new Set(scenes.map((s) => s.id))
              )
            }
          >
            전체 선택/해제
          </Button>
          <div className="max-h-64 space-y-1 overflow-auto rounded border border-line p-2">
            {loading ? (
              <p>불러오는 중…</p>
            ) : !scenes.length ? (
              <p className="text-sm text-muted">이 모듈에 씬이 없습니다.</p>
            ) : (
              scenes.map((s) => (
                <label
                  key={s.id}
                  className="flex items-center gap-2 rounded p-2 hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(s.id)}
                    onChange={() =>
                      setSelected((old) => {
                        const next = new Set(old)
                        if (next.has(s.id)) next.delete(s.id)
                        else next.add(s.id)
                        return next
                      })
                    }
                  />
                  <span className="min-w-0 truncate">{s.name}</span>
                </label>
              ))
            )}
          </div>
          <label className="flex items-center gap-2 text-sm">
            배경 삽입 위치
            <select
              aria-label="배경 삽입 위치"
              className="rounded bg-paper p-1"
              value={background.placement}
              onChange={(e) =>
                setBackground({
                  ...background,
                  placement: e.target.value as typeof background.placement
                })
              }
            >
              <option value="after-scene">씬 태그 뒤</option>
              <option value="before-scene">씬 태그 앞</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={background.replaceSimple}
              onChange={(e) => setBackground({ ...background, replaceSimple: e.target.checked })}
            />
            기존 단색 배경 태그 제외 (전송본만)
          </label>
        </fieldset>
        {error && (
          <p role="alert" className="mt-2 text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button disabled={busy} onClick={onClose}>
            취소
          </Button>
          <Button
            disabled={busy || loading || !selected.size || !background.prompt.trim()}
            onClick={() => void apply()}
          >
            {selected.size}개 씬에 적용하고 이동
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
