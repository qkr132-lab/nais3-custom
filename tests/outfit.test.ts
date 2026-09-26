import { describe, expect, it } from 'vitest'
import {
  activePieces,
  outfitTags,
  resolveOutfitTags,
  splitClothing,
  splitPromptTokens,
  togglePiece,
  type Outfit,
  type TagKind
} from '../src/shared/outfit'

const uniform: Outfit = {
  id: 1,
  name: '치마 교복',
  pieces: [
    { id: 'jacket', name: '재킷', tags: 'blazer', on: true },
    { id: 'shirt', name: '셔츠', tags: 'white shirt', on: true },
    { id: 'skirt', name: '치마', tags: 'pleated skirt', on: true },
    { id: 'zip', name: '지퍼 오픈', tags: 'unzipped, open jacket', on: false },
    { id: 'lift', name: '치마 들춤', tags: 'skirt lift', on: false }
  ]
}
const nude: Outfit = {
  id: 2,
  name: '알몸',
  pieces: [{ id: 'nude', name: '알몸', tags: 'nude, completely nude', on: true }]
}
const lib = new Map([
  [1, uniform],
  [2, nude]
])

describe('조각 켜고 끄기', () => {
  it('아무것도 안 바꾸면 기본 켜진 조각만', () => {
    expect(outfitTags(uniform)).toBe('blazer, white shirt, pleated skirt')
  })

  it('상태 조각을 켜면 더해진다 — 여러 개 동시에', () => {
    expect(outfitTags(uniform, { on: ['zip', 'lift'] })).toBe(
      'blazer, white shirt, pleated skirt, unzipped, open jacket, skirt lift'
    )
  })

  it('기본 조각을 끄면 벗는다', () => {
    expect(outfitTags(uniform, { off: ['jacket'] })).toBe('white shirt, pleated skirt')
  })

  it('복장에 적힌 순서를 지킨다', () => {
    expect(activePieces(uniform, { on: ['lift'], off: ['shirt'] }).map((p) => p.id)).toEqual([
      'jacket',
      'skirt',
      'lift'
    ])
  })

  it('켜고 끈 기록은 기본값과 다른 것만 남는다', () => {
    let c = togglePiece(uniform, { outfitId: 1 }, 'lift')
    expect(c).toEqual({ outfitId: 1, on: ['lift'] })
    c = togglePiece(uniform, c, 'lift')
    expect(c).toEqual({ outfitId: 1 })
    c = togglePiece(uniform, c, 'jacket')
    expect(c).toEqual({ outfitId: 1, off: ['jacket'] })
  })
})

describe('누가 무엇을 입나', () => {
  it('씬에서 고른 옷이 먼저', () => {
    expect(resolveOutfitTags(1, { outfitId: 2 }, lib)).toBe('nude, completely nude')
  })

  it('씬에서 안 고르면 카드 기본 복장', () => {
    expect(resolveOutfitTags(1, undefined, lib)).toBe('blazer, white shirt, pleated skirt')
  })

  it('둘 다 없으면 아무것도 안 붙는다 (카드 태그 그대로 나감)', () => {
    expect(resolveOutfitTags(null, undefined, lib)).toBe('')
  })

  it('지워진 복장을 가리키면 카드 기본으로 물러난다', () => {
    expect(resolveOutfitTags(1, { outfitId: 99 }, lib)).toBe('blazer, white shirt, pleated skirt')
    expect(resolveOutfitTags(99, undefined, lib)).toBe('')
  })
})

