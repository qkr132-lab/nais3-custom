import { describe, expect, it } from 'vitest'
import * as autoExpose from '../src/shared/auto-expose'
import {
  DEFAULT_EXPOSE_ACTS as acts,
  detectGarments,
  exposeCandidates,
  exposePreview,
  neededAreas,
  triggerAreas
} from '../src/shared/auto-expose'
import type { Outfit, OutfitPiece } from '../src/shared/outfit'

const outfit = (...pieces: Omit<OutfitPiece, 'id'>[]): Outfit => ({
  id: 1,
  name: '복장',
  negative: '',
  pieces: pieces.map((p, i) => ({ ...p, id: `p${i + 1}` }))
})

describe('nsfw 조각이 켜지는 장면', () => {
  it('삽입 같은 행위면 아래, 파이즈리 같은 행위면 가슴', () => {
    expect(triggerAreas(['target#vaginal, sex from behind'], acts)).toEqual({
      lower: true,
      chest: false
    })
    expect(triggerAreas(['paizuri'], acts)).toEqual({ lower: false, chest: true })
    expect(triggerAreas(['vaginal', 'breast grab'], acts)).toEqual({ lower: true, chest: true })
  })

  it('드러낼 필요 없는 행위면 어느 쪽도 아니다', () => {
    expect(triggerAreas(['fellatio, kiss'], acts)).toEqual({ lower: false, chest: false })
  })

  it('씬에서 자동 켜기를 끄면 장면이 맞아도 켜지지 않는다', () => {
    expect(triggerAreas(['vaginal, paizuri'], acts, { auto: false })).toEqual({})
    expect(triggerAreas(['vaginal'], acts, { auto: undefined })).toEqual({
      lower: true,
      chest: false
    })
  })

  it('복장 탭에서 고친 장면 목록을 따른다', () => {
    const mine = { lower: ['spread legs'], chest: [] }
    expect(triggerAreas(['spread legs'], mine)).toEqual({ lower: true, chest: false })
    expect(triggerAreas(['vaginal'], mine)).toEqual({ lower: false, chest: false })
  })

  it('이유(처음 걸린 행위 태그)를 같이 알려준다', () => {
    expect(neededAreas(['target#vaginal', 'paizuri'], acts)).toEqual({
      lower: 'vaginal',
      chest: 'paizuri'
    })
  })

  it('주석·랜덤 선택지·와일드카드 안의 행위 태그는 장면으로 치지 않는다', () => {
    expect(neededAreas(['standing # vaginal'], acts)).toEqual({})
    expect(neededAreas(['standing\n# alt: sex, paizuri'], acts)).toEqual({})
    expect(neededAreas(['(vaginal/standing)'], acts)).toEqual({})
    expect(neededAreas(['<행위>, sex/kiss'], acts)).toEqual({})
    expect(neededAreas(['-1::sex::, kiss'], acts)).toEqual({})
    expect(neededAreas(['kiss, 1.2::sex::'], acts)).toEqual({ lower: 'sex' })
  })

  it('더는 젖히는 태그를 몰래 붙이지 않는다', () => {
    expect('autoExposeTags' in autoExpose).toBe(false)
  })
})

describe('이 옷을 젖히는 태그', () => {
  it('비키니는 아래·가슴 둘 다', () => {
    expect(exposePreview('1.2::bikini armor::, black armor')).toEqual({
      lower: ['bikini bottom aside'],
      chest: ['bikini top lift']
    })
  })

  it('겹쳐 입은 옷은 겉옷·속옷 둘 다 젖힌다', () => {
    expect(exposePreview('pleated skirt, white panties, white shirt')).toEqual({
      lower: ['skirt lift', 'panties aside'],
      chest: ['shirt lift']
    })
  })

  it('바지 입은 캐릭터에 skirt lift가 붙지 않는다', () => {
    expect(exposePreview('black pants, white shirt').lower).toEqual(['pants pull'])
  })

  it('셔츠만 알면 아래는 비워 둔다 (모르는 걸 추측하지 않음)', () => {
    expect(exposePreview('white shirt').lower).toEqual([])
  })

  it('빼달라는 음수 가중치의 옷은 입은 게 아니다', () => {
    expect(exposePreview('white shirt, -2::skirt::').lower).toEqual([])
  })

  it('문장에 옷 이름이 나와도 문장만으로는 옷을 입었다고 보지 않는다', () => {
    expect(
      detectGarments('The two cups of the black bikini top are joined in the middle.')
    ).toEqual([])
  })
})

describe('복장 탭의 nsfw 조각 후보', () => {
  it('기본 조각을 보고 부위마다 한 조각씩 — 누르면 nsfw 아래·가슴 조각이 된다', () => {
    const school = outfit(
      { name: '재킷', tags: 'school uniform jacket', on: true },
      { name: '치마', tags: 'pleated skirt, white panties', on: true },
      { name: '지퍼', tags: 'unzipped', on: false }
    )
    expect(exposeCandidates(school)).toEqual([
      {
        area: 'lower',
        name: '젖히기(아래)',
        tags: 'skirt lift, panties aside',
        when: 'nsfw-lower'
      },
      { area: 'chest', name: '젖히기(가슴)', tags: 'open jacket', when: 'nsfw-chest' }
    ])
  })

  it('꺼진 조각의 옷은 평소 옷이 아니라 후보를 만들지 않는다', () => {
    expect(
      exposeCandidates(
        outfit(
          { name: '셔츠', tags: 'white shirt', on: true },
          { name: '비키니', tags: 'black bikini', on: false }
        )
      )
    ).toEqual([{ area: 'chest', name: '젖히기(가슴)', tags: 'shirt lift', when: 'nsfw-chest' }])
  })

  it('이미 조각에 적힌 태그는 빼고, 다 들어 있으면 그 부위 후보는 없다', () => {
    const skirt = outfit(
      { name: '치마', tags: 'pleated skirt, white panties', on: true },
      { name: '들춤', tags: 'skirt lift', on: false }
    )
    expect(exposeCandidates(skirt)).toEqual([
      { area: 'lower', name: '젖히기(아래)', tags: 'panties aside', when: 'nsfw-lower' }
    ])
    const done = outfit(
      { name: '치마', tags: 'pleated skirt', on: true },
      { name: '젖히기', tags: 'skirt lift', on: false, when: 'nsfw-lower' }
    )
    expect(exposeCandidates(done)).toEqual([])
  })

  it('젖힐 옷을 못 찾으면 후보도 없다', () => {
    expect(exposeCandidates(outfit({ name: '망토', tags: 'hooded cloak', on: true }))).toEqual([])
  })
})
