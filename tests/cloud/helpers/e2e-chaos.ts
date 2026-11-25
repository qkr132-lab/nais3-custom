// 테스트 전용 — 무작위 사건 순서로 종단 흐름을 흔들어 보는 도구.
// 같은 시드면 같은 사건 순서가 나온다 (큐는 실제 타이머로 돌아서 끼어드는 순서만 조금 달라질 수 있다).
// 사건이 끝난 뒤 모든 장애를 걷어 내고 「회복」시켜서, 작업이 끝 상태로 수렴하는지와 중복·초과가 없는지를 본다.
import { reply } from './nai'
import { World, pressCancelAll, sleep, type Pc } from './e2e-world'

export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TERMINAL = new Set(['done', 'failed', 'cancelled'])

interface PhoneJob {
  id: string
  state: string
  done: number
  failed: number
  count: number
}

type Match = (method: string, path: string) => boolean

export interface ChaosResult {
  /** 어긋난 점 (비어 있어야 한다) */
  problems: string[]
  /** 알려 둘 만한 것 (실패는 아님) */
  notes: string[]
}

async function phoneJobs(world: World): Promise<PhoneJob[]> {
  return (await world.phone('GET', '/api/state')).json.jobs as PhoneJob[]
}

function finish(world: World, problems: string[]): void {
  try {
    world.assertNoSecrets()
  } catch (e) {
    problems.push(`비밀값 검사 실패: ${(e as Error).message.slice(0, 200)}`)
  }
}

/**
 * PC 쪽 흔들기: 폰 작업 만들기(응답 유실 재시도 포함)·취소, poll, 시간 흘리기, 렌더러 새로고침(처리 도중 포함),
 * PC 재시작, 워커 인스턴스 재시작, PC 「모두 취소」(실제 렌더러 스토어), 네트워크 끊김, 생성 붙들기. 회복 뒤 확인:
 *  - 모든 작업이 끝 상태 · 장수 합이 count 를 안 넘음
 *  - 같은 requestId 는 같은 작업 · 「모두 취소」가 폰 작업을 씬 예약 수로 되돌리지 않음
 *  - 같은 PC 프로세스가 같은 작업을 큐에 두 번 넣지 않음 (렌더러 새로고침 중복 방지)
 * 재시작을 건너는 중복 생성은 「앱이 죽기 전에 받았다는 ack 가 못 간」 경우라 어쩔 수 없어 notes 로만 센다.
 */
