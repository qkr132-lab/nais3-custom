/**
 * 복장 (커스텀) — 카드는 몸만, 옷은 복장으로 떼어 씬마다 갈아입힌다.
 *
 * 복장 = 조각 목록. 조각마다 태그와 "기본으로 켜짐"이 있다.
 *   치마 교복: ☑재킷 ☑셔츠 ☑치마 ☐지퍼 오픈 ☐치마 들춤
 * 씬에서는 복장을 고르고 조각을 켜고 끈다. 벗기는 건 기본 조각을 끄는 것,
 * 흐트러뜨리는 건 상태 조각을 켜는 것이다. 알몸도 복장 하나일 뿐 따로 대우하지 않는다.
 *
 * 앱이 씬을 보고 옷을 정하지 않는다 — 직접 고른 것만 따른다. 아무것도 안 고른 씬은
 * 카드의 기본 복장(없으면 카드 태그 그대로)으로 나간다.
 *
 * DB·파일 입출력 없이 순수 로직만 둔다 (테스트 가능하게).
 */

export interface OutfitPiece {
  /** 복장 안에서만 통하는 id — 씬의 켜고 끈 기록이 이걸 가리킨다 */
  id: string
  name: string
  tags: string
  /** 기본으로 켜짐 — 평소 모습에 들어가는 조각 */
  on: boolean
}

export interface Outfit {
  id: number
  name: string
  pieces: OutfitPiece[]
  /** 이 복장을 입을 때 캐릭터 네거티브에 붙는 태그 — 다른 끈 모양·원치 않는 갑옷 부위 막기 */
  negative: string
}

/**
 * 씬에서 이 캐릭터에게 입힐 옷.
 * 조각은 복장 기본값에서 바꾼 것만 적는다 — 나중에 복장을 고쳐도 씬이 따라가게.
 */
export interface OutfitChoice {
  outfitId: number
  /** 기본으로 꺼져 있지만 이 씬에서 켠 조각 */
  on?: string[]
  /** 기본으로 켜져 있지만 이 씬에서 끈 조각 */
  off?: string[]
}

/** 이 선택에서 실제로 켜지는 조각 (복장에 적힌 순서대로) */
export function activePieces(outfit: Outfit, choice?: Pick<OutfitChoice, 'on' | 'off'>): OutfitPiece[] {
  const on = new Set(choice?.on ?? [])
  const off = new Set(choice?.off ?? [])
  return outfit.pieces.filter((p) => (p.on && !off.has(p.id)) || (!p.on && on.has(p.id)))
}

/** 켜진 조각의 태그를 한 줄로 */
export function outfitTags(outfit: Outfit, choice?: Pick<OutfitChoice, 'on' | 'off'>): string {
  return activePieces(outfit, choice)
    .map((p) => p.tags.trim().replace(/^,+|,+$/g, '').trim())
    .filter(Boolean)
    .join(', ')
}

/**
 * 이 캐릭터가 이 그림에서 입는 복장.
 * 씬에서 고른 것 > 카드 기본 복장 > 없음. 지워진 복장을 가리키면 다음 순서로 물러난다.
 */
export function resolveOutfit(
  cardOutfitId: number | null | undefined,
  sceneChoice: OutfitChoice | undefined,
  outfits: ReadonlyMap<number, Outfit>
): { outfit: Outfit; choice?: OutfitChoice } | null {
  if (sceneChoice) {
    const o = outfits.get(sceneChoice.outfitId)
    if (o) return { outfit: o, choice: sceneChoice }
  }
  if (cardOutfitId != null) {
    const o = outfits.get(cardOutfitId)
    if (o) return { outfit: o }
  }
  return null
}

/** 입는 옷의 태그 (켜진 조각만) */
export function resolveOutfitTags(
  cardOutfitId: number | null | undefined,
  sceneChoice: OutfitChoice | undefined,
  outfits: ReadonlyMap<number, Outfit>
): string {
  const r = resolveOutfit(cardOutfitId, sceneChoice, outfits)
  return r ? outfitTags(r.outfit, r.choice) : ''
}

/** 입는 옷의 네거티브 — 조각을 켜고 끄는 것과 상관없이 그 복장을 입으면 붙는다 */
export function resolveOutfitNegative(
  cardOutfitId: number | null | undefined,
  sceneChoice: OutfitChoice | undefined,
  outfits: ReadonlyMap<number, Outfit>
): string {
  return resolveOutfit(cardOutfitId, sceneChoice, outfits)?.outfit.negative?.trim() ?? ''
}

