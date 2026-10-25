import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

/**
 * 백업 불러오기 — 설정 창의 불러오기 뒤처리가 복장 스토어를 다시 읽는지, 백업 설정 목록에 복장 설정 키가 들어 있는지.
 * 복장 스토어(입은 옷 자동 젖힘·눈 감음·pink nipples·후타 재조립 …)를 안 다시 읽으면 복원한 설정이 앱을 다시 켜기 전까지 적용되지 않는다.
 * 화면 컴포넌트를 띄우지 않고 소스 글자만 본다.
 */

const read = (path: string): string => readFileSync(path, 'utf-8').replace(/\r\n/g, '\n')

describe('백업 불러오기 뒤처리', () => {
  it('불러오기 성공 뒤 복장 스토어를 다시 읽는다', () => {
    const src = read('src/renderer/src/components/token-dialog.tsx')
    const at = src.indexOf("window.nais.invoke('backup:import'")
    expect(at).toBeGreaterThan(0)
    // 불러오기 핸들러 안(다음 버튼 전까지)에서 찾는다
    const end = src.indexOf('불러오기\n', at)
    expect(end).toBeGreaterThan(at)
    const handler = src.slice(at, end)
    expect(handler).toContain('useOutfitsStore.getState().load()')
  })

  it('백업 설정 목록에 복장 설정 키가 모두 들어 있다', () => {
    const src = read('src/main/backup/repo.ts')
    const from = src.indexOf('const SETTINGS_KEYS = [')
    expect(from).toBeGreaterThan(0)
    const list = src.slice(from, src.indexOf('] as const', from))
    for (const key of [
      'expose_worn_clothes',
      'eyes_closed_strip',
      'nude_pink_nipples',
      'futa_reassembly',
      'futa_view_fix',
      'nude_strip_clothes',
      'outfit_expose_acts'
    ])
      expect(list, key).toContain(`'${key}'`)
  })
})
