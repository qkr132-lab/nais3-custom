import { mergePromptParts } from '@shared/scene-request'
import {
  CLOUD_JOB_MAX_COUNT,
  type CloudJob,
  type CloudMainPatch,
  type CloudOp,
  type CloudWork,
  type CloudWorkResult
} from '@shared/cloud-contract'
import type { CharacterCardPatch, GenerationRequest, IpcInvokeMap } from '@shared/types'
import { getMaxCharacters, useCharactersStore } from '../stores/characters-store'
import { useGenerationStore } from '../stores/generation-store'
import { enqueueSceneRequests, useScenesStore } from '../stores/scenes-store'
import { toast } from '../stores/toast-store'
import { startCloudPrepared, whenStoresReady } from './cloud-prepared'

/**
 * 모바일 클라우드 다리 — 메인이 폰에서 온 일을 넘기면 스토어를 거쳐 반영·생성하고 결과를 돌려준다
 * (커스텀, 설계 cloud/DESIGN.md 9절).
 *
 * 순서: ops 를 id 순으로 반영 → jobs 실행 → `cloud:workDone`.
 * 폰 편집은 PC에서 직접 고친 것과 같은 길(IPC·스토어)로 들어가므로 화면·대기 큐 갱신이 그대로 따라온다.
 */

/** 기억해 둘 처리 기록 수 — 메인이 같은 일을 다시 넘길 때 두 번 하지 않으려는 용도 */
const REMEMBER = 300

type SceneUpdatePatch = IpcInvokeMap['scenes:update']['req']['patch']

/** 메인 IPC 오류의 「Error invoking remote method …:」 머리말을 걷어 사람이 읽을 글만 남긴다 */
function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return (
    raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '').trim() ||
    '알 수 없는 오류'
  )
}

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  if (map.size > REMEMBER) map.delete(map.keys().next().value as K)
}

/** 켜 둔 캐릭터가 이미 모델 상한이라 폰이 켠 캐릭터를 켤 수 없음 — 편집 실패로 알린다 */
class CharacterLimitError extends Error {
  constructor(readonly max: number) {
    super(`캐릭터는 최대 ${max}명까지 켤 수 있습니다`)
  }
}

/** 씬 패치 — 계약이 허용한 다섯 필드 중 값이 있는 것만 */
function scenePatchOf(op: Extract<CloudOp, { type: 'scene:update' }>): SceneUpdatePatch {
  const { name, prompt, negativePrompt, width, height } = op.patch
  const patch: SceneUpdatePatch = {}
  if (typeof name === 'string') patch.name = name
  if (typeof prompt === 'string') patch.prompt = prompt
  if (typeof negativePrompt === 'string') patch.negativePrompt = negativePrompt
  if (typeof width === 'number') patch.width = width
  if (typeof height === 'number') patch.height = height
  return patch
}

/** 메인 탭 편집 — 분할 모드면 칸(promptParts), 아니면 한 줄 프롬프트에 반영 (requestForPromptMode 규칙) */
function applyMainPatch(patch: CloudMainPatch): void {
  const generation = useGenerationStore.getState()
  const next: Partial<GenerationRequest> = {}
  if (typeof patch.negativePrompt === 'string') next.negativePrompt = patch.negativePrompt
  if (generation.promptSplitEnabled && patch.promptParts) next.promptParts = patch.promptParts
  else if (typeof patch.prompt === 'string') next.prompt = patch.prompt
  else if (patch.promptParts) next.prompt = mergePromptParts(patch.promptParts)
  if (Object.keys(next).length > 0) generation.patchRequest(next)
}

async function applyOp(op: CloudOp): Promise<void> {
  switch (op.type) {
    case 'scene:update': {
      const patch = scenePatchOf(op)
      if (Object.keys(patch).length === 0) return
      await window.nais.invoke('scenes:update', { id: op.sceneId, patch })
      // 지금 목록에 있는 씬(활성 프리셋)이면 다시 읽는다 — 상세 화면도 이 목록의 씬을 그대로 보여 준다.
      // 위 IPC 가 성공했으면 반영은 끝난 것이다 — 목록을 다시 읽다 던져도 편집 실패로 세지 않고 경고만 남긴다
      // (실패로 세면 폰 사본이 PC 가 실제로 가진 값과 다른 옛 값으로 되돌려진다)
      const scenes = useScenesStore.getState()
      if (scenes.scenes.some((s) => s.id === op.sceneId)) {
        try {
          await scenes.load()
        } catch (e) {
          console.warn('씬 목록 다시 읽기 실패 (편집은 반영됨)', e)
        }
      }
      return
    }
    case 'char:update': {
      const patch: CharacterCardPatch = {}
      if (typeof op.patch.enabled === 'boolean') patch.enabled = op.patch.enabled
      if (typeof op.patch.prompt === 'string') patch.prompt = op.patch.prompt
      if (Object.keys(patch).length === 0) return
      const characters = useCharactersStore.getState()
      if (!characters.loaded) await characters.load()
      // updateCard 는 상한을 넘겨 켜려 하면 예외 없이 아무것도 안 하고 돌아온다 — 그러면 폰은 반영된 줄 안다.
      // 같은 규칙(이미 켜진 카드는 제외하고 센다)으로 먼저 보고, 못 켜면 실패로 올린다
      if (patch.enabled === true) {
        const { items } = useCharactersStore.getState()
        const enabledOthers = items.filter((c) => c.enabled && c.id !== op.charId).length
        const max = getMaxCharacters()
        if (enabledOthers >= max) throw new CharacterLimitError(max)
      }
      useCharactersStore.getState().updateCard(op.charId, patch)
      return
    }
    case 'main:update':
      applyMainPatch(op.patch)
      return
    case 'job:cancel':
      // 메인이 직접 처리한다 — 넘어와도 할 일이 없다
      return
  }
}

