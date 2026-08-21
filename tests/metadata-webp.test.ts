import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { metadataFromWebp } from '../src/main/images/metadata'

/**
 * NAI webp는 EXIF UserComment에 파라미터 JSON을 넣는다 (PNG의 tEXt Comment 대응).
 * 사용자 이미지가 대부분 webp라 이 경로가 실사용 진입점이다.
 *
 * fixture는 실제 V5 생성물의 EXIF를 그대로 옮기되 그림은 1×1 픽셀로 갈고
 * 프롬프트는 중립 문구로 바꾼 것이다 (2026-08-21). 파서가 보는 건 EXIF뿐이라
 * 검증력은 같다.
 */

const V5_DIR = join(__dirname, 'fixtures', 'v5')
const load = (name: string) => metadataFromWebp(readFileSync(join(V5_DIR, name)))
const FILES = ['v5-qt-standard.webp', 'v5-qt-light.webp', 'v5-qt-none.webp', 'v5-coords-custom.webp']

describe('webp EXIF 메타데이터', () => {
  it('모든 V5 fixture에서 파라미터를 읽어낸다', () => {
    for (const f of FILES) {
      const meta = load(f)
      expect(meta, f).not.toBeNull()
      expect(meta!.software).toContain('NovelAI Diffusion V5')
      expect(meta!.prompt.length).toBeGreaterThan(0)
      expect(meta!.seed).toBeGreaterThan(0)
      expect(meta!.width).toBeGreaterThan(0)
      expect(meta!.sampler).toBe('k_euler_ancestral')
    }
  })

  it('좌표를 커스텀한 fixture는 연속 좌표와 use_coords를 그대로 돌려준다', () => {
    const meta = load('v5-coords-custom.webp')!
    expect(meta.useCoords).toBe(true)
    const centers = meta.characterPrompts!.map((c) => c.center)
    // 5×5 격자(0.1~0.9)에 없는 값 = 자유 배치
    expect(centers[0]).toEqual({ x: 0.776, y: 0.141 })
    expect(meta.characterPrompts!.length).toBe(3)
  })

  it('V5에는 Variety+가 없으므로 variety=false로 읽힌다', () => {
    for (const f of FILES) {
      expect(load(f)!.variety, f).toBe(false)
    }
  })

  it('webp가 아닌 버퍼는 null', () => {
    expect(metadataFromWebp(Buffer.from('not an image'))).toBeNull()
    expect(metadataFromWebp(Buffer.alloc(0))).toBeNull()
  })
})
