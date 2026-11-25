import type { CloudPcStatus, CloudPreparedItem } from '@shared/cloud-contract'
import type { GenerationRequest, Scene } from '@shared/types'
import { useCharactersStore } from '../stores/characters-store'
import { useGenerationStore } from '../stores/generation-store'
import { useOutfitsStore } from '../stores/outfits-store'
import { useCardFitStore } from '../stores/card-fit-store'
import { useCharRefsStore, useVibesStore } from '../stores/refs-store'
import { useSceneExtrasStore } from '../stores/scene-extras-store'
import { buildSceneRequest, ensureExtrasData, useScenesStore } from '../stores/scenes-store'

/**
 * 클라우드 생성용 「완성 요청」 올리기 (커스텀 · 모바일 클라우드, 설계 cloud/DESIGN.md 9절).
 *
 * PC가 꺼져 있을 때 클라우드가 대신 생성하려면 씬마다·메인마다 완성된 생성 요청이 필요하다.
 * 그 조립(캐릭터·복장·상대 태그·검열·조각 제외)은 렌더러 스토어만 알아서, 여기서 만들어
 * `cloud:prepared` 로 메인에 넘긴다. 클라우드 생성과 동기화가 켜져 있고 앱·워커 판이 맞을 때만 동작한다
 * (메인은 그 밖의 상태에서는 올리기를 조용히 무시한다). PC에 불러 둔 i2i 소스는 무시하고 만든다.
 *
 * 바뀐 것만 보내려고 마지막에 보낸 해시를 메모리에 둔다(재시작하면 비고, 메인이 한 번 더 걸러 준다).
 */

/** 한 번에 보내는 항목 수 — 클라우드 한도(본문 2MB·200개)와 같다 */
const CHUNK = 200
/**
 * UI가 멈추지 않게, 계산을 이 시간(ms) 넘게 붙잡고 있으면 이벤트 루프를 양보한다.
 * 씬 하나의 계산 시간은 설정에 따라 크게 달라서(캐릭터·복장·추가가 많으면 씬당 1ms 넘음) 개수 기준은 맞지 않는다.
 * 한 프레임(약 16ms)의 절반 안쪽.
 */
const YIELD_AFTER_MS = 8
/** 설정·캐릭터·씬이 바뀐 뒤 이 시간 동안 더 바뀌지 않으면 계산한다 */
const DEBOUNCE_MS = 20_000
/** needPrepared·켜짐 같은 급한 요청은 묶음 처리를 위해 아주 짧게만 기다린다 */
const SOON_MS = 300
/** 실패하면 이 간격으로 다시 시도 (점점 늘려 최대치까지) */
const RETRY_MS = [60_000, 5 * 60_000]

