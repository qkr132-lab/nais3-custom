import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 고속 모드 — 바이브 인코딩(회당 2 Anlas)은 작업자가 둘이어도 한 번만 나간다.
 * 합성 파일·가짜 DB·가짜 fetch 만 쓴다 (NAI 호출 없음).
 */

interface Row {
  id: number
  filePath: string
  strength: number
  infoExtracted: number
  encoded: string | null
  encodedIe: number | null
}

const db = vi.hoisted(() => ({ rows: [] as unknown[] }))

vi.mock('../src/main/refs/repo', () => ({
  enabledVibeRows: (ids?: number[]) =>
    (db.rows as Row[]).filter((r) => !ids || ids.includes(r.id)).map((r) => ({ ...r })),
  enabledCharRefRows: () => [],
  saveVibeEncoding: (id: number, encoded: string, ie: number) => {
    const row = (db.rows as Row[]).find((r) => r.id === id)
    if (row) {
      row.encoded = encoded
      row.encodedIe = ie
    }
  }
}))
vi.mock('sharp', () => ({ default: vi.fn() }))

import { prepareVibes } from '../src/main/refs/prepare'

let dir = ''
const gates = new Map<string, (res: { ok: boolean }) => void>()
const calls: string[] = []

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'nais-vibe-test-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function addRow(id: number, encoded: string | null = null): Row {
  const filePath = join(dir, `v${id}.bin`)
  writeFileSync(filePath, `vibe-${id}`)
  const row: Row = {
    id,
    filePath,
    strength: 0.6,
    infoExtracted: 1,
    encoded,
    encodedIe: encoded ? 1 : null
  }
  ;(db.rows as Row[]).push(row)
  return row
}

/** 가짜 encode-vibe — 요청마다 문을 열어 줘야 끝난다. 본문 이미지(vibe-N)로 어느 바이브인지 구분 */
function fakeFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const image = Buffer.from(JSON.parse(init.body).image, 'base64').toString()
      calls.push(image)
      const { ok } = await new Promise<{ ok: boolean }>((resolve) => gates.set(image, resolve))
      return ok
        ? new Response(Buffer.from(`encoded-${image}`), { status: 200 })
        : new Response('boom', { status: 500 })
    })
  )
}
const open = (image: string, ok = true): void => {
  gates.get(image)?.({ ok })
  gates.delete(image)
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  db.rows = []
  gates.clear()
  calls.length = 0
  fakeFetch()
})

describe('바이브 인코딩 한 번만', () => {
  it('두 작업자가 같은 미인코딩 바이브를 동시에 만나도 인코딩은 한 번 — 둘 다 같은 결과를 받는다', async () => {
    addRow(1)
    const a = prepareVibes('token-a')
    const b = prepareVibes('token-b')
    await flush()
    expect(calls).toEqual(['vibe-1'])
    open('vibe-1')
    const [ra, rb] = await Promise.all([a, b])
    expect(calls).toEqual(['vibe-1'])
    expect(ra.vibes[0].encodedVibeBase64).toBe(rb.vibes[0].encodedVibeBase64)
    // 새로 인코딩했다는 알림은 시작한 쪽에만
    expect([...ra.newlyEncoded, ...rb.newlyEncoded]).toEqual([1])
    expect(ra.vibes[0].encodedVibeBase64).toBe(Buffer.from('encoded-vibe-1').toString('base64'))
  })

  it('이미 인코딩된 바이브는 요청을 보내지 않는다', async () => {
    addRow(1, 'cached')
    const r = await prepareVibes('token-a')
    expect(calls).toEqual([])
    expect(r.vibes[0].encodedVibeBase64).toBe('cached')
    expect(r.newlyEncoded).toEqual([])
  })

  it('처음 읽은 목록 뒤에 다른 작업자가 이미 끝낸 바이브는 다시 인코딩하지 않는다', async () => {
    addRow(0)
    addRow(2)
    // 작업자 A: 0번을 먼저 인코딩하는 사이(오래 걸림) 2번은 낡은 목록으로 들고 있다
    const a = prepareVibes('token-a', [0, 2])
    await flush()
    expect(calls).toEqual(['vibe-0'])
    // 작업자 B: 2번을 끝까지 인코딩해 저장한다
    const b = prepareVibes('token-b', [2])
    await flush()
    expect(calls).toEqual(['vibe-0', 'vibe-2'])
    open('vibe-2')
    await b
    // A 가 0번을 마치고 2번으로 넘어와도, 이미 저장된 값을 쓴다 (인코딩 요청 없음)
    open('vibe-0')
    const ra = await a
    expect(calls).toEqual(['vibe-0', 'vibe-2'])
    expect(ra.vibes).toHaveLength(2)
    expect(ra.newlyEncoded).toEqual([0])
  })

  it('인코딩이 실패하면 기다리던 쪽에도 오류가 가고, 다음 시도에서 다시 인코딩한다', async () => {
    addRow(1)
    const a = prepareVibes('token-a')
    const b = prepareVibes('token-b')
    const settled = Promise.allSettled([a, b])
    await flush()
    open('vibe-1', false)
    const results = await settled
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(calls).toEqual(['vibe-1'])
    // 실패는 기억하지 않는다
    const again = prepareVibes('token-a')
    await flush()
    expect(calls).toEqual(['vibe-1', 'vibe-1'])
    open('vibe-1')
    await again
  })
})
