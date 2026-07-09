import { describe, it, expect } from 'vitest'
import { assignExportName, safeName } from '../src/main/scenes/export-name'

describe('assignExportName — 씬 이름 그대로, _번호 제거', () => {
  it('디스크명의 _번호를 버리고 씬 이름을 쓴다', () => {
    const used = new Set<string>()
    expect(assignExportName('감동', 'C:/x/감동_4.png', used)).toBe('감동.png')
  })

  it('한 장이면 번호가 안 붙는다', () => {
    const used = new Set<string>()
    expect(assignExportName('풍경', '/a/풍경_12.webp', used)).toBe('풍경.webp')
  })

  it('같은 씬 여러 장이면 " (2)" 부터 붙어 유니크해진다', () => {
    const used = new Set<string>()
    expect(assignExportName('감동', '/a/감동_1.png', used)).toBe('감동.png')
    expect(assignExportName('감동', '/a/감동_2.png', used)).toBe('감동 (2).png')
    expect(assignExportName('감동', '/a/감동_3.png', used)).toBe('감동 (3).png')
  })

  it('확장자는 원본을 따른다', () => {
    const used = new Set<string>()
    expect(assignExportName('a', '/x/a_1.jpg', used)).toBe('a.jpg')
    // 대소문자 무시로 중복 판정 → 두 번째는 (2)
    expect(assignExportName('A', '/x/A_2.JPG', used)).toBe('A (2).JPG')
  })

  it('씬별 폴더로 나누면 폴더마다 번호가 독립적으로 시작한다', () => {
    const used = new Set<string>()
    expect(assignExportName('감동', '/a/감동_1.png', used, '감동')).toBe('감동.png')
    // 다른 폴더(다른 씬)에서는 다시 번호 없이 시작
    expect(assignExportName('슬픔', '/a/슬픔_9.png', used, '슬픔')).toBe('슬픔.png')
    // 같은 폴더 두 번째 장만 (2)
    expect(assignExportName('감동', '/a/감동_2.png', used, '감동')).toBe('감동 (2).png')
  })

  it('씬 이름이 없으면(고아 이미지) 디스크명에서 _번호만 떼어 쓴다', () => {
    const used = new Set<string>()
    expect(assignExportName(null, '/a/무제_7.png', used)).toBe('무제.png')
    expect(assignExportName('', '/a/무제_8.png', used)).toBe('무제 (2).png')
  })

  it('파일명 금지문자는 _로 치환된다', () => {
    const used = new Set<string>()
    expect(assignExportName('a/b:c', '/x/y_1.png', used)).toBe('a_b_c.png')
  })

  it('safeName은 경로 구분자를 없앤다 (구분자 안전성)', () => {
    expect(safeName('a/b\\c')).toBe('a_b_c')
    expect(safeName('normal name')).toBe('normal name')
  })
})
