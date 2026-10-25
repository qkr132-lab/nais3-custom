import type { Outfit } from '../../src/shared/outfit'
import type { ExposeStatus } from '../../src/shared/types'

/**
 * 입은 옷 자동 젖힘 회귀 시험용 합성 자료 — 실제 씬 골격(요리·섹스 후·핑거링·림잡·야외 가슴 만지기·얼굴 인셋 …)을
 * 흉내 낸 합성본이다. 태그는 단보루에 있는 것만, 문장은 같은 골격의 지어낸 문장. 사용자 씬·카드·복장 원문은 없다.
 */

export interface SyntheticCard {
  id: number
  name: string
  prompt: string
  role: 'source' | 'target' | null
  outfitId?: number
}

/** 카드 키 → 카드 */
export const CARDS: Record<string, SyntheticCard> = {
  // 카드에 직접 적은 옷 (복장 없음)
  A: {
    id: 101,
    name: '캐주얼',
    prompt: '1girl, long hair, pleated skirt, white panties, white shirt, white bra',
    role: 'target'
  },
  // 문장으로 적은 옷
  B: {
    id: 102,
    name: '메이드',
    prompt: '1girl, She wears a long black maid dress with a white apron.',
    role: 'target'
  },
  // 복장(nsfw 아래 조각 있음, 가슴 조각 없음)
  C: { id: 103, name: '교복', prompt: '1girl, short hair', role: 'target', outfitId: 9 },
  // 옷을 못 읽는 카드
  D: { id: 104, name: '맨몸', prompt: '1girl, long hair, blue eyes', role: 'target' },
  // 비키니
  E: { id: 105, name: '비키니', prompt: '1girl, black bikini, ponytail', role: 'target' },
  // 음수 가중치로 막은 카드
  F: {
    id: 106,
    name: '거부',
    prompt: '1girl, pleated skirt, white panties, -1::skirt lift::',
    role: 'target'
  },
  // 역할이 없는 카드
  G: { id: 107, name: '무역할', prompt: '1girl, white dress', role: null },
  // 남캐 (하는쪽) — 바지를 입음 / 옷 없음
  M: {
    id: 201,
    name: '남캐',
    prompt: '1boy, male focus, black pants, white shirt',
    role: 'source'
  },
  N: { id: 202, name: '맨몸남', prompt: '1boy, male focus, muscular male', role: 'source' }
}

export const OUTFITS: Outfit[] = [
  {
    id: 9,
    name: '치마 교복',
    negative: '',
    pieces: [
      { id: 'p1', name: '치마', tags: 'pleated skirt, white panties', on: true },
      { id: 'p2', name: '셔츠', tags: 'white shirt', on: true },
      {
        id: 'p3',
        name: '젖히기(아래)',
        tags: 'skirt lift, panties aside',
        on: false,
        when: 'nsfw-lower'
      }
    ]
  }
]

type Who = Partial<Record<'lower' | 'chest', ExposeStatus>> & { add?: string[] }

export interface SyntheticScene {
  name: string
  prompt: string
  sourceTags?: string
  targetTags?: string
  /** 자리 수 (0 이면 자리 없음) — 자리마다 역할·태그 */
  slotRoles?: Record<number, 'source' | 'target' | null>
  slotTags?: Record<number, string>
  /** 씬의 옷 벗기기 — true 둘 다 · false 안 벗김 · male 남캐만 · female 여캐만 */
  nudeStrip?: boolean | 'male' | 'female'
  /** 함께 그리는 남캐 */
  male?: 'M' | 'N'
  /** 히로인 (기본 A) */
  heroine?: string
  /** 기대 — 카드 키별로 부위 상태와 붙은 태그 */
  expect: Record<string, Who>
}

