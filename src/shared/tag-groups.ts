/**
 * 한글 묶음 이름으로 태그 묶음 찾기 (커스텀).
 *
 * 「뒷머리」「앞머리」처럼 부위·종류 이름으로 치면 그 묶음의 태그가 사용 수 순으로 쭉 뜬다.
 * 태그 사전의 한글 이름만으로는 묶음이 안 잡혀서(뒷머리 → 4개) 따로 묶어 둔다.
 * 기준: 단보루 위키 tag group:hair styles (2026-10 확인). 색인에 없는 태그는 검색 때 빠진다.
 */

export interface TagGroup {
  /** 검색어 — 띄어쓰기 없이 비교한다 */
  names: string[]
  tags: string[]
}

const BANGS = [
  'bangs',
  'arched bangs',
  'asymmetrical bangs',
  'bangs pinned back',
  'blunt bangs',
  'center-flap bangs',
  'crossed bangs',
  'wispy bangs',
  'choppy bangs',
  'diagonal bangs',
  'fanged bangs',
  'short bangs',
  'long bangs',
  'medium bangs',
  'hair between eyes',
  'long hair between eyes',
  'hair over one eye',
  'hair over eyes',
  'hair over face',
  'eyebrows hidden by hair',
  'parted bangs',
  'middle part',
  'double-parted bangs',
  'curtained hair',
  'swept bangs',
  'flipped bangs',
  'colored bangs',
  'braided bangs',
  'single bang',
  'v-bangs',
  'cut bangs',
  'loosely tucked bangs',
  "widow's peak",
  'hime cut',
  'coin bangs',
  'forehead',
  'no bangs'
]

const SIDE = [
  'sidelocks',
  'long sidelocks',
  'very long sidelocks',
  'short sidelocks',
  'medium sidelocks',
  'asymmetrical sidelocks',
  'drill sidelocks',
  'low-tied sidelocks',
  'sidelocks tied back',
  'single sidelock',
  'braided sidelock',
  'braided sidelocks',
  'curly sidelocks',
  'wavy sidelocks',
  'blunt sidelocks',
  'hair intakes',
  'single hair intake',
  'hair flaps',
  'sideburns',
  'side ahoge',
  'one side up',
  'two side up',
  'side braid',
  'side braids',
  'side ponytail',
  'high side ponytail',
  'low side ponytail',
  'short side ponytail',
  'single side bun',
  'side up bun',
  'side drill',
  'blunt tresses',
  'short hair with long locks',
  'sidecut',
  'hair over shoulder',
  'hair behind ear',
  'temporal hairline'
]

const PONYTAILS = [
  'ponytail',
  'high ponytail',
  'low ponytail',
  'short ponytail',
  'long ponytail',
  'folded ponytail',
  'split ponytail',
  'braided ponytail',
  'front ponytail',
  'side ponytail',
  'low-tied long hair',
  'multi-tied hair',
  'half updo',
  'twintails',
  'low twintails',
  'short twintails',
  'long twintails',
  'uneven twintails',
  'tri tails',
  'quad tails',
  'topknot'
]

const BRAIDS = [
  'braid',
  'single braid',
  'twin braids',
  'low twin braids',
  'multiple braids',
  'side braid',
  'front braid',
  'crown braid',
  'half crown braid',
  'french braid',
  'braided bangs',
  'braided ponytail',
  'braided bun',
  'bun with braided base',
  'braided hair rings',
  'low-braided long hair',
  'half up braid',
  'half up half down braid',
  'tri braids',
  'quad braids',
  'rope braid',
  'cornrows',
  'dreadlocks',
  'box braids'
]

const BUNS = [
  'hair bun',
  'single hair bun',
  'double bun',
  'very low bun',
  'braided bun',
  'bun with braided base',
  'cone hair bun',
  'donut hair bun',
  'heart hair bun',
  'triple bun',
  'single side bun',
  'hair rings',
  'single hair ring',
  'bantu knots',
  'hair up',
  'updo',
  'topknot'
]

