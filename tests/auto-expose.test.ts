import { describe, expect, it } from 'vitest'
import * as autoExpose from '../src/shared/auto-expose'
import {
  DEFAULT_EXPOSE_ACTS as acts,
  detectGarments,
  exposeCandidates,
  exposePreview,
  neededAreas,
  readGarments,
  triggerAreas,
  withDefaultActs
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
    expect(triggerAreas(['vaginal', "grabbing another's breast"], acts)).toEqual({
      lower: true,
      chest: true
    })
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

  it('행위 태그를 단어 단위로 품은 장면 태그도 그 행위로 본다', () => {
    expect(neededAreas(['spooning sex, penis inside pussy'], acts)).toEqual({
      lower: 'spooning sex'
    })
    expect(neededAreas(['standing doggystyle'], acts)).toEqual({ lower: 'standing doggystyle' })
    expect(neededAreas(['reverse suspended congress'], acts)).toEqual({
      lower: 'reverse suspended congress'
    })
    expect(neededAreas(['2::pussy,penis,navel,nipples,breasts out::'], acts)).toEqual({
      lower: 'pussy',
      chest: 'nipples'
    })
    expect(neededAreas(['target#reverse paizuri, hand on breasts'], acts)).toEqual({
      chest: 'reverse paizuri'
    })
    expect(neededAreas(['1.3::dildo riding, vaginal object insertion::'], acts)).toEqual({
      lower: 'dildo riding'
    })
    expect(neededAreas(['3::nursing handjob, breast sucking::'], acts)).toEqual({
      chest: 'nursing handjob'
    })
    // 단어 일부만 같은 것은 아니다
    expect(neededAreas(['sexy pose, analysis'], acts)).toEqual({})
    // 문장은 뜻이 반대일 수 있어 그대로 일치할 때만
    expect(neededAreas(['she is seen from the side, her pussy is not shown at all'], acts)).toEqual(
      {}
    )
  })

  it('옷 위 태그(젖은 자국·가림)는 신호가 아니고, 있으면 몸 부위 이름만 걸린 신호도 무시한다', () => {
    // 젖은 자국 = 옷을 입은 채
    expect(neededAreas(['crotch focus, pussy juice trail, pussy juice stain'], acts)).toEqual({})
    expect(neededAreas(["another's hand on pussy, pussy juice stain"], acts)).toEqual({})
    expect(neededAreas(['covered nipples, bouncing breasts'], acts)).toEqual({})
    // 행위 태그가 같이 있으면 켠다
    expect(neededAreas(['pussy juice stain, vaginal'], acts)).toEqual({ lower: 'vaginal' })
    expect(neededAreas(['covered nipples, paizuri'], acts)).toEqual({ chest: 'paizuri' })
    // 다른 부위의 옷 위 태그는 상관없다
    expect(neededAreas(['covered nipples, pussy juice'], acts)).toEqual({ lower: 'pussy juice' })
  })

  it('얼굴만 나오는 자리 — inset·portrait·close-up', () => {
    expect(autoExpose.isFaceSeat('inset')).toBe(true)
    expect(autoExpose.isFaceSeat('3::portrait::')).toBe(true)
    expect(autoExpose.isFaceSeat('pink inset,1.2::close-up::, ahegao')).toBe(true)
    expect(autoExpose.isFaceSeat('lower body, crotch focus')).toBe(false)
    expect(autoExpose.isFaceSeat('-2::portrait::, upper body')).toBe(false)
  })

  it('하는쪽이 상대 몸에 하는 행위는 당하는쪽 조각을 켜고, 하는쪽 자기 몸 이야기는 켜지 않는다', () => {
    expect(
      autoExpose.triggerAreas(['standing, orgasm'], acts, undefined, ['1boy, breast punch'])
    ).toEqual({
      lower: false,
      chest: true
    })
    expect(
      autoExpose.triggerAreas(['lying'], acts, undefined, ["grabbing another's breast, vaginal"])
    ).toEqual({ lower: true, chest: true })
    // 하는쪽이 자위하거나 제 몸을 보이거나 얼굴에 앉는 것은 상대를 드러내지 않는다
    expect(
      autoExpose.triggerAreas(['lying'], acts, undefined, [
        'futanari, pussy, masturbation, sitting on face'
      ])
    ).toEqual({ lower: false, chest: false })
    // 씬에서 자동 켜기를 껐으면 하는쪽 태그로도 켜지 않는다
    expect(autoExpose.triggerAreas([''], acts, { auto: false }, ['vaginal'])).toEqual({})
  })

  it('fisting도 아래를 드러내는 행위로 본다', () => {
    expect(neededAreas(['1.5::fisting::'], acts)).toEqual({ lower: 'fisting' })
    expect(neededAreas(['anal fisting'], acts).lower).toBe('anal fisting')
  })

  it('저장된 목록에 새 기본 태그를 더한다 — 고친 것은 그대로', () => {
    const mine = { lower: ['spread legs', 'Doggystyle'], chest: [] }
    const merged = withDefaultActs(mine)
    expect(merged.lower.slice(0, 2)).toEqual(['spread legs', 'Doggystyle'])
    expect(merged.lower.filter((t) => t.toLowerCase() === 'doggystyle')).toHaveLength(1)
    expect(merged.lower).toContain('dildo riding')
    expect(merged.chest).toEqual(acts.chest)
    expect(withDefaultActs(acts)).toEqual(acts)
  })

  it('행위 목록의 죽은 태그(단보루에 없는 것)를 빼고 실제 태그를 더했다', () => {
    for (const dead of [
      'creampie',
      'anal creampie',
      'sex from above',
      'facesitting',
      'after sex',
      'after vaginal',
      'after anal'
    ])
      expect(acts.lower).not.toContain(dead)
    for (const dead of [
      'nipple sucking',
      'breast grab',
      "grabbing another's breasts",
      'breast slap'
    ])
      expect(acts.chest).not.toContain(dead)
    expect(acts.lower).toEqual(
      expect.arrayContaining([
        'deep penetration',
        'internal cumshot',
        'female ejaculation',
        'groping'
      ])
    )
    expect(acts.chest).toContain("grabbing another's breast")
  })

  it('젖히는 태그는 조건 맞는 태그를 따로 붙이는 함수가 없고, 붙는 것은 expose-state 가 메모와 함께 낸다', () => {
    // 이 모듈은 어느 부위가 드러나는지·어떤 태그가 후보인지만 안다 — 붙이는 일은 notes 와 함께 expose-state 가 한다
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

  it('바지 입은 캐릭터에 skirt lift가 붙지 않는다 (바지는 내리기와 앞섶 열기를 병기)', () => {
    expect(exposePreview('black pants, white shirt').lower).toEqual(['pants pull', 'open fly'])
  })

  it('셔츠만 알면 아래는 비워 둔다 (모르는 걸 추측하지 않음)', () => {
    expect(exposePreview('white shirt').lower).toEqual([])
  })

  it('빼달라는 음수 가중치의 옷은 입은 게 아니다', () => {
    expect(exposePreview('white shirt, -2::skirt::').lower).toEqual([])
  })

  it('문장 속 옷 이름도 토막 안 낱말 단위로 읽는다 (5단어 제한 폐지)', () => {
    expect(
      detectGarments('The two cups of the black bikini top are joined in the middle.').map(
        (g) => g.nouns[0]
      )
    ).toEqual(['bikini top'])
    expect(detectGarments('white and black maid dress').map((g) => g.nouns[0])).toEqual(['dress'])
  })

  it('입은 옷이 아닌 말은 옷으로 읽지 않는다', () => {
    const names = (text: string): string[] => detectGarments(text).map((g) => g.nouns[0])
    // dress shirt 는 셔츠, dress shoes 는 신발
    expect(names('dress shirt')).toEqual(['shirt'])
    expect(names('dress shoes')).toEqual([])
    // no X · without X · unworn X
    expect(names('no panties, no bra')).toEqual([])
    expect(names('she is not wearing a dress')).toEqual([])
    expect(names('unworn bikini top')).toEqual([])
    // 태닝 자국 · 머리/어깨/허리에 걸친 것 · 컵/가랑이가 트인 옷
    expect(names('bikini tan')).toEqual([])
    expect(names('panties on head')).toEqual([])
    expect(names('jacket on shoulders, jacket around waist')).toEqual([])
    expect(names('cupless bra, crotchless panties')).toEqual([])
    // 허리에 묶은 윗옷은 안 입은 것, 허리에 걸친 치마는 입은 것 · off shoulder 는 벗었다는 뜻이 아니다
    expect(names('skirt around her waist')).toEqual(['skirt'])
    expect(names('sweater around waist')).toEqual([])
    expect(names('off shoulder dress')).toEqual(['dress'])
    expect(names('she took off her jacket')).toEqual([])
    // naked apron 은 그 한 벌만 입은 것
    expect(readGarments('naked apron')).toEqual([
      expect.objectContaining({ alone: true, fragment: 'naked apron' })
    ])
    // 빼달라는 음수 가중치
    expect(names('white shirt, -2::skirt::')).toEqual(['shirt'])
  })

  it('옷 표를 넓혔다 — t-shirt · tank top · microskirt · evening gown · yukata · loincloth', () => {
    expect(exposePreview('t-shirt').chest).toEqual(['shirt lift'])
    expect(exposePreview('white tank top').chest).toEqual(['shirt lift'])
    expect(exposePreview('tube top').chest).toEqual(['breasts out'])
    expect(exposePreview('red microskirt').lower).toEqual(['skirt lift'])
    expect(exposePreview('evening gown')).toEqual({ lower: ['dress lift'], chest: ['dress pull'] })
    expect(exposePreview('yukata')).toEqual({ lower: ['kimono lift'], chest: ['open kimono'] })
    expect(exposePreview('loincloth').lower).toEqual(['clothing aside'])
    expect(exposePreview('black vest').chest).toEqual(['open vest'])
    expect(exposePreview('white robe').lower).toEqual(['open robe'])
    expect(exposePreview('pantyhose').lower).toEqual(['pantyhose pull', 'torn pantyhose'])
    // 전용 젖힘 태그가 없는 옷은 읽지 않는다
    expect(exposePreview('black armor, red cape, corset')).toEqual({ lower: [], chest: [] })
  })

  it('겹쳐 입으면 겉에서 속으로, 부위당 최대 3개', () => {
    // 겹마다 대표 태그 하나 — 가장 안쪽 속옷의 젖힘이 병기 태그(torn pantyhose)에 밀려 빠지지 않는다
    expect(exposePreview('jacket, shirt, bra, skirt, pantyhose, panties')).toEqual({
      lower: ['skirt lift', 'pantyhose pull', 'panties aside'],
      chest: ['open jacket', 'shirt lift', 'bra lift']
    })
    // 겹이 상한을 넘으면 같은 겹 순서(겉옷끼리)는 하나만 남기고 가장 안쪽 겹을 지킨다
    expect(exposePreview('jacket, hoodie, shirt, bra').chest).toEqual([
      'open jacket',
      'shirt lift',
      'bra lift'
    ])
    expect(exposePreview('coat, jacket, sweater, shirt, bra').chest).toEqual([
      'open coat',
      'sweater lift',
      'bra lift'
    ])
    // 자리가 남으면 병기 태그는 그 겹 바로 뒤에
    expect(exposePreview('pants, panties').lower).toEqual([
      'pants pull',
      'open fly',
      'panties aside'
    ])
    expect(exposePreview('pants, pantyhose, panties').lower).toEqual([
      'pants pull',
      'pantyhose pull',
      'panties aside'
    ])
    expect(exposePreview('dress, pantyhose, panties').lower).toEqual([
      'dress lift',
      'pantyhose pull',
      'panties aside'
    ])
    // 입력 순서가 달라도 겹 순서
    expect(exposePreview('panties, skirt').lower).toEqual(['skirt lift', 'panties aside'])
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