export async function runPcChaos(seed: number, steps = 45): Promise<ChaosResult> {
  const problems: string[] = []
  const notes: string[] = []
  const world = new World()
  const rand = mulberry32(seed)
  const trace: string[] = []
  let pc: Pc = world.startPc()
  const pcs: Pc[] = [pc]
  try {
    await world.pairPhone(pc)
    await pc.sync.syncNow()
    await world.settle()
    const jobs: { id: string; count: number }[] = []
    const failures: Match[] = [
      (m, p) => m === 'POST' && p === '/api/pc/ack',
      (m, p) => m === 'POST' && p === '/api/pc/poll',
      (m, p) => m === 'PUT' && /\/images\//.test(p),
      (m, p) => m === 'PUT' && p === '/api/pc/scenes'
    ]
    for (let step = 0; step < steps; step++) {
      const r = rand()
      if (r < 0.22) {
        const target =
          rand() < 0.2
            ? ({ type: 'main' } as const)
            : ({ type: 'scene', sceneId: 1 + Math.floor(rand() * 2) } as const)
        const count = 1 + Math.floor(rand() * 3)
        const place = rand() < 0.5 ? 'pc' : 'auto'
        const requestId = `req-${seed}-${step}`
        const made = await world.createJob(target, count, place, requestId)
        if (made.status === 200) {
          jobs.push({ id: made.id, count })
          if (rand() < 0.3) {
            // 응답이 유실돼 폰이 같은 요청을 다시 보냈다 — 같은 작업이 돌아와야 한다
            const again = await world.createJob(target, count, place, requestId)
            if (again.id !== made.id)
              problems.push(`같은 requestId 가 다른 작업 ${again.id} 를 만듦 (≠ ${made.id})`)
          }
        }
        trace.push(`작업${count}`)
      } else if (r < 0.42) {
        const drop = rand() < 0.3 // 큐에 넣고 workDone 전에 렌더러가 새로고침됐다
        if (drop) pc.renderer.dropWorkDone = true
        await pc.sync.pollOnce()
        trace.push('poll')
        if (drop) {
          await world.settle()
          pc.reloadRenderer()
          trace.push('처리중새로고침')
        }
      } else if (r < 0.52) {
        const ms = Math.floor(rand() * 70_000)
        world.tick(ms)
        trace.push(`시간${ms}`)
      } else if (r < 0.6) {
        pc.reloadRenderer()
        trace.push('새로고침')
      } else if (r < 0.65) {
        pc.kill()
        pc = world.startPc()
        pcs.push(pc)
        trace.push('재시작')
      } else if (r < 0.74) {
        world.inject(failures[Math.floor(rand() * failures.length)], () => new TypeError('끊김'))
        trace.push('끊김')
      } else if (r < 0.8 && jobs.length > 0) {
        const job = jobs[Math.floor(rand() * jobs.length)]
        await world.phone('POST', `/api/jobs/${job.id}/cancel`)
        trace.push('취소')
      } else if (r < 0.88) {
        if (rand() < 0.5) pc.hold()
        else pc.release()
        trace.push('문')
      } else if (r < 0.91) {
        // 워커 인스턴스가 내려갔다 올라왔다 (메모리의 켜짐 표시·그림 수는 비고 저장소는 그대로)
        world.cloud.restartInstance()
        trace.push('워커재시작')
      } else if (r < 0.94) {
        // PC 사용자가 「모두 취소」를 눌렀다 (실제 렌더러 스토어) — 폰 작업 항목은 씬 예약 수로 돌아가면 안 된다
        await pressCancelAll(pc)
        trace.push('모두취소')
      } else {
        await sleep(20)
      }
    }

    // 회복: 붙든 것을 풀고, 끝 상태가 될 때까지 시간을 흘리며 poll
    for (const p of pcs) p.release()
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      world.tick(5000)
      await pc.sync.pollOnce()
      await world.settle()
      await sleep(25)
      const state = await phoneJobs(world)
      if (jobs.every((j) => TERMINAL.has(state.find((x) => x.id === j.id)?.state ?? ''))) break
    }
    await pc.sync.drainUploads()
    await world.settle()

    const state = await phoneJobs(world)
    const tail = trace.slice(-14).join(',')
    let crossProcess = 0
    for (const job of jobs) {
      const view = state.find((x) => x.id === job.id)
      if (!view) {
        problems.push(`작업 ${job.id} 가 폰 목록에 없음`)
        continue
      }
      if (!TERMINAL.has(view.state)) {
        const row = world.job(job.id)
        problems.push(
          `작업이 끝나지 않음: ${view.state} ${view.done}+${view.failed}/${view.count} accepted_at=${row.accepted_at} (…${tail})`
        )
      }
      if (view.done + view.failed > view.count) {
        problems.push(`장수 초과: ${view.done}+${view.failed} > ${view.count}`)
      }
      const processes = pcs.filter((p) =>
        p.enqueueCalls.some((call) => call.some((q) => q.cloudJobId === job.id))
      )
      for (const [index, p] of pcs.entries()) {
        const times = p.enqueueCalls.filter((call) =>
          call.some((q) => q.cloudJobId === job.id)
        ).length
        if (times > 1)
          problems.push(`PC#${index} 가 작업 ${job.id} 를 ${times}번 큐에 넣음 (…${tail})`)
      }
      const generated = pcs.reduce(
        (n, p) => n + p.generated.filter((g) => g.request.cloudJobId === job.id).length,
        0
      )
      if (generated > job.count) {
        if (processes.length > 1) crossProcess++
        else problems.push(`한 프로세스에서 중복 생성: ${generated} > ${job.count} (…${tail})`)
      }
    }
    if (crossProcess > 0) notes.push(`재시작을 건너 중복 생성된 작업 ${crossProcess}건`)
    // PC 사용자가 예약한 항목은 없었다 — 「모두 취소」가 폰 작업 항목을 씬 예약 수로 되돌렸다면 0 이 아니다
    const reserved = world.db.scenes.filter((s) => s.reserveCount !== 0).map((s) => s.id)
    if (reserved.length > 0) problems.push(`씬 예약 수가 늘어남: 씬 ${reserved.join(',')}`)
    finish(world, problems)
  } catch (e) {
    problems.push(`예외: ${(e as Error).stack ?? e}`)
  } finally {
    world.dispose()
  }
  return { problems: problems.map((p) => `시드 ${seed}: ${p}`), notes }
}