/**
 * 작업 하나를 큐에 넣고 큐 id들을 돌려준다. 못 하면 던진다.
 * 요청마다 job.id 를 cloudJobId 로 달아 — 메인이 새로고침 뒤에도 같은 작업을 다시 넣지 않고 큐 진행을 이어 가게 한다.
 */
async function runJob(job: CloudJob): Promise<string[]> {
  const count = Math.max(1, Math.min(CLOUD_JOB_MAX_COUNT, Math.floor(job.count) || 1))
  if (job.target.type === 'main') {
    return useGenerationStore.getState().generateMain(count, job.id)
  }
  // scenes:get 은 휴지통에 있는 씬·프리셋도 돌려준다 — 먼저 살아 있는지 확인해야
  // PC 화면에 안 보이는 씬 이름으로 그림이 만들어지지 않는다
  const { live } = await window.nais.invoke('scenes:isLive', { id: job.target.sceneId })
  if (!live) throw new Error('씬이 PC에 없음')
  const { scene } = await window.nais.invoke('scenes:get', { id: job.target.sceneId })
  if (!scene) throw new Error('씬이 PC에 없음')
  return enqueueSceneRequests(scene, count, job.id)
}

/** 앱 시작 때 한 번 — 반환값은 해제 함수 */
export function startCloudBridge(): () => void {
  let stopped = false
  /**
   * 이미 처리한 편집 줄 id → 반영에 성공했는가.
   * 실패도 기억해, 메인이 같은 줄을 다시 넘기거나 workDone 이 메인에 닿지 못해 다시 보낼 때
   * failedOpIds 에 계속 실어 보낸다 (처음 한 번만 알리면 메인이 폰 사본을 되돌릴 기회를 놓친다).
   */
  const appliedOps = new Map<number, boolean>()
  /** 이미 넘긴 작업의 결과 — 메인이 같은 작업을 다시 주면 새로 생성하지 않고 이 결과를 돌려준다 */
  const doneJobs = new Map<string, CloudWorkResult['jobs'][number]>()
  /** 들어온 순서대로 하나씩 처리한다 (편집 → 생성 순서가 뒤섞이지 않게) */
  let chain: Promise<void> = Promise.resolve()

  const handleWork = async (work: CloudWork): Promise<void> => {
    // 설정 복원 전에 건드리면 기본값이 저장된 설정을 덮는다 — 준비될 때까지 기다린다
    await whenStoresReady()
    if (stopped) return

    const opIds: number[] = []
    /** 이번에 처음 실패한 편집 수 — 사용자 알림용 (다시 받은 실패 줄은 이미 알렸다) */
    let newlyFailed = 0
    /** 반영하지 못한 편집 줄 id (이전에 실패한 줄 포함) — 메인에 알려 폰 사본을 PC 실제 값으로 되돌리게 한다 */
    const failedOpIds: number[] = []
    let characterLimit: number | null = null
    for (const op of [...work.ops].sort((a, b) => a.id - b.id)) {
      const known = appliedOps.get(op.id)
      if (known === undefined) {
        let applied = true
        try {
          await applyOp(op)
        } catch (e) {
          // 계속 실패하는 편집 하나가 뒤의 편집을 막지 않도록 확인은 하고, 사용자에게 알린다
          applied = false
          newlyFailed++
          if (e instanceof CharacterLimitError) characterLimit = e.max
          console.warn('폰 편집 반영 실패', op.type, e)
        }
        remember(appliedOps, op.id, applied)
        if (!applied) failedOpIds.push(op.id)
      } else if (!known) {
        failedOpIds.push(op.id)
      }
      opIds.push(op.id)
    }
    if (newlyFailed > 0) {
      // 캐릭터를 못 켠 경우는 이유를 덧붙인다 — 폰에서는 스위치가 켜진 채로 보이기 때문
      const reason =
        characterLimit != null ? `. 캐릭터는 최대 ${characterLimit}명까지 켤 수 있습니다` : ''
      toast(`폰에서 보낸 편집 ${newlyFailed}건을 반영하지 못했습니다${reason}`, 'error')
    }

    const jobs: CloudWorkResult['jobs'] = []
    for (const job of work.jobs) {
      const known = doneJobs.get(job.id)
      if (known) {
        jobs.push(known)
        continue
      }
      let result: CloudWorkResult['jobs'][number]
      try {
        result = { id: job.id, queueIds: await runJob(job) }
      } catch (e) {
        result = { id: job.id, queueIds: [], error: errorText(e) }
      }
      remember(doneJobs, job.id, result)
      jobs.push(result)
    }

    if (opIds.length === 0 && jobs.length === 0) return
    // opIds 에는 실패한 줄도 넣는다(ack 는 계속) — failedOpIds 는 그중 반영하지 못한 줄이며, 없으면 자리를 만들지 않는다
    await window.nais.invoke('cloud:workDone', {
      opIds,
      ...(failedOpIds.length > 0 ? { failedOpIds } : {}),
      jobs
    })
  }

  const offWork = window.nais.on('cloud:work', (work) => {
    chain = chain
      .then(() => handleWork(work))
      .catch((e) => console.warn('클라우드 작업 처리 실패', e))
  })
  const offPrepared = startCloudPrepared()

  // 스토어 준비가 끝난 뒤에야 메인이 일을 넘기게 한다
  void whenStoresReady().then(() => {
    if (stopped) return
    return window.nais.invoke('cloud:rendererReady', undefined).catch(() => undefined)
  })

  return () => {
    stopped = true
    offWork()
    offPrepared()
  }
}