/** 조각 켜고 끄기 — 기본값과 같아지면 기록에서 뺀다 (기록이 기본값 대비 차이만 남게) */
export function togglePiece(outfit: Outfit, choice: OutfitChoice, pieceId: string): OutfitChoice {
  const piece = outfit.pieces.find((p) => p.id === pieceId)
  if (!piece) return choice
  const on = new Set(choice.on ?? [])
  const off = new Set(choice.off ?? [])
  const active = (piece.on && !off.has(pieceId)) || (!piece.on && on.has(pieceId))
  if (piece.on) {
    if (active) off.add(pieceId)
    else off.delete(pieceId)
  } else if (active) on.delete(pieceId)
  else on.add(pieceId)
  return {
    outfitId: choice.outfitId,
    ...(on.size ? { on: [...on] } : {}),
    ...(off.size ? { off: [...off] } : {})
  }
}

// ── 카드에서 옷 떼어내기 ──────────────────────────────────────────────────

/** 태그 하나가 무엇인지 — 옷 / 알몸·노출 / 몸 / 모름 */
export type TagKind = 'cloth' | 'bare' | 'body' | 'unknown'

/**
 * 최상위 쉼표로 나눈다. `n::a, b::` 가중치 묶음 안은 한 덩어리로 두고,
 * 쉼표 없이 붙은 가중치 묶음(`abs -1.5::x::`)은 앞 단어와 떼어낸다 — 실제 카드에 흔하다.
 */
export function splitPromptTokens(prompt: string): string[] {
  const out: string[] = []
  let buf = ''
  let inWeight = false
  const flush = (): void => {
    if (buf.trim()) out.push(buf.trim())
    buf = ''
  }
  for (let i = 0; i < prompt.length; ) {
    if (!inWeight) {
      const m = /^-?\d*\.?\d+::/.exec(prompt.slice(i))
      if (m && !/[\w.]$/.test(buf)) {
        // 가중치 묶음이 새로 열린다 — 앞에 쉼표 없이 단어가 있었으면 따로 뗀다
        flush()
        buf = m[0]
        inWeight = true
        i += m[0].length
        continue
      }
    }
    if (prompt.startsWith('::', i)) {
      buf += '::'
      inWeight = !inWeight
      i += 2
      if (!inWeight) flush()
      continue
    }
    const ch = prompt[i]
    if (ch === ',' && !inWeight) flush()
    else if (ch === '\n' && !inWeight) flush()
    else buf += ch
    i++
  }
  flush()
  return out
}

/** 가중치 묶음이면 안쪽 태그들, 아니면 자기 자신 */
export function tokenTags(token: string): string[] {
  const m = /^-?\d*\.?\d+::([\s\S]*?)::$/.exec(token.trim())
  const inner = m ? m[1] : token
  return inner
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/_/g, ' '))
    .filter(Boolean)
}

const isNegative = (token: string): boolean => /^-\d*\.?\d+::/.test(token.trim())

export interface ClothingSplit {
  /** 카드에 남길 몸 태그 (원래 순서, 원래 표기 그대로) */
  body: string[]
  /** 복장 조각으로 옮길 옷 태그 — 태그 하나(또는 가중치 묶음 하나)가 조각 하나 */
  cloth: string[]
  /** 알몸·노출 태그 — 옷을 갈아입히면 빠져야 하므로 카드에서 뺀다 */
  bare: string[]
}

/**
 * 카드 태그를 몸 / 옷 / 알몸으로 나눈다.
 * 가중치 묶음은 안의 태그가 전부 옷일 때만 옷으로 보낸다 (섞여 있으면 카드에 남긴다 —
 * 묶음을 쪼개면 가중치가 바뀐다). 빼달라는 음수 가중치는 늘 카드에 남긴다.
 */
export function splitClothing(prompt: string, classify: (tag: string) => TagKind): ClothingSplit {
  const body: string[] = []
  const cloth: string[] = []
  const bare: string[] = []
  for (const token of splitPromptTokens(prompt)) {
    if (isNegative(token)) {
      body.push(token)
      continue
    }
    const kinds = tokenTags(token).map(classify)
    if (kinds.length && kinds.every((k) => k === 'cloth')) cloth.push(token)
    else if (kinds.length && kinds.every((k) => k === 'bare')) bare.push(token)
    else body.push(token)
  }
  return { body, cloth, bare }
}

/** 새 조각 id — 복장 안에서만 겹치지 않으면 된다 */
export function newPieceId(existing: { id: string }[]): string {
  let n = existing.length + 1
  const used = new Set(existing.map((p) => p.id))
  while (used.has(`p${n}`)) n++
  return `p${n}`
}
