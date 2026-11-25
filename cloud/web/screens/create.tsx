/** 생성 탭(메인) — 프롬프트를 고치고, 캐릭터를 켜고 끄고, 바로 생성한다 */
import type { CloudCharacterLite, CloudLibrary, CloudMainPatch } from '@shared/cloud-contract'
import { useState } from 'preact/hooks'
import { errorMessage, refreshState, saveMain, setCharacterEnabled, toast } from '../actions'
import { useDraft } from '../hooks'
import { formatSize } from '../lib/format'
import { useStore } from '../lib/store'
import { app } from '../stores'
import { Icon } from '../ui/icons'
import { AutoTextarea, EmptyState, Spinner, Switch } from '../ui/primitives'
import { GenerateBar } from './generate-bar'

export function CreateTab() {
  const library = useStore(app, (s) => s.phone?.library ?? null)
  if (!library) {
    return (
      <EmptyState
        title="PC가 아직 데이터를 올리지 않았습니다"
        body="PC에서 NAIS3를 켜 두면 생성 설정이 여기에 나타납니다."
      >
        <button type="button" class="btn" onClick={() => void refreshState()}>
          <Icon name="refresh" size={18} />
          다시 확인
        </button>
      </EmptyState>
    )
  }
  return <MainEditor library={library} />
}

function MainEditor({ library }: { library: CloudLibrary }) {
  const main = library.main
  const split = main.promptSplit && main.promptParts != null
  const [prompt, setPrompt, promptDirty] = useDraft(main.prompt)
  const [base, setBase, baseDirty] = useDraft(main.promptParts?.base ?? '')
  const [additional, setAdditional, additionalDirty] = useDraft(main.promptParts?.additional ?? '')
  const [detail, setDetail, detailDirty] = useDraft(main.promptParts?.detail ?? '')
  const [negative, setNegative, negativeDirty] = useDraft(main.negativePrompt)
  const [saving, setSaving] = useState(false)

  const partsDirty = baseDirty || additionalDirty || detailDirty
  const dirty = (split ? partsDirty : promptDirty) || negativeDirty

  /** 고친 것만 보낸다. 저장했거나 고친 게 없으면 true */
  async function save(): Promise<boolean> {
    if (!dirty) return true
    const patch: CloudMainPatch = {}
    if (split) {
      if (partsDirty) patch.promptParts = { base, additional, detail }
    } else if (promptDirty) {
      patch.prompt = prompt
    }
    if (negativeDirty) patch.negativePrompt = negative
    setSaving(true)
    try {
      await saveMain(patch)
      toast('저장했습니다. PC에 반영되면 PC 화면에도 적용됩니다.')
      return true
    } catch (err) {
      toast(errorMessage(err), 'error')
      return false
    } finally {
      setSaving(false)
    }
  }

  return (
    <div class="stack stack--lg create">
      <section class="stack" aria-label="프롬프트">
        {split ? (
          <>
            <div class="field">
              <span class="field__label">고정</span>
              <AutoTextarea value={base} onChange={setBase} label="고정 프롬프트" />
            </div>
            <div class="field">
              <span class="field__label">가변</span>
              <AutoTextarea value={additional} onChange={setAdditional} label="가변 프롬프트" />
            </div>
            <div class="field">
              <span class="field__label">디테일</span>
              <AutoTextarea value={detail} onChange={setDetail} label="디테일 프롬프트" />
            </div>
          </>
        ) : (
          <div class="field">
            <span class="field__label">프롬프트</span>
            <AutoTextarea value={prompt} onChange={setPrompt} label="프롬프트" />
          </div>
        )}
        <div class="field">
          <span class="field__label">네거티브</span>
          <AutoTextarea value={negative} onChange={setNegative} label="네거티브 프롬프트" />
        </div>
        <p class="muted create__params">
          {main.model} · {formatSize(main.width, main.height)} · {main.steps}스텝
        </p>
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

      <CharacterList library={library} />

      <div class="create__bar">
        <GenerateBar
          target={{ type: 'main' }}
          beforeStart={save}
          size={{ width: main.width, height: main.height }}
        />
      </div>
    </div>
  )
}

function CharacterList({ library }: { library: CloudLibrary }) {
  const folders = new Map(library.charFolders.map((f) => [f.id, f.name]))
  const list: CloudCharacterLite[] = [...library.characters].sort(
    (a, b) => a.sortOrder - b.sortOrder
  )
  const onCount = list.filter((c) => c.enabled).length

  async function toggle(c: CloudCharacterLite, next: boolean): Promise<void> {
    try {
      await setCharacterEnabled(c.id, next)
    } catch (err) {
      toast(errorMessage(err), 'error')
    }
  }

  return (
    <section class="stack" aria-label="캐릭터">
      <div class="section-head">
        <h3 class="section-title">캐릭터</h3>
        {list.length > 0 && (
          <span class="muted">
            켜짐 {onCount} / 전체 {list.length}
          </span>
        )}
      </div>
      {list.length === 0 ? (
        <p class="muted">등록된 캐릭터가 없습니다.</p>
      ) : (
        <ul class="rows">
          {list.map((c) => (
            <li key={c.id} class="row">
              <span class="row__main">
                <span class="row__title">{c.name}</span>
                {c.folderId != null && folders.get(c.folderId) && (
                  <span class="row__sub">{folders.get(c.folderId)}</span>
                )}
              </span>
              <Switch
                checked={c.enabled}
                label={c.name}
                onChange={(next) => void toggle(c, next)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
