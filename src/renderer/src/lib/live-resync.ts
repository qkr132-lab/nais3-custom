import { useCharRefsStore, useVibesStore } from '../stores/refs-store'
import { useCharactersStore } from '../stores/characters-store'
import { useGenerationStore } from '../stores/generation-store'
import { useSceneExtrasStore } from '../stores/scene-extras-store'
import { useScenesStore } from '../stores/scenes-store'
import { toast } from '../stores/toast-store'

/**
 * 생성 중 편집 자동 반영 (커스텀).
 * 프롬프트/캐릭터/씬별추가/바이브/캐릭레퍼를 고치면, 잠깐 뒤(입력이 멎으면)
 * 아직 안 뽑힌(pending) 큐 항목을 현재 상태로 다시 만든다. 돌아가는 중인 항목은 제외.
 */

let timer: ReturnType<typeof setTimeout> | null = null

function schedule(): void {
  const items = useGenerationStore.getState().queue?.items ?? []
  const hasPending = items.some((i) => i.state === 'pending')
  if (!hasPending) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void useScenesStore
      .getState()
      .resyncPendingScenes()
      .catch(() => toast('대기 중인 생성에 변경을 반영하지 못했어요. 다시 적용해 주세요.', 'error'))
  }, 500)
}

let started = false

/** 앱 시작 시 한 번만 호출 — 편집 관련 스토어 변경을 구독한다. */
export function initLiveResync(): void {
  if (started) return
  started = true

  // 메인 프롬프트/설정 + i2i 소스 (queue 변경 등 무관한 갱신은 걸러낸다)
  useGenerationStore.subscribe((s, p) => {
    if (s.request !== p.request || s.source !== p.source) schedule()
  })
  useScenesStore.subscribe((s, p) => {
    if (s.scenes === p.scenes) return
    const previous = new Map(p.scenes.map((scene) => [scene.id, scene]))
    if (
      s.scenes.some((scene) => {
        const old = previous.get(scene.id)
        return (
          old &&
          (scene.prompt !== old.prompt ||
            scene.negativePrompt !== old.negativePrompt ||
            JSON.stringify(scene.censorKinds) !== JSON.stringify(old.censorKinds) ||
            JSON.stringify(scene.censorWeights) !== JSON.stringify(old.censorWeights))
        )
      })
    )
      schedule()
  })
  // 캐릭터 탭 — 카드 프롬프트/순서
  useCharactersStore.subscribe((s, p) => {
    if (s.items !== p.items) schedule()
  })
  // 씬별 추가 / 큐 반복 선택 (항목 편집·역할 변경 포함)
  useSceneExtrasStore.subscribe((s, p) => {
    if (
      s.additions !== p.additions ||
      s.additionsEnabled !== p.additionsEnabled ||
      s.entries !== p.entries ||
      s.sequenceEnabled !== p.sequenceEnabled
    )
      schedule()
  })
  // 바이브 / 캐릭레퍼 (enabled·강도·타입 등)
  useVibesStore.subscribe((s, p) => {
    if (s.items !== p.items) schedule()
  })
  useCharRefsStore.subscribe((s, p) => {
    if (s.items !== p.items) schedule()
  })
}