/**
 * 클라우드 쪽 흔들기: 클라우드 생성이 켜진 채로 폰 작업(PC·auto·cloud), 알람 울리기, PC 끄기/켜기,
 * 가져오기 단계 네트워크 끊김, NAI 오류(500·429·zip 아님), 취소, 시간 흘리기, 워커 인스턴스 재시작,
 * 응답 유실 재시도(같은 requestId).
 * 회복 뒤 확인: 모든 작업이 끝 상태 · 장수 초과 없음 · PC 가 안 가져간 클라우드 그림이 없음 ·
 * PC 를 몇 번 껐다 켜도 저장 호출 수 == 클라우드 그림 수 (같은 그림을 두 번 저장하지 않는다).
 */
export async function runCloudChaos(seed: number, steps = 40): Promise<ChaosResult> {
  const problems: string[] = []
  const notes: string[] = []
  const world = new World()
  const rand = mulberry32(seed)
  const trace: string[] = []
  let pc: Pc | null = world.startPc()
  const pcs: Pc[] = [pc]
  let restarts = 0
  try {
    await world.pairPhone(pc)
    await pc.sync.syncNow()
    await pc.sync.setCloudGen(true)
    await world.settle()
    const jobs: { id: string; count: number }[] = []
    const failures: Match[] = [
      (m, p) => m === 'GET' && /cloud-images\/.*\/file/.test(p),
      (m, p) => m === 'GET' && p === '/api/pc/cloud-images',
      (m, p) => m === 'POST' && p === '/api/pc/ack'
    ]
    for (let step = 0; step < steps; step++) {
      const r = rand()
      if (r < 0.2) {
        const target =
          rand() < 0.2
            ? ({ type: 'main' } as const)
            : ({ type: 'scene', sceneId: 1 + Math.floor(rand() * 2) } as const)
        const count = 1 + Math.floor(rand() * 3)
        const place = (['pc', 'auto', 'cloud'] as const)[Math.floor(rand() * 3)]
        const requestId = `req-${seed}-${step}`
        const made = await world.createJob(target, count, place, requestId)
        if (made.status === 200) {
          jobs.push({ id: made.id, count })
          if (rand() < 0.3) {
            // 응답이 유실돼 폰이 같은 요청을 다시 보냈다 — 같은 작업이 돌아와야 한다
            const again = await world.createJob(target, count, place, requestId)
            if (again.id !== made.id)
              problems.push(`같은 requestId 가 다른 작업 ${again.id} 를 만듦 (≠ ${made.id})`)
          }
        }
        trace.push(`작업${count}${place}`)
      } else if (r < 0.34) {
        await world.cloud.runAlarms(1 + Math.floor(rand() * 3))
        trace.push('알람')
      } else if (r < 0.46) {
        if (pc) {
          pc.kill()
          pc = null
          world.tick(20_000)
          trace.push('끔')
        } else {
          pc = world.startPc()
          pcs.push(pc)
          restarts++
          await pc.sync.syncNow()
          trace.push('켬')
        }
      } else if (r < 0.58) {
        if (pc) await pc.sync.pollOnce()
        trace.push('poll')
      } else if (r < 0.66) {
        if (pc) await pc.sync.importOnce()
        trace.push('가져오기')
      } else if (r < 0.74) {
        world.inject(failures[Math.floor(rand() * failures.length)], () => new TypeError('끊김'))
        trace.push('끊김')
      } else if (r < 0.8) {
        const kind = rand()
        const queue = world.cloud.nai.generateQueue
        if (kind < 0.4) queue.push(reply(500, 'boom'))
        else if (kind < 0.7) queue.push(reply(429, '', { 'retry-after': '3' }))
        else queue.push(reply(200, 'not a zip', { 'content-type': 'text/plain' }))
        trace.push('NAI오류')
      } else if (r < 0.86 && jobs.length > 0) {
        const job = jobs[Math.floor(rand() * jobs.length)]
        await world.phone('POST', `/api/jobs/${job.id}/cancel`)
        trace.push('취소')
      } else if (r < 0.9) {
        world.tick(Math.floor(rand() * 80_000))
        trace.push('시간')
      } else if (r < 0.94) {
        // 워커 인스턴스가 내려갔다 올라왔다 (메모리의 켜짐 표시·그림 수는 비고 저장소는 그대로)
        world.cloud.restartInstance()
        trace.push('워커재시작')
      } else {
        await sleep(15)
      }
    }

    // 회복: PC 를 켜고, 알람을 다 울리고, 안 가져간 그림이 없을 때까지
    if (!pc) {
      pc = world.startPc()
      pcs.push(pc)
      restarts++
    }
    for (const p of pcs) p.release()
    const deadline = Date.now() + 40_000
    let settled = false
    while (Date.now() < deadline) {
      await world.cloud.runAlarms(10)
      world.tick(5000)
      await pc.sync.syncNow()
      await world.settle()
      await sleep(25)
      const state = await phoneJobs(world)
      const waiting = world.cloud
        .imageRows()
        .filter((row) => row.source === 'cloud' && row.imported === 0).length
      if (
        jobs.every((j) => TERMINAL.has(state.find((x) => x.id === j.id)?.state ?? '')) &&
        waiting === 0 &&
        world.cloud.pendingAlarm == null
      ) {
        settled = true
        break
      }
    }
    await pc.sync.drainUploads()
    await world.settle()

    const tail = trace.slice(-14).join(',')
    if (!settled) problems.push(`수렴하지 않음 (…${tail})`)
    const state = await phoneJobs(world)
    const rows = world.cloud.imageRows()
    for (const job of jobs) {
      const view = state.find((x) => x.id === job.id)
      if (!view) continue
      if (!TERMINAL.has(view.state)) {
        problems.push(`작업이 끝나지 않음: ${view.state} ${view.done}+${view.failed}/${view.count}`)
      }
      if (view.done + view.failed > view.count) {
        problems.push(`장수 초과: ${view.done}+${view.failed} > ${view.count}`)
      }
      const made = rows.filter((row) => row.job_id === job.id).length
      if (made > job.count) problems.push(`클라우드 그림 ${made}장 > 요청 ${job.count}장`)
    }
    const cloudRows = rows.filter((row) => row.source === 'cloud')
    const waiting = cloudRows.filter((row) => row.imported === 0).length
    if (waiting > 0) problems.push(`PC 가 안 가져간 클라우드 그림 ${waiting}장`)
    const saves = world.saveGenerated.mock.calls.length
    if (saves < cloudRows.length)
      problems.push(`저장 호출 ${saves}회 < 클라우드 그림 ${cloudRows.length}장`)
    // 알림 대기표를 설정에 적어 두므로, 재시작을 건너도 같은 클라우드 그림을 두 번 저장하지 않는다
    if (saves > cloudRows.length)
      problems.push(`저장 호출 ${saves}회 > 그림 ${cloudRows.length}장 (PC 재시작 ${restarts}번)`)
    finish(world, problems)
  } catch (e) {
    problems.push(`예외: ${(e as Error).stack ?? e}`)
  } finally {
    world.dispose()
  }
  return { problems: problems.map((p) => `시드 ${seed}: ${p}`), notes }
}
