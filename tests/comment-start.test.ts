import { describe, expect, it } from 'vitest'
import { commentStart, removeComments } from '../src/shared/nai-presets'

describe('commentStart — NAI 액션 태그(target#..) 보존', () => {
  it('줄 맨 앞 #은 주석', () => {
    expect(commentStart('# 메모')).toBe(0)
  })
  it('공백 뒤 #은 주석', () => {
    expect(commentStart('1girl, # 여기부터 주석')).toBe(7)
  })
  it('토큰 중간 #은 주석 아님 (target#mating press)', () => {
    expect(commentStart('target#mating press')).toBe(-1)
    expect(commentStart('source#kissing')).toBe(-1)
  })
  it('# 없으면 -1', () => {
    expect(commentStart('1girl, solo')).toBe(-1)
  })
})

describe('removeComments — 액션 태그는 살리고 주석만 제거', () => {
  it('target#mating press 보존', () => {
    expect(removeComments('2girls, target#mating press, source#kissing')).toBe(
      '2girls, target#mating press, source#kissing'
    )
  })
  it('줄 맨 앞 주석 줄 삭제', () => {
    expect(removeComments('1girl\n# 이 줄은 주석\nsolo')).toBe('1girl\nsolo')
  })
  it('인라인 주석 (공백 뒤 #) 제거하되 앞부분 유지', () => {
    expect(removeComments('1girl, solo # 주석')).toBe('1girl, solo ')
  })
  it('액션 태그 + 인라인 주석 혼합', () => {
    expect(removeComments('target#mating press # 실제 주석')).toBe('target#mating press ')
  })
})
