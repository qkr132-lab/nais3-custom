// 한글 태그 사전 빌드: 수동 사전 + 색상×부위 조합 자동 생성 → resources/tags-ko.json
// 실행: node scripts/build-tags-ko.mjs  (tags.json에 실존하는 태그만 남긴다)
import { readFileSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const tags = JSON.parse(readFileSync(join(root, 'resources', 'tags.json'), 'utf8'))
const manual = JSON.parse(readFileSync(join(root, 'scripts', 'tags-ko-manual.json'), 'utf8'))

const exists = new Set(tags.map((t) => t.value))

// ── 색상 사전 (수식어형) ─────────────────────────────────────────
const COLORS = {
  white: '하얀/흰색',
  black: '검은/검정',
  red: '빨간/붉은',
  blue: '파란/푸른',
  green: '초록/녹색',
  yellow: '노란/노랑',
  pink: '분홍/핑크',
  purple: '보라/퍼플',
  brown: '갈색',
  grey: '회색/그레이',
  silver: '은색/실버',
  gold: '금색/골드',
  orange: '주황/오렌지',
  aqua: '아쿠아/물색',
  cyan: '시안/청록',
  teal: '틸/청록',
  navy: '네이비/남색',
  lavender: '라벤더색',
  beige: '베이지',
  cream: '크림색',
  crimson: '진홍/크림슨',
  scarlet: '주홍/스칼렛',
  magenta: '마젠타',
  violet: '바이올렛/제비꽃색',
  indigo: '인디고/쪽빛',
  turquoise: '터쿼이즈/청록',
  emerald: '에메랄드색',
  amber: '호박색/앰버',
  blonde: '금발의',
  platinum: '플래티넘',
  'light blue': '하늘색/연파랑',
  'light brown': '연갈색/밝은 갈색',
  'light green': '연두/연초록',
  'light purple': '연보라',
  'dark blue': '어두운 파랑/진청',
  'dark green': '진초록/암녹색',
  'dark red': '어두운 빨강/암적색',
  'dark purple': '어두운 보라',
  'pale blue': '옅은 파랑',
  'hot pink': '진분홍/핫핑크',
  'rose gold': '로즈골드',
  multicolored: '여러 색/다색',
  'two-tone': '투톤',
  gradient: '그라데이션',
  rainbow: '무지개색',
  transparent: '투명',
  clear: '투명/맑은'
}

// ── 부위/아이템 사전 (명사형) ────────────────────────────────────
const PARTS = {
  eyes: '눈/눈동자/홍채',
  hair: '머리/머리카락/헤어',
  skin: '피부',
  background: '배경',
  dress: '드레스/원피스',
  shirt: '셔츠',
  skirt: '치마/스커트',
  jacket: '재킷',
  coat: '코트',
  hoodie: '후드티',
  sweater: '스웨터/니트',
  vest: '조끼',
  bikini: '비키니',
  swimsuit: '수영복',
  'one-piece swimsuit': '원피스 수영복',
  leotard: '레오타드',
  bodysuit: '바디수트',
  panties: '팬티',
  bra: '브라',
  thighhighs: '니삭스/사이하이',
  pantyhose: '팬티스타킹',
  socks: '양말',
  kneehighs: '무릎 양말',
  gloves: '장갑',
  scarf: '목도리/스카프',
  ribbon: '리본',
  bow: '리본 매듭',
  bowtie: '나비넥타이',
  necktie: '넥타이',
  choker: '초커',
  hairband: '헤어밴드/머리띠',
  headband: '머리띠',
  hat: '모자',
  cape: '케이프/망토',
  cloak: '망토',
  kimono: '기모노',
  apron: '앞치마',
  footwear: '신발',
  shoes: '신발',
  boots: '부츠',
  'high heels': '하이힐',
  sneakers: '운동화',
  shorts: '반바지',
  pants: '바지',
  nails: '손톱/네일',
  lips: '입술',
  fur: '털/퍼',
  wings: '날개',
  flower: '꽃',
  rose: '장미',
  butterfly: '나비',
  cat: '고양이',
  theme: '테마/색 컨셉',
  border: '테두리',
  sky: '하늘',
  fire: '불꽃',
  'sailor collar': '세일러 카라',
  pupils: '동공/눈동자 속',
  sclera: '공막/흰자위',
  halo: '헤일로/천사 고리',
  headwear: '모자/머리쓰개',
  legwear: '레그웨어/스타킹류',
  sleeves: '소매',
  belt: '벨트',
  collar: '칼라/목줄',
  neckerchief: '네커치프/목수건',
  ascot: '애스컷 타이',
  capelet: '케이플릿/짧은 망토',
  horns: '뿔',
  tail: '꼬리',
  serafuku: '세일러복',
  'sports bra': '스포츠 브라',
  'tank top': '탱크탑/나시',
  cardigan: '가디건',
  hakama: '하카마',
  suit: '정장/수트',
  eyeshadow: '아이섀도',
  eyeliner: '아이라이너',
  gemstone: '보석/젬',
  'wrist cuffs': '손목 커프스',
  camisole: '캐미솔',
  hairband: '헤어밴드/머리띠',
  overalls: '멜빵바지',
  cloak: '망토',
  leotard: '레오타드',
  bodysuit: '바디수트',
  buruma: '부르마',
  bloomers: '블루머',
  sash: '새시/허리띠',
  feathers: '깃털',
  outline: '외곽선/아웃라인'
}

// ── 패턴/장식 수식어 × 부위 조합 ─────────────────────────────────
const PATTERNS = {
  striped: '줄무늬',
  'vertical-striped': '세로 줄무늬',
  plaid: '체크무늬/타탄',
  checkered: '체커/격자무늬',
  'polka dot': '물방울무늬/도트',
  frilled: '프릴 달린',
  'lace-trimmed': '레이스 장식',
  'fur-trimmed': '퍼 장식/모피 트림',
  torn: '찢어진',
  print: '프린트/무늬',
  'see-through': '시스루/비치는',
  wet: '젖은',
  'high-waist': '하이웨이스트',
  layered: '레이어드/겹친',
  cropped: '크롭/짧은',
  oversized: '오버사이즈',
  collared: '카라 있는',
  hooded: '후드 달린',
  sleeveless: '민소매',
  strapless: '스트랩리스/끈 없는',
  'off-shoulder': '오프숄더',
  ripped: '찢어진/립드'
}
const PATTERN_PARTS = {
  clothes: '옷',
  shirt: '셔츠',
  skirt: '치마',
  dress: '드레스/원피스',
  bikini: '비키니',
  swimsuit: '수영복',
  thighhighs: '니삭스/사이하이',
  pantyhose: '팬티스타킹',
  panties: '팬티',
  bra: '브라',
  bow: '리본',
  ribbon: '리본',
  jacket: '재킷',
  coat: '코트',
  cape: '케이프',
  sleeves: '소매',
  kimono: '기모노',
  legwear: '레그웨어',
  gloves: '장갑',
  apron: '앞치마',
  hairband: '헤어밴드',
  socks: '양말',
  scarf: '목도리',
  sweater: '스웨터',
  shorts: '반바지',
  hoodie: '후드티',
  leotard: '레오타드',
  hat: '모자',
  choker: '초커',
  'bikini top': '비키니 상의',
  'thigh strap': '허벅지 스트랩'
}

// 색상+부위 조합 생성 — 실존 태그만
const composed = {}
for (const [cEn, cKo] of Object.entries(COLORS)) {
  const koColor = cKo.split('/')[0]
  for (const [pEn, pKo] of Object.entries(PARTS)) {
    const tag = `${cEn} ${pEn}`
    if (!exists.has(tag)) continue
    const koPart = pKo.split('/')[0]
    // 동의어는 검색용으로 전체 유지: "파란 눈 (파란/푸른 + 눈/눈동자/홍채)"
    composed[tag] = `${koColor} ${koPart} (${cKo} ${pKo})`
  }
}

// 패턴×부위 조합 생성 — 실존 태그만
for (const [pEn, pKo] of Object.entries(PATTERNS)) {
  const koPattern = pKo.split('/')[0]
  for (const [tEn, tKo] of Object.entries(PATTERN_PARTS)) {
    const tag = `${pEn} ${tEn}`
    if (!exists.has(tag) || composed[tag]) continue
    const koPart = tKo.split('/')[0]
    composed[tag] = `${koPattern} ${koPart} (${pKo} ${tKo})`
  }
}

// 수동 사전 검증 — 없는 태그는 경고 후 제외 (manual2가 manual을 덮음)
let manual2 = {}
try {
  manual2 = JSON.parse(readFileSync(join(root, 'scripts', 'tags-ko-manual2.json'), 'utf8'))
} catch {
  // 2차 사전 없으면 무시
}
const merged = { ...composed }
const missing = []
for (const [tag, ko] of Object.entries({ ...manual, ...manual2 })) {
  if (exists.has(tag)) merged[tag] = ko
  else missing.push(tag)
}

writeFileSync(join(root, 'resources', 'tags-ko.json'), JSON.stringify(merged), 'utf8')
console.log(`OK: ${Object.keys(merged).length} entries (composed ${Object.keys(composed).length}, manual ${Object.keys(manual).length - missing.length})`)
if (missing.length) {
  console.log(`제외된 미존재 태그 ${missing.length}개:`)
  console.log(missing.join(', '))
}
