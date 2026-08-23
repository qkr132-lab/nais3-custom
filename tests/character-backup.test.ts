import { describe, expect, it } from 'vitest'
import {
  fingerprint,
  isFullBackup,
  planImport,
  remapUidMap,
  remapUids
} from '../src/shared/character-backup'

/**
 * 캐릭터 완전 백업의 판정·매핑 로직.
 * 되돌릴 수 없는 작업(전체 교체)과 연결 복원이 걸려 있어, DB 없이 검증 가능한
 * 순수 로직으로 떼어내 여기서 못 박는다.
 */

const card = (over: Partial<Parameters<typeof fingerprint>[0]> = {}): {
  name: string
  prompt: string
  negativePrompt: string
  center: { x: number; y: number }
  role: 'source' | 'target' | null
} => ({
  name: '피카츄',
  prompt: 'pikachu, yellow',
  negativePrompt: 'lowres',
  center: { x: 0.5, y: 0.5 },
  role: null,
  ...over
})

describe('중복 판정 (지문)', () => {
  it('앞뒤 공백·줄바꿈 차이는 같은 카드로 본다', () => {
    expect(fingerprint(card())).toBe(fingerprint(card({ prompt: '  pikachu, yellow\n' })))
  })

  it('태그가 조금이라도 다르면 다른 카드', () => {
    expect(fingerprint(card())).not.toBe(fingerprint(card({ prompt: 'pikachu, yellow, cute' })))
  })

  it('이름·역할·위치가 다르면 다른 카드', () => {
    expect(fingerprint(card())).not.toBe(fingerprint(card({ name: '라이츄' })))
    expect(fingerprint(card())).not.toBe(fingerprint(card({ role: 'source' })))
    expect(fingerprint(card())).not.toBe(fingerprint(card({ center: { x: 0.3, y: 0.5 } })))
  })
})

describe('가져오기 계획', () => {
  const existing = [{ id: 1, ...card() }]

  it('skip-identical: 완전히 같으면 건너뛰고 다르면 만든다', () => {
    const plan = planImport(existing, [card(), card({ prompt: 'pikachu, red' })], 'skip-identical')
    expect(plan.create).toHaveLength(1)
    expect(plan.create[0].prompt).toBe('pikachu, red')
    expect(plan.skipped).toHaveLength(1)
    expect(plan.removeIds).toEqual([])
  })

  it('skip-identical: 파일 안의 중복도 한 번만 만든다', () => {
    const dup = card({ prompt: 'new one' })
    const plan = planImport(existing, [dup, { ...dup }], 'skip-identical')
    expect(plan.create).toHaveLength(1)
    expect(plan.skipped).toHaveLength(1)
  })

  it('always-copy: 판정 없이 전부 만든다', () => {
    const plan = planImport(existing, [card(), card()], 'always-copy')
    expect(plan.create).toHaveLength(2)
    expect(plan.removeIds).toEqual([])
  })

  it('replace-all: 기존 전부를 지울 대상으로 내놓는다', () => {
    const plan = planImport(existing, [card()], 'replace-all')
    expect(plan.removeIds).toEqual([1])
    expect(plan.create).toHaveLength(1)
    expect(plan.skipped).toEqual([])
  })
})

describe('연결 복원 (uid → 새 id)', () => {
  const map = new Map([
    ['u1', 10],
    ['u2', 11]
  ])

  it('매칭되는 uid만 새 id로 바뀐다', () => {
    expect(remapUids(['u1', 'u2'], map)).toEqual([10, 11])
  })

  it('건너뛴 카드(매칭 실패)는 조용히 빠진다 — 끊어진 참조를 남기지 않는다', () => {
    expect(remapUids(['u1', 'u-없음', 'u2'], map)).toEqual([10, 11])
    expect(remapUids(undefined, map)).toEqual([])
  })

  it('위치·역할 맵도 id 키로 옮긴다', () => {
    expect(remapUidMap({ u1: { x: 0.776, y: 0.141 }, uX: { x: 0, y: 0 } }, map)).toEqual({
      10: { x: 0.776, y: 0.141 }
    })
    expect(remapUidMap({ u2: 'source' as const }, map)).toEqual({ 11: 'source' })
  })
})

describe('포맷 판별', () => {
  it('v3만 완전 백업으로 인정한다', () => {
    expect(isFullBackup({ version: 3, characters: [] })).toBe(true)
    expect(isFullBackup({ version: 2, characters: [] })).toBe(false)
    expect(isFullBackup([{ name: 'a' }])).toBe(false)
    expect(isFullBackup(null)).toBe(false)
  })
})
