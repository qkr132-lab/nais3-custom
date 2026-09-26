import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { TagSearchEngine as Engine } from '../src/main/tag-search-engine'

vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/sqlite-for-node')).TestDatabase
}))

/**
 * 사용자 PC에만 있는 한글 태그 자료 (커스텀) — tag-ko-extra.json.
 * 한글이 없던 태그만 채우고, 직접 지정한 한글과 기존 사전은 건드리지 않는다.
 */
const dir = mkdtempSync(join(tmpdir(), 'tag-extra-'))
const extraPath = join(dir, 'tag-ko-extra.json')
writeFileSync(
  extraPath,
  JSON.stringify({
    tags: {
      // 기존 사전에 한글이 없는 태그 → 채워져야 한다
      'smear frame': ['스미어 프레임', ['잔상 프레임'], '빠른 움직임을 번지게 그리는 기법'],
      // 기존 사전에 한글이 있는 태그 → 이름은 그대로, 별칭·설명만 보탠다
      'full body': ['몸 전체', ['풀샷테스트별칭'], '캐릭터의 몸 전체가 보이는 구도'],
      long_sleeves: ['긴 소매', ['롱슬리브테스트'], '손목까지 덮는 소매']
    }
  })
)

let TagSearchEngine: typeof Engine
let engine: Engine
let plain: Engine
beforeAll(async () => {
  ;({ TagSearchEngine } = await import('../src/main/tag-search-engine'))
  const db = resolve('resources/tag-search.sqlite')
  engine = new TagSearchEngine(db, extraPath)
  plain = new TagSearchEngine(db)
})
afterAll(() => {
  engine?.close()
  plain?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('받아온 한글 태그 자료', () => {
  it('한글이 없던 태그에 한글 이름이 붙는다', () => {
    expect(plain.lookup(['smear frame'])[0].ko).toBeUndefined()
    expect(engine.lookup(['smear frame'])[0].ko).toBe('스미어 프레임')
  })

  it('기존 사전에 있던 한글 이름은 바꾸지 않는다', () => {
    expect(engine.lookup(['full body'])[0].ko).toBe('전신')
  })

  it('직접 지정한 한글이 무엇보다 먼저다', () => {
    engine.setPersonal({ ko: { 'smear frame': '내가 정한 이름' }, usage: {} })
    expect(engine.lookup(['smear frame'])[0].ko).toBe('내가 정한 이름')
    engine.setPersonal({ ko: {}, usage: {} })
  })

  it('설명은 한글 설명이 있으면 한글로 보여준다', () => {
    expect(engine.lookup(['smear frame'])[0].desc).toBe('빠른 움직임을 번지게 그리는 기법')
    expect(plain.lookup(['smear frame'])[0].desc).toMatch(/animation/i)
  })

  it('받아온 한글 이름·별칭으로 검색된다', () => {
    expect(engine.search('스미어').map((t) => t.tag)).toContain('smear frame')
    expect(engine.search('잔상 프레임').map((t) => t.tag)).toContain('smear frame')
    expect(plain.search('잔상 프레임').map((t) => t.tag)).not.toContain('smear frame')
  })

  it('이름을 안 바꾼 태그도 받아온 별칭으로는 찾힌다', () => {
    expect(engine.search('풀샷테스트별칭')[0].tag).toBe('full body')
  })

  it('파일 속 태그 이름의 밑줄·대소문자는 사전 표기로 맞춘다', () => {
    expect(engine.search('롱슬리브테스트')[0].tag).toBe('long sleeves')
  })

  it('파일이 없거나 깨져도 기본 사전으로 돈다', () => {
    const broken = join(dir, 'broken.json')
    writeFileSync(broken, '{ not json')
    const e1 = new TagSearchEngine(resolve('resources/tag-search.sqlite'), join(dir, 'none.json'))
    const e2 = new TagSearchEngine(resolve('resources/tag-search.sqlite'), broken)
    expect(e1.search('전신')[0].tag).toBe('full body')
    expect(e2.search('전신')[0].tag).toBe('full body')
    e1.close()
    e2.close()
  })
})