/** 키 순서와 상관없는 JSON — 같은 내용이면 항상 같은 글자열 (해시용) */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`
  }
  const record = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(record).sort()) {
    const v = record[key]
    if (v === undefined || typeof v === 'function') continue
    parts.push(`${JSON.stringify(key)}:${stableStringify(v)}`)
  }
  return `{${parts.join(',')}}`
}

/**
 * FNV-1a 64비트 (UTF-16 코드 단위 기준) → 16자리 16진수. 변경 감지용이라 암호학적 강도는 필요 없다.
 * 64비트 곱셈을 32비트 두 조각으로 나눠 BigInt 없이 계산한다 (씬 수천 개를 훑어도 빠르게).
 */
export function hashText(text: string): string {
  let hi = 0xcbf29ce4
  let lo = 0x84222325
  for (let i = 0; i < text.length; i++) {
    lo = (lo ^ text.charCodeAt(i)) >>> 0
    // 소수 0x100000001b3 = 2^40 + 0x1b3 곱하기
    const product = lo * 0x1b3
    const carry = Math.floor(product / 4294967296)
    const newLo = product - carry * 4294967296
    hi = (hi * 0x1b3 + carry + ((lo << 8) >>> 0)) % 4294967296
    lo = newLo
  }
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0')
}

/**
 * 클라우드로 올릴 모양으로 다듬는다.
 * - 시드는 장마다 새로 뽑으므로 뺀다(-1 = 무작위). 안 빼면 생성할 때마다 해시가 바뀐다.
 * - i2i 소스 이미지는 싣지 않는다. 클라우드는 i2i를 만들지 않고(무료 조건) 씬 수만큼 큰 이미지를
 *   올리면 본문 한도를 넘기 때문이다. 다만 source 자리는 남겨, 클라우드가 「i2i 요청」으로 알아보고
 *   거절하게 한다 (지우면 소스 해상도의 일반 요청으로 잘못 만들어진다).
 *   완성 요청은 소스를 무시하고 조립하므로(ignoreSource) 보통은 source 가 없다 — 이 자리는 안전망이다.
 * - 입은 옷 자동 젖힘 메모(exposeNotes)와 몸 기준 재조립 메모(bodyNotes)도 뺀다. PC 화면에서 붙은 태그와 이유를 보이려는 것이라
 *   클라우드는 쓰지 않고, 본문만 키우고 해시를 흔든다 (붙은 태그는 이미 캐릭터 프롬프트에 들어 있다).
 *   후타 재조립 계획(futaPlan)은 남긴다 — 클라우드가 실행 직전 씬 프롬프트를 다시 합칠 때(refreshScenePrompts) 같은 치환을 다시 적용한다.
 * - source 가 없으면 i2i 강도·노이즈(i2iStrength·i2iNoise)도 뺀다. 소스가 있을 때만 쓰이는 값이라 요청 내용이
 *   아닌데, 남겨 두면 파라미터 창에서 i2i 강도만 바꿔도 모든 씬·메인의 해시가 달라져 전부 다시 올라간다.
 *   (워커는 source 가 없는 요청에서 이 두 값을 읽지 않는다.)
 */
export function toCloudRequest(request: GenerationRequest): GenerationRequest {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- 화면 표시용이라 클라우드로 올리지 않는다
  const { source, i2iStrength, i2iNoise, exposeNotes: _n, bodyNotes: _b, ...rest } = request
  if (!source) return { ...rest, seed: -1 }
  return {
    ...rest,
    ...(i2iStrength !== undefined ? { i2iStrength } : {}),
    ...(i2iNoise !== undefined ? { i2iNoise } : {}),
    seed: -1,
    source: { strength: source.strength, noise: source.noise, imageBase64: '' }
  }
}

function toItem(key: string, request: GenerationRequest): CloudPreparedItem {
  const cloudRequest = toCloudRequest(request)
  return { key, hash: hashText(stableStringify(cloudRequest)), request: cloudRequest }
}

/**
 * 완성 요청에 실리지 않는 설정 키 — 바뀌어도 다시 계산할 이유가 없다.
 * 시드(생성할 때마다 바뀜)와 i2i 강도·노이즈(완성 요청은 PC의 소스를 무시하고 만들어 늘 source 가 없다 — toCloudRequest 가 뺀다).
 */
const REQUEST_IGNORED_KEYS = new Set(['seed', 'i2iStrength', 'i2iNoise'])

/** 완성 요청에 실리는 생성 설정이 바뀌었는가 (시드·i2i 강도·노이즈는 무시) */
function requestChanged(a: GenerationRequest, b: GenerationRequest): boolean {
  if (a === b) return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (REQUEST_IGNORED_KEYS.has(key)) continue
    if (
      (a as unknown as Record<string, unknown>)[key] !==
      (b as unknown as Record<string, unknown>)[key]
    ) {
      return true
    }
  }
  return false
}

/** 씬 요청에 영향을 주는 필드만 비교한다 (이름·이미지 수·예약 수는 요청과 무관) */
function sceneRequestChanged(a: Scene, b: Scene): boolean {
  return (
    a.prompt !== b.prompt ||
    a.negativePrompt !== b.negativePrompt ||
    a.width !== b.width ||
    a.height !== b.height ||
    a.varietyPlus !== b.varietyPlus ||
    a.sourceTags !== b.sourceTags ||
    a.targetTags !== b.targetTags ||
    JSON.stringify(a.sourcePos) !== JSON.stringify(b.sourcePos) ||
    JSON.stringify(a.targetPos) !== JSON.stringify(b.targetPos) ||
    JSON.stringify(a.censorKinds) !== JSON.stringify(b.censorKinds) ||
    JSON.stringify(a.censorTagWeights) !== JSON.stringify(b.censorTagWeights) ||
    a.suppressAnal !== b.suppressAnal ||
    JSON.stringify(a.background) !== JSON.stringify(b.background)
  )
}

type ScenesState = ReturnType<typeof useScenesStore.getState>

/** 씬 목록이 어느 프리셋·라이브러리의 것인지 — 이게 달라지면 목록이 통째로 바뀐 것이다 */
const viewKey = (s: ScenesState): string => `${s.libraryKind}:${s.activePresetId}`

/** 프리셋 구성이 바뀌어 완성 요청을 다시 봐야 하는가 (추가·삭제·순서) */
function presetsChanged(s: ScenesState, p: ScenesState): boolean {
  if (s.presets === p.presets) return false
  // 씬↔배경 라이브러리를 바꾸면 프리셋 목록이 비었다가 다른 목록으로 채워진다 — 구성이 바뀐 게 아니다
  if (s.libraryKind !== p.libraryKind || p.presets.length === 0) return false
  const ids = (list: ScenesState['presets']): string => list.map((x) => x.id).join(',')
  return ids(s.presets) !== ids(p.presets)
}

/**
 * 같은 프리셋 안에서 씬 목록이 바뀌어 완성 요청을 다시 봐야 하는가.
 * 프리셋을 옮겨 목록이 통째로 달라진 것은 호출하는 쪽에서 걸러 낸다 (요청이 바뀐 게 아니다).
 */
function sceneListChanged(s: ScenesState, p: ScenesState): boolean {
  if (s.scenes === p.scenes) return false
  const first = s.scenes[0]
  const prevFirst = p.scenes[0]
  if (!first || !prevFirst) {
    // 비었다가 채워지거나 전부 지워짐. 라이브러리를 바꾸는 중이면 목록이 새로 채워지는 것일 뿐이다
    return s.scenes.length !== p.scenes.length && !s.libraryLoading && !p.libraryLoading
  }
  if (first.presetId !== prevFirst.presetId) return false // 다른 프리셋의 씬으로 통째로 바뀜
  if (s.scenes.length !== p.scenes.length) return true
  const before = new Map(p.scenes.map((scene) => [scene.id, scene]))
  for (const scene of s.scenes) {
    const old = before.get(scene.id)
    if (!old || sceneRequestChanged(scene, old)) return true
  }
  return false
}

/** 설정 복원이 끝나 올려도 되는 상태가 될 때까지 기다린다 (덜 읽은 기본값을 올리거나 덮지 않게) */
export function whenStoresReady(): Promise<void> {
  const ready = (): boolean =>
    useGenerationStore.getState().hydrated && useCharactersStore.getState().loaded
  if (ready()) return Promise.resolve()
  return new Promise((resolve) => {
    const offs: (() => void)[] = []
    const check = (): void => {
      if (!ready()) return
      offs.forEach((off) => off())
      resolve()
    }
    offs.push(useGenerationStore.subscribe(check), useCharactersStore.subscribe(check))
  })
}

const nowMs = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/**
 * 이벤트 루프를 한 번 양보한다. setTimeout(0) 대신 MessageChannel 을 쓴다 — 창이 최소화되거나 가려지면
 * 타이머는 최소 1초(오래 가려지면 분당 1회)로 제한되어 계산이 몇 분씩 늘어지지만, 메시지는 제한이 없다.
 */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0)
      return
    }
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = (): void => {
      port1.close() // 짝인 port2 도 함께 닫힌다
      resolve()
    }
    port2.postMessage(null)
  })
}

/** 앱 시작 때 한 번 — 반환값은 해제 함수 */
export function startCloudPrepared(): () => void {
  /** key → 마지막으로 메인에 보낸 해시 */
  const sent = new Map<string, string>()
  /** 클라우드가 「전부 다시」를 요구한 횟수 — 진행 중인 계산이 옛 결과를 sent 에 쓰지 않게 */
  let epoch = 0
  let enabled = false
  let stopped = false
  let running = false
  let dirty = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerSoon = false

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    timerSoon = false
  }

  const schedule = (soon: boolean, delay = soon ? SOON_MS : DEBOUNCE_MS): void => {
    if (stopped || !enabled) return
    // 급한 요청이 기다리는 중이면 평범한 변경이 그걸 늦추지 않는다
    if (timer && timerSoon && !soon) return
    clearTimer()
    timerSoon = soon
    timer = setTimeout(() => {
      timer = null
      timerSoon = false
      void run()
    }, delay)
  }

  /** 한 번 계산해서 바뀐 것만 보낸다. 보내다 실패하면 던진다 */
  const runOnce = async (): Promise<void> => {
    await whenStoresReady()
    await ensureExtrasData()
    const startEpoch = epoch
    const generation = useGenerationStore.getState()
    const { items: scenes } = await window.nais.invoke('scenes:listAllLite', undefined)

    const hashes = new Map<string, string>()
    const changed: CloudPreparedItem[] = []
    const consider = (item: CloudPreparedItem): void => {
      hashes.set(item.key, item.hash)
      if (sent.get(item.key) !== item.hash) changed.push(item)
    }
    // PC에 불러 둔 i2i 소스는 무시하고 만든다 — 클라우드는 i2i를 만들지 않고(무료 조건 밖),
    // 소스가 섞이면 모든 씬·메인이 소스 해상도의 i2i 요청이 되어 클라우드가 전부 거절한다
    consider(toItem('main', await generation.buildMainRequest({ ignoreSource: true })))
    let sliceStart = nowMs()
    for (const scene of scenes) {
      if (nowMs() - sliceStart >= YIELD_AFTER_MS) {
        await yieldToUi()
        sliceStart = nowMs()
        // 양보하는 사이 꺼졌거나 「전부 다시」 요청이 왔으면 이 계산은 쓸모없다 (새 계산이 따로 예약돼 있다)
        if (stopped || !enabled || epoch !== startEpoch) return
      }
      consider(toItem(`scene:${scene.id}`, buildSceneRequest(scene, null, { ignoreSource: true })))
    }

    const gone = [...sent.keys()].filter((key) => !hashes.has(key))
    if (changed.length === 0 && gone.length === 0) return
    const allKeys = [...hashes.keys()]
    // 마지막 묶음에만 allKeys 를 실어 클라우드가 그 밖의 키를 지우게 한다
    const chunks = Math.max(1, Math.ceil(changed.length / CHUNK))
    for (let c = 0; c < chunks; c++) {
      const items = changed.slice(c * CHUNK, (c + 1) * CHUNK)
      const last = c === chunks - 1
      await window.nais.invoke('cloud:prepared', { items, ...(last ? { allKeys } : {}) })
      if (epoch !== startEpoch) return // 그 사이 「전부 다시」 요청이 와서 이 결과는 버린다
      for (const item of items) sent.set(item.key, item.hash)
      if (last) for (const key of gone) sent.delete(key)
    }
  }

  const run = async (): Promise<void> => {
    if (stopped || !enabled) return
    if (running) {
      dirty = true
      return
    }
    running = true
    try {
      do {
        dirty = false
        await runOnce()
      } while (dirty && !stopped && enabled)
      failures = 0
    } catch (e) {
      // 메인이 아직 못 받거나 네트워크가 끊긴 경우 — 조용히 두고 간격을 두고 다시 시도한다
      console.warn('클라우드 생성용 요청 올리기 실패', e)
      const wait = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]
      failures++
      schedule(false, wait)
    } finally {
      running = false
    }
  }

  const applyStatus = (status: CloudPcStatus): void => {
    // 클라우드 생성이 켜져 있고, 동기화가 켜져 있고, 앱·워커 판이 맞을 때만 올린다.
    // 메인은 그 밖의 상태에서는 올리기를 조용히 무시하고 정상 반환하므로, 이때 보내면
    // 보낸 것으로 기록만 남고 클라우드에는 옛 완성 요청이 그대로 남는다
    const on = !!status.cloudGen.enabled && !!status.enabled && !status.protocolMismatch
    if (on === enabled) return
    enabled = on
    epoch++ // 진행 중인 계산이 옛 상태에서 얻은 결과를 sent 에 쓰지 않게
    if (on) {
      // 못 올라가던 동안 바뀐 것을 놓치지 않게 보낸 기록을 비우고 전부 다시 보낸다.
      // 앱을 켜자마자 이미 켜져 있던 경우도 여기로 온다
      sent.clear()
      schedule(true)
    } else {
      clearTimer()
      dirty = false
    }
  }

  const touch = (): void => schedule(false)

  const offStatus = window.nais.on('cloud:status', applyStatus)
  const offNeed = window.nais.on('cloud:needPrepared', ({ full }) => {
    if (full) {
      sent.clear()
      epoch++
    }
    schedule(true)
  })
  void window.nais
    .invoke('cloud:status', undefined)
    .then(applyStatus)
    .catch(() => undefined) // 메인이 아직 준비 안 됐거나 클라우드 기능이 없는 빌드

  /** 마지막으로 씬 목록이 바뀔 때의 프리셋·라이브러리 — 프리셋을 옮기며 목록이 바뀐 것을 가려내는 용도 */
  let scenesView = viewKey(useScenesStore.getState())

  const offs = [
    // i2i 소스(s.source)는 완성 요청에 쓰지 않으므로 보지 않는다 — 소스를 불러오거나 지워도 다시 계산할 이유가 없다
    useGenerationStore.subscribe((s, p) => {
      if (
        requestChanged(s.request, p.request) ||
        s.promptSplitEnabled !== p.promptSplitEnabled ||
        s.transparentBackground !== p.transparentBackground
      )
        touch()
    }),
    useCharactersStore.subscribe((s, p) => {
      if (s.items !== p.items) touch()
    }),
    useOutfitsStore.subscribe((s, p) => {
      if (
        s.items !== p.items ||
        s.acts !== p.acts ||
        s.stripOnNude !== p.stripOnNude ||
        s.exposeWorn !== p.exposeWorn ||
        s.futaReassembly !== p.futaReassembly ||
        s.futaViewFix !== p.futaViewFix ||
        // 눈이 안 보이면 눈 태그 빼기·알몸일 때 pink nipples (기본 꺼짐) — 캐릭터 칸 글이 달라지므로 완성 요청을 다시 만든다
        s.eyesClosedStrip !== p.eyesClosedStrip ||
        s.nudePinkNipples !== p.nudePinkNipples
      )
        touch()
    }),
    useSceneExtrasStore.subscribe((s, p) => {
      if (
        s.additions !== p.additions ||
        s.additionsEnabled !== p.additionsEnabled ||
        s.transparentBackgrounds !== p.transparentBackgrounds ||
        s.nudeStrips !== p.nudeStrips ||
        s.cardFits !== p.cardFits ||
        s.cardFitPresets !== p.cardFitPresets
      )
        touch()
    }),
    // 카드 태그 씬 맞춤 — 전체 설정·규칙표가 바뀌면 캐릭터 칸 글이 달라진다
    useCardFitStore.subscribe((s, p) => {
      if (s.version !== p.version) touch()
    }),
    useVibesStore.subscribe((s, p) => {
      if (s.items !== p.items) touch()
    }),
    useCharRefsStore.subscribe((s, p) => {
      if (s.items !== p.items) touch()
    }),
    useScenesStore.subscribe((s, p) => {
      if (presetsChanged(s, p)) touch()
      if (s.scenes === p.scenes) return
      // 프리셋을 바꾸면 활성 프리셋 id 가 먼저 바뀌고 씬 목록은 뒤따라 따로 바뀐다. 목록이 어느 프리셋의 것인지
      // 이전 목록과 달라졌으면 요청이 바뀐 게 아니라 다른 목록을 보여 주는 것이다
      const sameView = scenesView === viewKey(s)
      scenesView = viewKey(s)
      if (sameView && sceneListChanged(s, p)) touch()
    })
  ]

  return () => {
    stopped = true
    clearTimer()
    offStatus()
    offNeed()
    offs.forEach((off) => off())
  }
}
