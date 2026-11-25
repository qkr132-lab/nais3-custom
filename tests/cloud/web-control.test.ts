/**
 * 폰 → PC 제어 명령 맞물림 시험.
 *
 * 폰 화면은 esbuild 로만 묶여 타입 검사 없이도 「빌드」가 된다. 그래서 폰이 계약에 없는 종류(kind)나
 * 다른 필드 이름으로 보내도 버튼이 말없이 아무 일도 하지 않는 채로 나갈 수 있다. 여기서 세 곳을 맞대어 본다:
 *  - 계약: src/shared/cloud-contract.ts 의 CloudControlAction
 *  - PC 처리부: src/main/cloud/index.ts 의 handleControlOp (electron 에 묶여 있어 소스를 읽어 case 를 모은다)
 *  - 폰: cloud/web/lib/control.ts 의 pcControl (폰이 보내는 제어는 전부 여기서 만든다)
 * 마지막 묶음은 실제 워커와 실제 PC 동기화 코드에 흘려, 폰이 만든 명령이 그대로 PC 처리부에 닿는지 본다.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CloudControlAction } from '@shared/cloud-contract'
import { RECENT_UPLOAD_COUNT, pcControl } from '../../cloud/web/lib/control'
import { createCloudClient } from '../../src/main/cloud/client'
import { createCloudSync } from '../../src/main/cloud/sync'
import { GenerationQueue } from '../../src/main/queue/generation-queue'
import { PC_SECRET, World } from './helpers/e2e-world'

const root = path.resolve(__dirname, '..', '..')
const webDir = path.join(root, 'cloud', 'web')
const read = (...parts: string[]): string => readFileSync(path.join(root, ...parts), 'utf8')

// ── 소스에서 모으기 ─────────────────────────────────────────────────

interface ControlShape {
  required: string[]
  optional: string[]
}

/** 계약의 CloudControlAction — 종류마다 필드 이름 (필수·선택) */
function contractControls(): Map<string, ControlShape> {
  const block = /export type CloudControlAction =([\s\S]*?)\r?\n\s*\r?\n/.exec(
    read('src', 'shared', 'cloud-contract.ts')
  )
  if (!block) throw new Error('계약에서 CloudControlAction 을 찾지 못했습니다')
  const out = new Map<string, ControlShape>()
  for (const member of block[1].matchAll(/\{\s*kind:\s*'([^']+)'([^}]*)\}/g)) {
    const shape: ControlShape = { required: [], optional: [] }
    for (const field of member[2].matchAll(/(\w+)(\?)?\s*:/g)) {
      ;(field[2] ? shape.optional : shape.required).push(field[1])
    }
    out.set(member[1], shape)
  }
  return out
}

/** PC 처리부가 다루는 종류 — handleControlOp 의 case 들 */
function pcHandledKinds(): string[] {
  const body = /async function handleControlOp\([\s\S]*?\r?\n\}\r?\n/.exec(
    read('src', 'main', 'cloud', 'index.ts')
  )
  if (!body) throw new Error('PC 처리부에서 handleControlOp 를 찾지 못했습니다')
  return [...body[0].matchAll(/case '([^']+)':/g)].map((m) => m[1])
}

