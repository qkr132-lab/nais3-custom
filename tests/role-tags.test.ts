import { describe, expect, it } from 'vitest'
import { autoRolePrefix, roleTagsFor } from '../src/shared/scene-request'

describe('autoRolePrefix — bare 상호작용 태그에 역할 접두사', () => {
  it('bare 상호작용 태그에 source#/target#을 붙인다', () => {
    expect(autoRolePrefix('sex, fellatio', 'target')).toBe('target#sex, target#fellatio')
    expect(autoRolePrefix('sex, doggystyle', 'source')).toBe('source#sex, source#doggystyle')
  })

  it('포즈·표정 같은 일반 태그는 건드리지 않는다', () => {
    expect(autoRolePrefix('sex, on top, smirk', 'source')).toBe('source#sex, on top, smirk')
  })

  it('이미 접두사가 있는 태그는 그대로 둔다', () => {
    expect(autoRolePrefix('source#sex, target#fellatio', 'source')).toBe(
      'source#sex, target#fellatio'
    )
  })

  it('가중치 블록은 내부 콤마 포함 통째로 보존한다', () => {
    expect(autoRolePrefix('-3::intersex penetrated::, sex', 'source')).toBe(
      '-3::intersex penetrated::, source#sex'
    )
    expect(autoRolePrefix('3::nude, completely nude::, fellatio', 'target')).toBe(
      '3::nude, completely nude::, target#fellatio'
    )
  })

  it('두 단어 상호작용 태그(mating press 등)도 변환한다', () => {
    expect(autoRolePrefix('mating press, legs up', 'target')).toBe(
      'target#mating press, legs up'
    )
    expect(autoRolePrefix('nursing handjob, breast sucking', 'source')).toBe(
      'source#nursing handjob, source#breast sucking'
    )
  })

  it('대소문자를 구분하지 않고, 빈 문자열은 그대로 반환한다', () => {
    expect(autoRolePrefix('Sex', 'target')).toBe('target#Sex')
    expect(autoRolePrefix('', 'target')).toBe('')
    expect(autoRolePrefix('  ', 'source')).toBe('  ')
  })
})

describe('roleTagsFor — 역할별 씬 태그 선택', () => {
  const scene = { sourceTags: 'sex, on top', targetTags: 'sex, fellatio, lying' }

  it('source 역할은 sourceTags를 접두사 적용해 반환', () => {
    expect(roleTagsFor('source', scene)).toBe('source#sex, on top')
  })

  it('target 역할은 targetTags를 접두사 적용해 반환', () => {
    expect(roleTagsFor('target', scene)).toBe('target#sex, target#fellatio, lying')
  })

  it('역할이 없으면 빈 문자열', () => {
    expect(roleTagsFor(undefined, scene)).toBe('')
  })

  it('씬에 태그가 없어도 안전', () => {
    expect(roleTagsFor('source', {})).toBe('')
  })
})
