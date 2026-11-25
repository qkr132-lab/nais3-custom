/**
 * 폰 화면 이벤트 속성 점검 — Preact 가 모르는 Camel 이벤트 이름 금지
 *
 * Preact 는 속성 이름을 소문자로 바꾼 것이 요소에 있을 때만(`'onclick' in el`) 소문자 이벤트로 붙이고,
 * 없으면 이름을 대소문자 그대로 등록한다. 브라우저 요소에는 oncompositionstart 같은 속성이 없어서
 * `onCompositionStart` 는 실제 compositionstart 에 붙지 않고 'CompositionStart' 라는 존재하지 않는 이벤트를 기다린다.
 * (한글 자판 조합 중 값을 덮어쓰는 문제가 이 때문에 생겼다) → ref + addEventListener 로 직접 붙인다.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const webDir = path.resolve(__dirname, '..', '..', 'cloud', 'web')

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

describe('폰 화면 이벤트 속성', () => {
  it('요소에 소문자 속성이 없는 Camel 이벤트(조합·터치)를 쓰지 않는다', () => {
    // 브라우저 요소에 on* 속성이 없거나(composition*) 기기에 따라 없는(touch*) 이벤트
    const banned = /\bon(Composition(Start|Update|End)|Touch(Start|Move|End|Cancel))\s*=/
    const found: string[] = []
    for (const file of sourceFiles(webDir)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (banned.test(line)) found.push(`${path.relative(webDir, file)}:${i + 1}  ${line.trim()}`)
      })
    }
    expect(found).toEqual([])
  })

  it('연결 화면은 조합 이벤트를 addEventListener 로 붙인다', () => {
    const src = readFileSync(path.join(webDir, 'screens', 'connect.tsx'), 'utf8')
    expect(src).toContain("addEventListener('compositionstart'")
    expect(src).toContain("addEventListener('compositionend'")
    expect(src).toContain("removeEventListener('compositionstart'")
    expect(src).toContain("removeEventListener('compositionend'")
  })
})
