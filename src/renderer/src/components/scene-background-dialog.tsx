import { useEffect, useState } from 'react'
import type { Scene } from '@shared/types'
import { normalizeBackground, type SceneBackground } from '@shared/background-tags'
import { preparePromptCaptions } from '@shared/nai-prompts'
import { buildSceneRequest, useScenesStore } from '../stores/scenes-store'
import { useSceneExtrasStore } from '../stores/scene-extras-store'
import { useGenerationStore } from '../stores/generation-store'
import { PromptEditor } from './prompt-editor'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { loadBackgroundLibrary, type BackgroundLibraryItem } from '../lib/background-library'

export function SceneBackgroundDialog({
  scenes,
  onClose
}: {
  scenes: Scene[]
  onClose: () => void
}): React.JSX.Element {
  const [background, setBackground] = useState(() => normalizeBackground(scenes[0]?.background))
  const [library, setLibrary] = useState<BackgroundLibraryItem[]>([])
  const [libraryPresetId, setLibraryPresetId] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [previewId, setPreviewId] = useState(scenes[0]?.id)
  // Subscribe so the preview also follows sidebar edits while this dialog is open.
  useGenerationStore((s) => s.request)
  const model = useGenerationStore((s) => s.request.model)
  const previewScene = scenes.find((s) => s.id === previewId) ?? scenes[0]
  const preview = previewScene
    ? preparePromptCaptions(buildSceneRequest({ ...previewScene, background })).positive.base
    : ''

  useEffect(() => {
    let live = true
    void loadBackgroundLibrary()
      .then(({ presetId, items }) => {
        if (!live) return
        setLibraryPresetId(presetId)
        setLibrary(items)
        setLoaded(true)
      })
      .catch((e) => {
        if (live) setError(String(e))
      })
    return () => {
      live = false
    }
  }, [])

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await action()
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }
  async function refreshLibrary(): Promise<void> {
    const { items } = await loadBackgroundLibrary()
    setLibrary(items)
  }
  async function apply(): Promise<void> {
    await window.nais.invoke('scenes:setBackground', { ids: scenes.map((s) => s.id), background })
    await useScenesStore.getState().load()
    await useScenesStore.getState().resyncPendingScenes()
    onClose()
  }
  async function testScene(): Promise<void> {
    if (!previewScene) return
    const { id } = await window.nais.invoke('scenes:duplicate', { id: previewScene.id })
    if (!id) throw new Error('테스트 씬을 만들 수 없습니다.')
    await window.nais.invoke('scenes:update', {
      id,
      patch: { name: `${previewScene.name} · 배경 테스트 ${name.trim() || ''}`.trim(), background }
    })
    // 씬별 캐릭터 설정·투명 배경까지 원본 그대로
    useSceneExtrasStore.getState().copyAdditions([
      {
        sourcePresetId: previewScene.presetId,
        sourceSceneId: previewScene.id,
        targetPresetId: previewScene.presetId,
        targetSceneId: id
      }
    ])
    const store = useScenesStore.getState()
    await Promise.all([store.load(), store.refreshPresetCounts()])
    store.select(id)
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-w-[900px] max-h-[90vh] overflow-y-auto p-5">
        <DialogTitle>배경 선택 · {scenes.length}개 씬</DialogTitle>
        <DialogDescription>
          배경 태그를 보관하고 씬에 적용하세요. 테스트 씬을 만들면 기존 생성 버튼으로 뽑고 비교할 수
          있어요.
        </DialogDescription>
        <fieldset disabled={busy} className="mt-4 grid min-w-0 gap-4 md:grid-cols-[220px_1fr]">
          <div className="min-w-0 space-y-2">
            <h3 className="text-sm font-medium">배경 보관함</h3>
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {library.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={selected === item.id}
                  className={`w-full rounded-lg border p-3 text-left ${selected === item.id ? 'border-accent bg-accent-soft' : 'border-line bg-paper'}`}
                  onClick={() => {
                    setSelected(item.id)
                    setName(item.name)
                    setBackground(item.background)
                  }}
                >
                  {item.thumbnail && (
                    <img
                      src={`data:image/webp;base64,${item.thumbnail}`}
                      alt=""
                      className="mb-2 aspect-video w-full rounded object-cover"
                    />
                  )}
                  <span className="block text-sm font-medium">{item.name}</span>
                  <span className="line-clamp-3 break-words text-xs text-muted">
                    {item.background.prompt}
                  </span>
                </button>
              ))}
              {loaded && !library.length && (
                <p className="text-xs text-muted">마음에 드는 배경 태그를 입력하고 보관하세요.</p>
              )}
            </div>
            <Button
              size="sm"
              onClick={() => {
                setSelected('')
                setName('')
                setBackground(normalizeBackground(null))
              }}
            >
              새 배경
            </Button>
            <input
              aria-label="배경 이름"
              placeholder="배경 이름"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded border border-line bg-paper p-2 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!loaded || !libraryPresetId || !name.trim() || !background.prompt.trim()}
                onClick={() =>
                  void run(async () => {
                    const id = selected
                      ? Number(selected)
                      : (
                          await window.nais.invoke('scenes:create', {
                            presetId: libraryPresetId,
                            name: name.trim()
                          })
                        ).id
                    await window.nais.invoke('scenes:update', {
                      id,
                      patch: {
                        name: name.trim(),
                        prompt: background.prompt,
                        background: { ...background, prompt: '' }
                      }
                    })
                    await refreshLibrary()
                    setSelected(String(id))
                    setMessage('배경 보관함에 저장했어요.')
                  })
                }
              >
                보관함 저장
              </Button>
              <Button
                size="sm"
                disabled={!loaded || !selected}
                onClick={() =>
                  void run(async () => {
                    await window.nais.invoke('scenes:delete', { id: Number(selected) })
                    await refreshLibrary()
                    setSelected('')
                    setMessage('보관함에서 삭제했어요. 씬에 적용된 태그는 유지됩니다.')
                  })
                }
              >
                보관함 삭제
              </Button>
            </div>
          </div>
          <div className="min-w-0 space-y-3">
            <h3 className="text-sm font-medium">배경 태그</h3>
            <PromptEditor
              value={background.prompt}
              onValueChange={(prompt) => setBackground({ ...background, prompt })}
              placeholder="배경 태그 (예: outdoors, forest, sunlight)"
              model={model}
              className="h-28"
            />
            <label className="flex items-center gap-2 text-sm">
              삽입 위치
              <select
                aria-label="배경 삽입 위치"
                value={background.placement}
                onChange={(e) =>
                  setBackground({
                    ...background,
                    placement: e.target.value as SceneBackground['placement']
                  })
                }
                className="rounded border border-line bg-paper p-1"
              >
                <option value="after-scene">씬 태그 뒤 · 디테일 앞</option>
                <option value="before-scene">씬 태그 앞 · 가변 뒤</option>
              </select>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={background.replaceSimple}
                onChange={(e) => setBackground({ ...background, replaceSimple: e.target.checked })}
              />
              기존 단색 배경 태그 제외
            </label>
            <p className="text-xs text-muted">
              새 배경이 있을 때 공통·씬 태그의 simple/색상/transparent background를 전송본에서만
              제외합니다. 단일 태그의 양수 가중치도 지원하며, 복합 가중치 묶음·캐릭터
              태그·네거티브는 유지합니다.
            </p>
            {scenes.length > 1 && (
              <label className="flex gap-2 text-sm">
                미리볼 씬
                <select
                  aria-label="배경 미리볼 씬"
                  className="min-w-0 max-w-full bg-paper"
                  value={previewId}
                  onChange={(e) => setPreviewId(Number(e.target.value))}
                >
                  {scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <details open>
              <summary className="text-sm">공통 프롬프트 조합 미리보기</summary>
              <p className="my-1 text-xs text-muted">
                고정 → 가변 → 씬/배경 → 검열 → 디테일 → 자동 품질. 단일 입력 모드에서는 공통 입력
                뒤에 씬/배경이 붙습니다. 조각·와일드카드는 실행 시 반영됩니다.
              </p>
              <pre
                className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded bg-paper p-2 text-xs"
                data-testid="background-preview"
              >
                {preview}
              </pre>
            </details>
          </div>
        </fieldset>
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {error}
          </p>
        )}
        {message && (
          <p role="status" className="mt-3 text-sm text-accent">
            {message}
          </p>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button disabled={busy} onClick={onClose}>
            취소
          </Button>
          <Button
            disabled={busy || !previewScene || !background.prompt.trim()}
            onClick={() => void run(testScene)}
          >
            테스트 씬 만들기
          </Button>
          <Button disabled={busy || !scenes.length} onClick={() => void run(apply)}>
            {scenes.length}개 씬에 적용
          </Button>
        </div>
        <p className="mt-2 text-right text-xs text-muted">
          태그를 비우고 적용하면 별도 배경 설정을 해제합니다. 보관함 변경은 즉시 저장됩니다.
        </p>
      </DialogContent>
    </Dialog>
  )
}