export const SCENES: SyntheticScene[] = [
  {
    name: '요리',
    prompt: '1girl, 2::cooking, holding tray, presenting food::, smile',
    expect: { A: { add: [] } }
  },
  {
    name: '섹스 후 시치미',
    prompt: 'solo, standing, after sex, after vaginal, 2::puffy nipples ::, blush',
    expect: { A: { chest: 'after', add: [] } }
  },
  {
    name: '정상위',
    prompt: 'pink background, missionary, spread legs',
    sourceTags: 'sex, 1.3::kiss::',
    targetTags: 'nipples, heavy breathing',
    male: 'M',
    expect: {
      A: {
        lower: 'added',
        chest: 'added',
        add: ['skirt lift', 'panties aside', 'shirt lift', 'bra lift']
      },
      M: { lower: 'added', add: ['pants pull', 'open fly'] }
    }
  },
  {
    name: '정상위 (남캐 옷 없음)',
    prompt: 'missionary',
    sourceTags: 'sex',
    male: 'N',
    expect: { A: { lower: 'added' }, N: { lower: 'no-garment', add: [] } }
  },
  {
    name: '핑거링 · 자리 태그에 clothing aside',
    prompt: 'pink background',
    sourceTags: 'fingering, kiss',
    slotRoles: { 0: 'target', 1: 'source' },
    slotTags: { 0: 'clothing aside, blush' },
    male: 'M',
    expect: { A: { lower: 'already', add: [] }, M: { add: [] } }
  },
  {
    name: '핑거링 · 옷 벗기기=켬이면 알몸 우선 + 충돌 표시',
    prompt: 'pink background',
    sourceTags: 'fingering',
    slotRoles: { 0: 'target', 1: 'source' },
    slotTags: { 0: 'clothing aside' },
    nudeStrip: true,
    male: 'M',
    // 알몸과 충돌은 한 줄(충돌)로 보인다
    expect: { A: { lower: 'conflict', add: [] } }
  },
  {
    name: '하는쪽 칸에 open clothes — 누구 옷인지 모른다',
    prompt: 'sex, nipples',
    sourceTags: 'open clothes',
    male: 'M',
    // 그 태그는 하는쪽(남캐) 프롬프트에만 가므로 남캐 몫이다 — 이미 젖혀진 글이 있으니 pants pull 을 안 붙인다 (예전엔 히로인이 판단 못 함이었다)
    expect: { M: { lower: 'already', add: [] } }
  },
  {
    name: '림잡 — 받는 쪽은 남캐',
    prompt:
      "male's lower body, A grown woman kneels behind a man and presses her lips to his ass. Her knees are apart, but her pussy stays hidden from the camera.",
    sourceTags: 'anilingus',
    male: 'M',
    expect: {
      A: { lower: 'negated', add: [] },
      M: { lower: 'added', add: ['pants pull', 'open fly'] }
    }
  },
  {
    name: '림잡 준비 — 항문이 안 보인다고 적은 문장',
    prompt:
      "male's lower body, A grown woman kisses his anus. His anus is not visible behind her mouth.",
    sourceTags: 'rimjob pose',
    male: 'M',
    expect: { M: { lower: 'off-frame', add: [] } }
  },
  {
    name: '야외에서 몰래 가슴 만짐 — 옷 위',
    prompt:
      'upper body. In a quiet corridor the man secretly squeezes the outer side of her breast with one hand.',
    sourceTags: "1.4::source#grabbing_another's_breast::",
    targetTags: "target#grabbing_another's_breast, blush",
    male: 'M',
    expect: { A: { chest: 'over-clothes', add: [] } }
  },
  {
    name: '고간 만져짐 — 젖은 자국',
    prompt: "another's hand on pussy, pussy juice stain, embarrassed",
    male: 'M',
    expect: { A: { lower: 'over-clothes', add: [] } }
  },
  {
    name: '얼굴 인셋이 섞인 메이팅 프레스',
    prompt: 'top right inset, mating press, motion lines',
    sourceTags: 'source#mating press',
    targetTags: 'target#mating press',
    slotRoles: { 0: 'target', 1: 'target', 2: 'source' },
    slotTags: { 1: '1girl, pink inset, portrait, pussy, ahegao' },
    male: 'M',
    expect: { A: { lower: 'added' }, M: { lower: 'added' } }
  },
  {
    name: '딜도 자위',
    prompt: 'solo, from behind, huge pink dildo, squatting, spread legs, pussy, anus, pussy juice',
    expect: { A: { lower: 'added', add: ['skirt lift', 'panties aside'] } }
  },
  {
    name: '파이즈리 — 여 가슴과 남 아래',
    prompt: 'pink background',
    sourceTags: 'paizuri',
    male: 'M',
    expect: {
      A: { chest: 'added', add: ['shirt lift', 'bra lift'] },
      M: { lower: 'added', add: ['pants pull', 'open fly'] }
    }
  },
  {
    name: '펠라치오 — 남 아래만',
    prompt: 'pink background, pov',
    sourceTags: 'fellatio',
    male: 'M',
    expect: { A: { add: [] }, M: { lower: 'added' } }
  },
  {
    name: '쿤닐링구스 — 여 아래만',
    prompt: 'pink background',
    sourceTags: 'cunnilingus',
    male: 'M',
    expect: { A: { lower: 'added' }, M: { add: [] } }
  },
  {
    name: '구도가 상반신',
    prompt: 'upper body, vaginal sex',
    male: 'M',
    expect: { A: { lower: 'off-frame', add: [] } }
  },
  {
    name: '착의 섹스',
    prompt: 'clothed sex, vaginal',
    male: 'M',
    expect: { A: { lower: 'added', add: ['skirt lift', 'panties aside'] } }
  },
  {
    name: '밤 샤워 (젖힘과 상관없는 장면)',
    prompt: 'bathroom, shower, wet hair, smile',
    male: 'M',
    expect: { A: { add: [] }, M: { add: [] } }
  },
  {
    name: '메이드복 (문장으로 적은 옷)',
    heroine: 'B',
    prompt: 'missionary',
    sourceTags: 'sex, nipples',
    male: 'M',
    expect: {
      B: { lower: 'added', chest: 'added', add: ['apron lift', 'dress lift', 'dress pull'] }
    }
  },
  {
    name: '복장 히로인 · nsfw 조각이 아래를 맡는다',
    heroine: 'C',
    prompt: 'missionary',
    sourceTags: 'sex, paizuri',
    male: 'M',
    expect: {
      C: { lower: 'piece', chest: 'added', add: ['shirt lift'] },
      M: { lower: 'added', add: ['pants pull', 'open fly'] }
    }
  },
  {
    name: '옷을 못 읽는 카드',
    heroine: 'D',
    prompt: 'missionary',
    sourceTags: 'sex',
    male: 'N',
    expect: { D: { lower: 'no-garment', add: [] } }
  },
  {
    name: '비키니',
    heroine: 'E',
    prompt: 'missionary',
    sourceTags: 'sex, breast sucking',
    male: 'M',
    expect: {
      E: { lower: 'added', chest: 'added', add: ['bikini bottom aside', 'bikini top lift'] }
    }
  },
  {
    name: '음수 가중치로 막은 젖힘',
    heroine: 'F',
    prompt: 'missionary',
    sourceTags: 'sex',
    male: 'M',
    expect: { F: { lower: 'added', add: ['panties aside'] } }
  },
  {
    name: '역할 없는 카드도 씬 글을 받는다',
    heroine: 'G',
    prompt: 'missionary, sex',
    male: 'M',
    expect: { G: { lower: 'added', chest: undefined, add: ['dress lift'] } }
  },
  {
    name: '옷 벗기기=여캐만 — 남캐는 입은 채라 젖힘이 붙는다',
    prompt: 'missionary',
    sourceTags: 'sex',
    nudeStrip: 'female',
    male: 'M',
    expect: {
      A: { lower: 'nude', chest: undefined, add: [] },
      M: { lower: 'added', add: ['pants pull', 'open fly'] }
    }
  },
  {
    name: '옷 벗기기=남캐만 — 여캐는 입은 채라 젖힘이 붙는다',
    prompt: 'missionary',
    sourceTags: 'sex',
    nudeStrip: 'male',
    male: 'M',
    expect: {
      A: { lower: 'added', add: ['skirt lift', 'panties aside'] },
      M: { lower: 'nude', add: [] }
    }
  },
  {
    name: '옷 벗기기=안 벗김이어도 장면 글에 nude 가 있으면 젖힐 옷이 없다고 본다',
    prompt: 'missionary, vaginal, nude',
    nudeStrip: false,
    male: 'M',
    expect: { A: { lower: 'nude', add: [] } }
  },
  {
    name: '다리 위 알몸 선언 (bottomless)',
    prompt: 'bed, vaginal, bottomless',
    male: 'M',
    expect: { A: { lower: 'nude', add: [] } }
  }
]
