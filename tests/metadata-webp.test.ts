import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { metadataFromWebp } from '../src/main/images/metadata'

/**
 * NAI webp는 EXIF UserComment에 파라미터 JSON을 넣는다 (PNG의 tEXt Comment 대응).
 * 사용자 이미지가 대부분 webp라 이 경로가 실사용 진입점이다.
 * 고정 자료: tests/fixtures/v5/ 아래 V5 생성물 (2026-08-21 사용자 제공).
 */

const V5_DIR = join(__dirname, 'fixtures', 'v5')

function findWebps(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...findWebps(p))
    else if (name.toLowerCase().endsWith('.webp')) out.push(p)
  }
  return out
}

describe('webp EXIF 메타데이터', () => {
  const files = findWebps(V5_DIR)

  it('V5 생성물 fixture가 있다', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('모든 V5 fixture에서 파라미터를 읽어낸다', () => {
    for (const f of files) {
      const meta = metadataFromWebp(readFileSync(f))
      expect(meta, f).not.toBeNull()
      expect(meta!.software).toContain('NovelAI Diffusion V5')
      expect(meta!.prompt.length).toBeGreaterThan(0)
      expect(meta!.seed).toBeGreaterThan(0)
      expect(meta!.width).toBeGreaterThan(0)
      expect(meta!.sampler).toBe('k_euler_ancestral')
    }
  })

  it('좌표를 커스텀한 fixture는 연속 좌표와 use_coords를 그대로 돌려준다', () => {
    const f = files.find((p) => p.includes('포지션'))
    expect(f, '포지션 커스텀 fixture').toBeDefined()
    const meta = metadataFromWebp(readFileSync(f!))!
    expect(meta.useCoords).toBe(true)
    const centers = meta.characterPrompts!.map((c) => c.center)
    // 5×5 격자(0.1~0.9)에 없는 값 = 자유 배치
    expect(centers[0]).toEqual({ x: 0.776, y: 0.141 })
    expect(meta.characterPrompts!.length).toBe(3)
  })

  it('V5에는 Variety+가 없으므로 variety=false로 읽힌다', () => {
    for (const f of files) {
      expect(metadataFromWebp(readFileSync(f))!.variety, f).toBe(false)
    }
  })

  it('webp가 아닌 버퍼는 null', () => {
    expect(metadataFromWebp(Buffer.from('not an image'))).toBeNull()
    expect(metadataFromWebp(Buffer.alloc(0))).toBeNull()
  })
})
