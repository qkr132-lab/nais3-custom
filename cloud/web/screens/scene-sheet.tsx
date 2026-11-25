/** 씬 시트 — 이름·프롬프트·해상도를 고치고 그 씬을 생성한다 */
import type { CloudImageItem, CloudPhoneScene, CloudScenePatch } from '@shared/cloud-contract'
import { useEffect, useState } from 'preact/hooks'
import { errorMessage, openViewer, replaceScene, toast } from '../actions'
import { api, thumbLoader } from '../client'
import { useDraft } from '../hooks'
import {
  RESOLUTION_PRESETS,
  SIZE_MAX,
  SIZE_MIN,
  SIZE_STEP,
  formatSize,
  validateSceneName,
  validateSize
} from '../lib/format'
import { useStore } from '../lib/store'
import { app, findScene, scenes, sheets } from '../stores'
import { Sheet } from '../ui/overlays'
import { AuthImage, AutoTextarea, EmptyState, Spinner } from '../ui/primitives'
import { GenerateBar } from './generate-bar'

function closeSheet(): void {
  sheets.set({ sceneId: null })
}

export function SceneSheetHost() {
  const sceneId = useStore(sheets, (s) => s.sceneId)
  if (sceneId == null) return null
  return <SceneSheet sceneId={sceneId} />
}

function SceneSheet({ sceneId }: { sceneId: number }) {
  const scene = useStore(scenes, (s) => findScene(s, sceneId))
  if (!scene) {
    return (
      <Sheet title="씬" onClose={closeSheet}>
        <EmptyState
          title="씬을 찾을 수 없습니다"
          body="PC에서 지워졌거나 아직 불러오지 못했습니다."
        />
      </Sheet>
    )
  }
  return <SceneEditor scene={scene} />
}

