import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPOSE_ACTS as acts,
  autoExposeTags,
  detectGarments,
  exposePreview
} from '../src/shared/auto-expose'

const tags = (outfit: string, ...ctx: string[]): string[] =>
  autoExposeTags(outfit, ctx, acts).map((t) => t.tag)

describe('옷 입은 채 자동으로 젖히기', () => {
  it('비키니 + 삽입 → 하의 옆으로 밀기', () => {
    expect(tags('1.2::bikini armor::, black armor', 'target#vaginal, sex from behind')).toEqual([
      'bikini bottom aside'
    ])
  })

  it('비키니 + 파이즈리 → 상의 들어올리기', () => {
    expect(tags('string bikini', 'paizuri')).toEqual(['bikini top lift'])
  })

  it('둘 다 필요하면 둘 다', () => {
    expect(tags('black bikini', 'vaginal, breast grab')).toEqual(['bikini bottom aside', 'bikini top lift'])
  })

  it('겹쳐 입은 옷은 겉옷·속옷 둘 다 젖힌다', () => {
    expect(tags('pleated skirt, white panties, white shirt', 'missionary')).toEqual([
      'skirt lift',
      'panties aside'
    ])
  })

  it('바지 입은 캐릭터에 skirt lift가 붙지 않는다', () => {
    expect(tags('black pants, white shirt', 'vaginal')).toEqual(['pants pull'])
  })

  it('드러낼 필요 없는 행위면 옷 그대로', () => {
    expect(tags('black bikini', 'fellatio, kiss')).toEqual([])
  })

  it('셔츠만 알면 아래는 건드리지 않는다 (모르는 걸 추측하지 않음)', () => {
    expect(tags('white shirt', 'vaginal')).toEqual([])
  })

  it('이미 드러나 있으면 더 젖히지 않는다', () => {
    expect(tags('black bikini', 'vaginal, bottomless')).toEqual([])
    expect(tags('black bikini', 'paizuri, topless')).toEqual([])
  })

  it('이미 켜둔 태그는 두 번 붙이지 않는다', () => {
    expect(tags('black bikini, bikini bottom aside', 'vaginal')).toEqual([])
  })

  it('빼달라는 음수 가중치의 옷은 입은 게 아니다', () => {
    expect(tags('white shirt, -2::skirt::', 'vaginal')).toEqual([])
  })

  it('문장에 옷 이름이 나와도 문장만으로는 옷을 입었다고 보지 않는다', () => {
    expect(detectGarments('The two cups of the black bikini top are joined in the middle.')).toEqual([])
  })

  it('이유(행위 태그)를 같이 알려준다', () => {
    expect(autoExposeTags('black bikini', ['target#vaginal'], acts)[0].because).toBe('vaginal')
  })

  it('복장 탭 안내 — 이 옷이면 무엇이 붙는지', () => {
    expect(exposePreview('pleated skirt, white panties, white shirt')).toEqual({
      lower: ['skirt lift', 'panties aside'],
      chest: ['shirt lift']
    })
  })
})
