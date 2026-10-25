import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { isInsideDir, localRelative } from '../src/main/r2/local-path'

/**
 * R2 내려받기 경로 (커스텀) — 키가 무엇이든 사용자가 고른 폴더 밖에는 쓰지 않는다.
 * 합성 키로만 확인한다.
 */

describe('localRelative', () => {
  it('보고 있는 폴더(base)를 떼고 하위 구조를 그대로 둔다', () => {
    expect(localRelative('sample/a/01.webp', 'sample/')).toBe('a/01.webp')
    expect(localRelative('sample/a/01.webp', '')).toBe('sample/a/01.webp')
    expect(localRelative('other/01.webp', 'sample/')).toBe('other/01.webp')
  })

  it('빈 조각과 윈도우 금지 문자를 거른다', () => {
    expect(localRelative('a//b/c:d*e?.webp', '')).toBe('a/b/c_d_e_.webp')
    expect(localRelative('a\\b/c|d.webp', '')).toBe('a_b/c_d.webp')
  })

  it('점·공백만 있는 조각(. .. ...)은 버린다', () => {
    expect(localRelative('a/../../x.webp', '')).toBe('a/x.webp')
    expect(localRelative('../x.webp', '')).toBe('x.webp')
    expect(localRelative('a/./b/.../c.webp', '')).toBe('a/b/c.webp')
    expect(localRelative('a/. ./b.webp', '')).toBe('a/b.webp')
  })

  it('점으로 시작하는 보통 이름은 그대로 둔다', () => {
    expect(localRelative('a/..hidden/.x.webp', '')).toBe('a/..hidden/.x.webp')
  })

  it('남는 조각이 없으면 _', () => {
    expect(localRelative('../..', '')).toBe('_')
    expect(localRelative('', '')).toBe('_')
  })
})

describe('isInsideDir', () => {
  const dir = resolve('synthetic-download-dir')

  it('폴더 안쪽 경로는 통과', () => {
    expect(isInsideDir(dir, join(dir, 'a', 'b.webp'))).toBe(true)
    expect(isInsideDir(dir, join(dir, '..hidden', 'b.webp'))).toBe(true)
  })

  it('폴더 자신, 바깥, 형제 폴더는 막는다', () => {
    expect(isInsideDir(dir, dir)).toBe(false)
    expect(isInsideDir(dir, join(dir, '..', 'x.webp'))).toBe(false)
    expect(isInsideDir(dir, `${dir}-sibling/x.webp`)).toBe(false)
  })

  it('localRelative 를 거친 어떤 키도 폴더 밖으로 나가지 않는다', () => {
    for (const key of ['a/../../x', '../../x', '/../x', 'a/..\\..\\x', '..', 'a/b/../../..']) {
      expect(isInsideDir(dir, join(dir, localRelative(key, '')))).toBe(true)
    }
  })
})
