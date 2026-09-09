/** Local search vocabulary, not generated translations. All results still have
 * to resolve to a real entry in the shipped tag dictionary. Longest forms first.
 * Keep distinct colors/body parts separate and retain every query constraint.
 */
const CONCEPTS = [
  [
    'smile',
    '미소짓는',
    '미소짓기',
    '미소짓다',
    '웃고있는',
    '웃고 있는',
    '웃는',
    '웃음',
    '미소',
    '웃다'
  ],
  ['laugh', '크게웃는', '크게 웃는', '활짝웃는', '활짝 웃는', '깔깔', '박장대소', '웃음소리'],
  ['angry', '화가난', '화가 난', '화난', '화남', '분노한', '분노', '성난', '성내는'],
  ['sad', '슬퍼하는', '슬픈', '슬픔', '슬프다', '우울한', '우울'],
  ['crying', '울고있는', '울고 있는', '우는', '울음', '울다', '눈물흘리는'],
  ['tears', '눈물'],
  ['surprised', '깜짝놀란', '깜짝 놀란', '놀라는', '놀란', '놀람', '놀라다'],
  ['blush', '부끄러운', '부끄러움', '부끄러워하는', '수줍은', '홍조', '얼굴붉힘'],
  ['pink', '분홍색', '핑크색', '분홍', '핑크'],
  ['blue', '파란색', '푸른색', '파랑', '파란', '푸른', '청색'],
  ['red', '빨간색', '붉은색', '빨강', '빨간', '붉은', '적색'],
  ['green', '초록색', '녹색', '초록'],
  ['yellow', '노란색', '노랑', '노란', '황색'],
  ['purple', '보라색', '보라', '자주색'],
  ['white', '하얀색', '하얀', '흰색', '백색', '흰'],
  ['black', '검은색', '검정색', '검은', '검정', '흑색'],
  ['blonde', '금발머리', '금발 머리', '금발'],
  ['hair', '머리카락', '헤어스타일', '머리', '헤어'],
  ['eyes', '눈동자', '홍채', '눈'],
  ['long', '길다란', '긴', '장발', '롱'],
  ['short', '짧은', '단발', '숏'],
  ['ponytail', '포니테일', '포니 테일', '말총머리', '묶은머리'],
  ['twintails', '트윈테일', '트윈 테일', '양갈래머리', '양갈래'],
  ['glasses', '안경', '안경쓴', '안경 쓴'],
  ['dress', '드레스', '원피스'],
  ['skirt', '스커트', '치마'],
  ['jacket', '재킷', '자켓', '재켓'],
  ['sneakers', '스니커즈', '운동화'],
  ['sitting', '앉아있는', '앉아 있는', '앉은', '앉기', '앉다'],
  ['standing', '서있는', '서 있는', '서기', '서다'],
  ['running', '달리는', '달리기', '달리다', '뛰는'],
  ['jumping', '점프하는', '점프', '뛰어오르는'],
  ['looking at viewer', '정면을보는', '정면을 보는', '이쪽을보는', '이쪽을 보는', '카메라를보는'],
  ['from above', '위에서본', '위에서 본', '위에서보는', '위에서 보는', '하이앵글'],
  ['from below', '아래에서본', '아래에서 본', '아래에서보는', '로우앵글'],
  ['night', '밤', '야간', '한밤중'],
  ['rain', '비오는', '비 오는', '빗속', '빗물'],
  ['forest', '숲속', '숲', '산림'],
  ['beach', '해변', '바닷가', '모래사장'],
  ['sky', '하늘'],
  ['background', '배경']
] as const

const replacements = CONCEPTS.flatMap(([key, ...words]) =>
  words.map((word) => [word.replace(/\s/g, ''), key] as const)
).sort((a, b) => b[0].length - a[0].length)
const meanings = new Map(replacements)
const pattern = new RegExp(replacements.map(([word]) => word).join('|'), 'g')

export function compact(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\s_\-()/,;|]+/g, '')
}

export function relatedKey(text: string): string {
  return compact(text).replace(pattern, (word) => meanings.get(word) ?? word)
}

export function koreanInitials(text: string): string {
  const initials = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
  return [...text]
    .map((c) => {
      const n = c.charCodeAt(0) - 0xac00
      return n >= 0 && n < 11172 ? initials[Math.floor(n / 588)] : c
    })
    .join('')
    .replace(/\s/g, '')
}

/** Compatibility jamo preserves unfinished syllables: 저 → 전신, 전ㅅ → 전신.
 * NFC first also accepts text pasted from decomposed Unicode sources. */
export function koreanTypingKey(text: string): string {
  const initials = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ'
  const vowels = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ'
  const finals = [
    '',
    'ㄱ',
    'ㄲ',
    'ㄳ',
    'ㄴ',
    'ㄵ',
    'ㄶ',
    'ㄷ',
    'ㄹ',
    'ㄺ',
    'ㄻ',
    'ㄼ',
    'ㄽ',
    'ㄾ',
    'ㄿ',
    'ㅀ',
    'ㅁ',
    'ㅂ',
    'ㅄ',
    'ㅅ',
    'ㅆ',
    'ㅇ',
    'ㅈ',
    'ㅊ',
    'ㅋ',
    'ㅌ',
    'ㅍ',
    'ㅎ'
  ]
  return [...compact(text)]
    .map((c) => {
      const n = c.charCodeAt(0) - 0xac00
      return n >= 0 && n < 11172
        ? initials[Math.floor(n / 588)] + vowels[Math.floor(n / 28) % 21] + finals[n % 28]
        : c
    })
    .join('')
}

/** Bounded Damerau distance: one typo/transposition in a meaningful word. */
export function oneTypo(a: string, b: string): boolean {
  if (a.length < 3 || b.length < 3 || Math.abs(a.length - b.length) > 1 || a === b) return false
  let i = 0
  while (i < a.length && a[i] === b[i]) i++
  if (a.length === b.length) {
    return (
      a.slice(i + 1) === b.slice(i + 1) ||
      (a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2))
    )
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1)
}