describe('카드 태그 나누기', () => {
  it('가중치 묶음은 한 덩어리로 둔다', () => {
    expect(splitPromptTokens('1girl, 1.2::red eyes, long hair::, smile')).toEqual([
      '1girl',
      '1.2::red eyes, long hair::',
      'smile'
    ])
  })

  it('쉼표 없이 붙은 가중치 묶음은 앞 단어와 뗀다', () => {
    expect(splitPromptTokens('navel, abs -1.5::ponytail, gloves::')).toEqual([
      'navel',
      'abs',
      '-1.5::ponytail, gloves::'
    ])
  })

  it('묶음 둘이 바로 붙어 있어도 나눈다', () => {
    expect(splitPromptTokens('-2::braid::1.3::smile::')).toEqual(['-2::braid::', '1.3::smile::'])
  })

  const kinds: Record<string, TagKind> = {
    '1girl': 'body',
    furry: 'body',
    'string bikini': 'cloth',
    'bikini armor': 'cloth',
    'black bikini armor': 'cloth',
    gloves: 'cloth',
    nude: 'bare',
    'completely nude': 'bare',
    smile: 'body',
    navel: 'body'
  }
  const classify = (t: string): TagKind => kinds[t] ?? 'unknown'

  it('몸 / 옷 / 알몸으로 나눈다', () => {
    const r = splitClothing('1girl, furry, 1.1::black bikini armor::, string bikini, nude, navel', classify)
    expect(r.body).toEqual(['1girl', 'furry', 'navel'])
    expect(r.cloth).toEqual(['1.1::black bikini armor::', 'string bikini'])
    expect(r.bare).toEqual(['nude'])
  })

  it('빼달라는 음수 가중치는 옷 이름이 들어 있어도 카드에 남긴다', () => {
    const r = splitClothing('1girl, -1.5::gloves::', classify)
    expect(r.body).toEqual(['1girl', '-1.5::gloves::'])
    expect(r.cloth).toEqual([])
  })

  it('몸과 옷이 섞인 가중치 묶음은 쪼개지 않고 카드에 남긴다', () => {
    const r = splitClothing('1.2::smile, gloves::', classify)
    expect(r.body).toEqual(['1.2::smile, gloves::'])
    expect(r.cloth).toEqual([])
  })

  it('모르는 태그는 몸 쪽(카드)에 남긴다 — 옷인지 확신할 때만 옮긴다', () => {
    const r = splitClothing('3 fingers, gloves', classify)
    expect(r.body).toEqual(['3 fingers'])
    expect(r.cloth).toEqual(['gloves'])
  })
})

describe('복장이 파일로 갔다 돌아온다', () => {
  it('씬에서 고른 옷과 켜고 끈 조각이 새 id로 돌아온다', async () => {
    const { decodeSetup, encodeSetup } = await import('../src/shared/scene-bundle')
    const file = JSON.parse(
      JSON.stringify(
        encodeSetup(
          { characterIds: [5], outfits: { 5: { outfitId: 1, on: ['lift'], off: ['jacket'] } } },
          (id) => `c${id}`,
          (id) => `o${id}`
        )
      )
    )
    expect(file.outfits).toEqual({ c5: { outfit: 'o1', on: ['lift'], off: ['jacket'] } })
    const { setup } = decodeSetup(
      file,
      (u) => (u === 'c5' ? 50 : undefined),
      (u) => (u === 'o1' ? 10 : undefined)
    )
    expect(setup.outfits).toEqual({ 50: { outfitId: 10, on: ['lift'], off: ['jacket'] } })
  })

  it('파일에 없는 복장을 가리키면 그 선택만 빠지고 센다', async () => {
    const { decodeSetup } = await import('../src/shared/scene-bundle')
    const { setup, dropped } = decodeSetup(
      { characters: ['c5'], outfits: { c5: { outfit: 'o9' } } },
      () => 50,
      () => undefined
    )
    expect(setup.outfits).toBeUndefined()
    expect(dropped).toBe(1)
  })

  it('지운 캐릭터의 옷 선택은 휴지통 정리 때 걷힌다', async () => {
    const { stripDeadCharacters } = await import('../src/shared/scene-bundle')
    const s = stripDeadCharacters(
      { characterIds: [1, 2], outfits: { 1: { outfitId: 1 }, 2: { outfitId: 2 } } },
      (id) => id === 1
    )
    expect(s.outfits).toEqual({ 1: { outfitId: 1 } })
  })
})
