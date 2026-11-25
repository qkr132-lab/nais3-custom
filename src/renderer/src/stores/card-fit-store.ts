import { create } from 'zustand'
import { parseCardFitRules, type CardFitRules } from '@shared/card-fit'

const ENABLED_KEY = 'card_fit'

/**
 * 카드 태그 씬 맞춤 (커스텀) — 전체 설정과 규칙표.
 *
 * 전체 설정(card_fit)은 기본 꺼짐 — 저장값이 '1' 일 때만 켜진다 (카드 글을 보낼 때 고치는 기능이라 켠 사람만 쓴다).
 * 세트·씬마다 따로 끄고 켜는 값은 scene-extras-store(cardFitPresets · cardFits)에 있다.
 * 규칙표는 메인이 파일(userData\card-fit-rules.json)을 글 그대로 넘겨 주고 여기서 해석한다.
 * JSON 이 깨졌으면 규칙을 하나도 쓰지 않는다 (반쯤 읽은 규칙으로 카드를 고치지 않는다) — error 로 화면에 알린다.
 * 생성 요청을 만들 때 동기로 읽어야 해서 앱 시작 때 읽어 두고, 창으로 돌아올 때 파일이 바뀌었으면 다시 읽는다.
 */
interface CardFitState {
  loaded: boolean
  /** 전체 설정 — 세트·씬에서 따로 정하지 않은 씬은 이걸 따른다 */
  enabled: boolean
  setEnabled: (v: boolean) => void
  /** 쓸 규칙 (파일 오류면 null) */
  rules: CardFitRules | null
  path: string
  /** 파일을 읽지 못했거나 JSON 이 깨진 까닭 */
  error: string | null
  /** 읽었지만 걸린 것 (모르는 묶음 등) */
  warnings: string[]
  /** 마지막으로 읽은 글 — 같은 글이면 다시 해석하지 않는다 */
  text: string
  /** 규칙이 바뀔 때마다 1씩 — 미리 만든 요청을 다시 만들지 가리는 데 쓴다 */
  version: number
  load: () => Promise<void>
  /** 규칙표 파일만 다시 읽는다 — 바뀐 게 있으면 true */
  reloadRules: () => Promise<boolean>
  openFile: () => Promise<void>
  resetFile: () => Promise<{ backup?: string }>
}

export const useCardFitStore = create<CardFitState>((set, get) => {
  const applyText = (r: { path: string; text: string; error?: string }): boolean => {
    if (r.error) {
      const changed = get().error !== r.error || get().rules !== null
      set({ path: r.path, error: r.error, rules: null, warnings: [], text: '' })
      if (changed) set({ version: get().version + 1 })
      return changed
    }
    if (r.text === get().text && get().path === r.path && get().loaded) return false
    const parsed = parseCardFitRules(r.text)
    set({
      path: r.path,
      text: r.text,
      error: parsed.error ?? null,
      rules: parsed.error ? null : { rules: parsed.rules, warnings: parsed.warnings },
      warnings: parsed.warnings,
      version: get().version + 1
    })
    return true
  }

  return {
    loaded: false,
    enabled: false,
    rules: null,
    path: '',
    error: null,
    warnings: [],
    text: '',
    version: 0,

    load: async () => {
      const [setting, file] = await Promise.all([
        window.nais.invoke('settings:get', { key: ENABLED_KEY }),
        window.nais.invoke('cardFit:read', undefined)
      ])
      applyText(file)
      // 기본 꺼짐 — 켠 사람만 1 로 저장돼 있다
      set({ enabled: setting.value === '1', loaded: true })
    },

    reloadRules: async () => {
      const file = await window.nais.invoke('cardFit:read', undefined)
      return applyText(file)
    },

    setEnabled: (enabled) => {
      set({ enabled, version: get().version + 1 })
      void window.nais.invoke('settings:set', { key: ENABLED_KEY, value: enabled ? '1' : '0' })
    },

    openFile: async () => {
      await window.nais.invoke('cardFit:open', undefined)
    },

    resetFile: async () => {
      const r = await window.nais.invoke('cardFit:reset', undefined)
      // 같은 글이어도 다시 해석하도록 비운 뒤 읽힌다
      set({ text: '' })
      applyText(r)
      return r.backup ? { backup: r.backup } : {}
    }
  }
})

/** 생성 요청을 만들 때 쓸 규칙 — 전체 설정과 상관없이 규칙표만 (꺼짐 판정은 세트·씬과 함께 cardFitFor 가 한다) */
export const cardFitRules = (): CardFitRules | null => useCardFitStore.getState().rules