function SceneEditor({ scene }: { scene: CloudPhoneScene }) {
  const [name, setName, nameDirty] = useDraft(scene.name)
  const [prompt, setPrompt, promptDirty] = useDraft(scene.prompt)
  const [negative, setNegative, negativeDirty] = useDraft(scene.negativePrompt)
  const [width, setWidth, widthDirty] = useDraft(scene.width)
  const [height, setHeight, heightDirty] = useDraft(scene.height)
  const matched = RESOLUTION_PRESETS.find((p) => p.width === width && p.height === height)
  const [custom, setCustom] = useState(!matched)
  const [saving, setSaving] = useState(false)

  const dirty = nameDirty || promptDirty || negativeDirty || widthDirty || heightDirty
  const nameError = nameDirty ? validateSceneName(name) : null
  const sizeError = widthDirty || heightDirty ? validateSize(width, height) : null

  /** 고친 것만 서버에 보낸다. 저장했거나 고친 게 없으면 true */
  async function save(): Promise<boolean> {
    if (!dirty) return true
    const problem = nameError ?? sizeError
    if (problem) {
      toast(problem, 'error')
      return false
    }
    const patch: CloudScenePatch = {}
    if (nameDirty) patch.name = name.trim()
    if (promptDirty) patch.prompt = prompt
    if (negativeDirty) patch.negativePrompt = negative
    if (widthDirty) patch.width = width
    if (heightDirty) patch.height = height
    // 저장을 보낸 순간의 초안 — 응답을 기다리는 사이 더 입력한 칸은 건드리지 않으려고 기억해 둔다
    const sent = { name, prompt, negative, width, height }
    setSaving(true)
    try {
      const res = await api.patchScene(scene.id, patch)
      replaceScene(res.scene)
      // 서버가 다듬은 값(이름 앞뒤 공백 등)으로 맞추되, 보낸 값 그대로인 칸만 — 그 사이 더 쓴 글은 그대로 둔다
      if (patch.name !== undefined) setName((cur) => (cur === sent.name ? res.scene.name : cur))
      if (patch.prompt !== undefined)
        setPrompt((cur) => (cur === sent.prompt ? res.scene.prompt : cur))
      if (patch.negativePrompt !== undefined)
        setNegative((cur) => (cur === sent.negative ? res.scene.negativePrompt : cur))
      if (patch.width !== undefined) setWidth((cur) => (cur === sent.width ? res.scene.width : cur))
      if (patch.height !== undefined)
        setHeight((cur) => (cur === sent.height ? res.scene.height : cur))
      toast('저장했습니다. PC에 반영되면 편집 대기 표시가 사라집니다.')
      return true
    } catch (err) {
      toast(errorMessage(err), 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  const sizeInput = (label: string, value: number, set: (n: number) => void) => (
    <label class="field field--half">
      <span class="field__label">{label}</span>
      <input
        class="input"
        type="number"
        inputMode="numeric"
        min={SIZE_MIN}
        max={SIZE_MAX}
        step={SIZE_STEP}
        value={Number.isFinite(value) ? value : ''}
        onInput={(e) => {
          const raw = (e.currentTarget as HTMLInputElement).value
          set(raw === '' ? NaN : Number(raw)) // 비우는 중에는 0 으로 바꾸지 않는다
        }}
      />
    </label>
  )

  return (
    <Sheet
      title={scene.name}
      onClose={closeSheet}
      footer={
        <GenerateBar
          target={{ type: 'scene', sceneId: scene.id }}
          beforeStart={save}
          size={{ width, height }}
        />
      }
    >
      <div class="stack stack--lg">
        <section class="stack" aria-label="편집">
          <label class="field">
            <span class="field__label">이름</span>
            <input
              class="input"
              type="text"
              value={name}
              maxLength={100}
              autocomplete="off"
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
            />
            {nameError && <span class="field__error">{nameError}</span>}
          </label>

          <div class="field">
            <span class="field__label">프롬프트</span>
            <AutoTextarea value={prompt} onChange={setPrompt} label="프롬프트" />
          </div>

          <div class="field">
            <span class="field__label">네거티브</span>
            <AutoTextarea value={negative} onChange={setNegative} label="네거티브 프롬프트" />
          </div>

          <div class="field">
            <span class="field__label">해상도</span>
            <div class="chips chips--wrap" role="group" aria-label="해상도">
              {RESOLUTION_PRESETS.map((p) => {
                const on = !custom && matched?.label === p.label
                return (
                  <button
                    key={p.label}
                    type="button"
                    class={on ? 'chip is-on' : 'chip'}
                    aria-pressed={on}
                    onClick={() => {
                      setWidth(p.width)
                      setHeight(p.height)
                      setCustom(false)
                    }}
                  >
                    {p.label} {formatSize(p.width, p.height)}
                  </button>
                )
              })}
              <button
                type="button"
                class={custom ? 'chip is-on' : 'chip'}
                aria-pressed={custom}
                onClick={() => setCustom(true)}
              >
                직접
              </button>
            </div>
            {custom && (
              <div class="field-row">
                {sizeInput('가로', width, setWidth)}
                {sizeInput('세로', height, setHeight)}
              </div>
            )}
            {sizeError && <span class="field__error">{sizeError}</span>}
          </div>

          <button
            type="button"
            class="btn btn--block"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? <Spinner size={18} /> : null}
            저장
          </button>
        </section>

        <section class="stack" aria-label="최근 그림">
          <h3 class="section-title">최근 그림</h3>
          <RecentStrip sceneId={scene.id} />
        </section>
      </div>
    </Sheet>
  )
}

/** 이 씬의 최근 그림 가로 줄 */
function RecentStrip({ sceneId }: { sceneId: number }) {
  const jobsVersion = useStore(app, (s) => s.jobsVersion)
  const imagesVersion = useStore(app, (s) => s.imagesVersion)
  const [items, setItems] = useState<CloudImageItem[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .images({ sceneId, limit: 60 })
      .then((res) => {
        if (!alive) return
        setItems(res.items)
        setFailed(false)
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [sceneId, jobsVersion, imagesVersion])

  if (!items) {
    return failed ? (
      <p class="muted">그림 목록을 불러오지 못했습니다.</p>
    ) : (
      <p class="muted">불러오는 중</p>
    )
  }
  if (items.length === 0) return <p class="muted">아직 그림이 없습니다.</p>
  return (
    <ul class="strip">
      {items.map((it, i) => (
        <li key={it.id}>
          <button
            type="button"
            class="thumb thumb--strip is-contain"
            aria-label={`그림 ${i + 1}번 크게 보기`}
            onClick={() => openViewer(items, i, 'list')}
          >
            <AuthImage
              cacheKey={`t:${it.id}`}
              load={thumbLoader(it.id, it.hasThumb)}
              margin="240px"
            />
          </button>
        </li>
      ))}
    </ul>
  )
}