/** cloud/web 아래 .ts·.tsx 파일 전부 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 소스에 적힌 「이름:이름」 꼴 제어 종류 — 객체에 적은 것(literal)과 비교에 쓴 것(compared) */
function kindsIn(src: string): { literal: string[]; compared: string[] } {
  const pick = (re: RegExp): string[] => [...src.matchAll(re)].map((m) => m[1])
  return {
    literal: pick(/\bkind\s*:\s*['"`]([\w-]+:[\w-]+)['"`]/g),
    compared: pick(/\bkind\s*[!=]==?\s*['"`]([\w-]+:[\w-]+)['"`]/g)
  }
}

// ── 폰이 보낼 수 있는 제어 전부 ──────────────────────────────────────

const sent: CloudControlAction[] = [
  pcControl.refreshAccounts(),
  pcControl.setActiveAccount('acc-1'),
  pcControl.setTurbo(true),
  pcControl.setAutoSwitch(false),
  pcControl.uploadRecentImages(),
  pcControl.refreshDriveIndex(),
  pcControl.makeDriveFolder('그림/새 폴더'),
  pcControl.exportPresetToDrive(3, '그림/캐릭터'),
  pcControl.syncDriveFolder('그림/캐릭터')
]

const contract = contractControls()
const handled = pcHandledKinds()

describe('제어 종류 — 계약 · PC 처리부 · 폰', () => {
  it('계약에 있는 종류와 PC 처리부가 다루는 종류가 같다', () => {
    expect(contract.size).toBeGreaterThan(0)
    expect([...handled].sort()).toEqual([...contract.keys()].sort())
    expect(new Set(handled).size).toBe(handled.length)
  })

  it('이 시험이 폰의 제어 도우미를 하나도 빠뜨리지 않는다', () => {
    expect(sent).toHaveLength(Object.keys(pcControl).length)
    const written = kindsIn(read('cloud', 'web', 'lib', 'control.ts')).literal
    expect(written.length).toBeGreaterThan(0)
    expect([...new Set(sent.map((a) => a.kind))].sort()).toEqual([...new Set(written)].sort())
  })

  it('폰이 보내는 종류는 모두 계약에 있고 PC가 처리한다', () => {
    for (const action of sent) {
      expect(contract.has(action.kind), `계약에 없는 종류: ${action.kind}`).toBe(true)
      expect(handled, `PC가 처리하지 않는 종류: ${action.kind}`).toContain(action.kind)
    }
  })

  it('필드 이름이 계약과 같다 — 필수 필드는 다 있고, 계약에 없는 필드는 없다', () => {
    for (const action of sent) {
      const shape = contract.get(action.kind)
      if (!shape) throw new Error(`계약에 없는 종류: ${action.kind}`)
      const payload = action as unknown as Record<string, unknown>
      const fields = Object.keys(payload).filter((k) => k !== 'kind')
      for (const name of shape.required) {
        expect(payload[name], `${action.kind} 의 ${name}`).not.toBeUndefined()
      }
      for (const name of fields) {
        expect([...shape.required, ...shape.optional], `${action.kind} 의 ${name}`).toContain(name)
      }
    }
  })

  it('계정·고속 모드·그림 올리기는 PC가 읽는 이름 그대로 보낸다', () => {
    expect(pcControl.refreshAccounts()).toEqual({ kind: 'accounts:refresh' })
    expect(pcControl.setActiveAccount('acc-1')).toEqual({
      kind: 'account:setActive',
      accountId: 'acc-1'
    })
    expect(pcControl.setTurbo(true)).toEqual({ kind: 'turbo:set', enabled: true })
    expect(pcControl.setAutoSwitch(false)).toEqual({ kind: 'autoSwitch:set', enabled: false })
    expect(pcControl.uploadRecentImages()).toEqual({
      kind: 'images:uploadRecent',
      count: RECENT_UPLOAD_COUNT
    })
    expect(Number.isInteger(RECENT_UPLOAD_COUNT) && RECENT_UPLOAD_COUNT > 0).toBe(true)
    expect(pcControl.refreshDriveIndex()).toEqual({ kind: 'drive:refreshIndex' })
  })

  it('화면은 제어를 직접 적지 않고 lib/control.ts 로만 만든다', () => {
    const stray: string[] = []
    const compared: string[] = []
    for (const file of sourceFiles(webDir)) {
      const rel = path.relative(webDir, file).replace(/\\/g, '/')
      const found = kindsIn(readFileSync(file, 'utf8'))
      compared.push(...found.compared)
      if (rel !== 'lib/control.ts') stray.push(...found.literal.map((k) => `${rel}: ${k}`))
    }
    expect(stray).toEqual([])
    // 보낸 뒤 화면을 다시 받으려고 종류를 견주는 곳도 계약에 있는 이름만 쓴다
    for (const kind of compared) expect(contract.has(kind), `계약에 없는 종류: ${kind}`).toBe(true)
  })
})

describe('제어 전달 — 폰 → 워커 → PC', () => {
  it('폰이 만든 제어가 모양 그대로 PC 처리부에 한 번씩 닿고 확인(ack)된다', async () => {
    const world = new World()
    const received: CloudControlAction[] = []
    const sync = createCloudSync({
      client: createCloudClient({
        fetch: world.fetch as typeof fetch,
        url: () => world.config.url(),
        secret: () => PC_SECRET
      }),
      config: world.config,
      queue: new GenerationQueue(async () => 'unused'),
      broadcast: (() => undefined) as never,
      readSource: () => world.db.source(),
      images: world.imageDeps,
      getNaiToken: () => world.naiToken,
      onControlOp: (action) => void received.push(action),
      appVersion: '1.0.0-test',
      now: () => world.cloud.clock,
      sleep: async () => {}
    })
    try {
      const token = await world.cloud.pair()
      for (const action of sent) {
        const res = await world.cloud.phoneJson(token, 'POST', '/api/control', { action })
        expect(res.status).toBe(200)
        expect(typeof res.json.opId).toBe('number')
      }
      expect(world.unackedOps()).toBe(sent.length)

      await sync.pollOnce()
      expect(received).toEqual(sent)
      expect(world.unackedOps()).toBe(0)

      // 이미 넘긴 줄은 다시 넘기지 않는다
      await sync.pollOnce()
      expect(received).toHaveLength(sent.length)
    } finally {
      sync.stop()
    }
  })

  it('종류가 없는 제어 요청은 워커가 400 으로 막는다', async () => {
    const world = new World()
    const token = await world.cloud.pair()
    const bad = await world.cloud.phoneJson(token, 'POST', '/api/control', { action: {} })
    expect(bad.status).toBe(400)
    expect(world.unackedOps()).toBe(0)
  })
})