const BACK = [
  'lone nape hair',
  'nape',
  'hair down',
  'hair up',
  'hair pulled back',
  'hair slicked back',
  'back of head',
  'very low bun',
  'low-tied long hair',
  'low-braided long hair',
  'half updo',
  ...PONYTAILS,
  ...BUNS,
  'single braid',
  'twin braids',
  'low twin braids',
  'french braid',
  'braided ponytail'
]

const TOP = [
  'ahoge',
  'heart ahoge',
  'huge ahoge',
  'multiple ahoge',
  'antenna hair',
  'heart antenna hair',
  'comb over',
  'hair pulled back',
  'hair slicked back',
  'parted hair',
  'middle part',
  'mohawk',
  'crested hair',
  'hair horns',
  'pompadour',
  'quiff',
  'oseledets',
  'hair ornament'
]

const LENGTH = [
  'very short hair',
  'short hair',
  'medium hair',
  'long hair',
  'very long hair',
  'absurdly long hair',
  'big hair',
  'bald',
  'balding'
]

const CUTS = [
  'buzz cut',
  'crew cut',
  'pixie cut',
  'bob cut',
  'inverted bob',
  'bowl cut',
  'undercut',
  'flattop',
  'wolf cut',
  'hime cut',
  'jellyfish cut',
  'mullet',
  'short hair with long locks',
  'afro',
  'huge afro',
  'beehive hairdo',
  'pompadour',
  'quiff',
  'mohawk',
  'dreadlocks',
  'cornrows'
]

const TEXTURE = [
  'curly hair',
  'wavy hair',
  'straight hair',
  'messy hair',
  'fluffy hair',
  'flipped hair',
  'drill hair',
  'twin drills',
  'single drill',
  'hair flaps',
  'pointy hair',
  'spiked hair',
  'ringlets',
  'kinky hair',
  'hair horns',
  'shiny hair',
  'wet hair'
]

const BODY = [
  'hair over breasts',
  'hair over one breast',
  'hair over crotch',
  'hair over shoulder',
  'convenient hair',
  'hair bikini',
  'hair in own mouth',
  'hair scarf',
  'hair censor'
]

export const TAG_GROUPS: TagGroup[] = [
  { names: ['앞머리', '뱅'], tags: BANGS },
  { names: ['옆머리', '사이드락', '옆트임머리'], tags: SIDE },
  { names: ['뒷머리', '뒤머리'], tags: BACK },
  { names: ['윗머리', '정수리', '정수리머리'], tags: TOP },
  { names: ['머리길이', '머리기장'], tags: LENGTH },
  { names: ['헤어컷', '머리커트', '커트머리'], tags: CUTS },
  { names: ['묶은머리', '묶음머리', '포니테일종류', '트윈테일종류'], tags: PONYTAILS },
  { names: ['땋은머리', '땋기', '땋은머리종류'], tags: BRAIDS },
  { names: ['올림머리', '똥머리', '번머리', '경단머리'], tags: BUNS },
  { names: ['머릿결', '머리결', '머리질감'], tags: TEXTURE },
  { names: ['몸가린머리', '머리로가리기'], tags: BODY },
  {
    names: ['헤어스타일', '머리모양', '머리스타일'],
    tags: [...LENGTH, ...BANGS, ...SIDE, ...BACK, ...TOP, ...CUTS, ...BRAIDS, ...TEXTURE]
  }
]

/** 검색어에 맞는 묶음 — 이름과 같으면 exact, 이름의 앞부분이면(뒷머 → 뒷머리) prefix */
export function tagGroupsFor(query: string): { group: TagGroup; exact: boolean }[] {
  const q = query.replace(/\s+/g, '')
  if (!/[가-힣]/.test(q) || q.length < 2) return []
  const out: { group: TagGroup; exact: boolean }[] = []
  for (const group of TAG_GROUPS) {
    if (group.names.includes(q)) out.push({ group, exact: true })
    else if (group.names.some((n) => n.startsWith(q))) out.push({ group, exact: false })
  }
  return out
}
