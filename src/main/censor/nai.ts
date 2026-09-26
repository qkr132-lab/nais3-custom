import { readFileSync } from 'node:fs'
import sharp from 'sharp'
import type { Box, CensorOptions } from '../../shared/censor'
import { modelCaps } from '../../shared/nai-models'
import { quotaState, type OpusUsage } from '../../shared/opus-usage'
import type { GenerationRequest } from '../../shared/types'
import { getNaiToken } from '../db/settings'
import { metadataFromImage } from '../images/metadata'
import { ensureQuotaAccount } from '../nai/account-switch'
import { fetchAnlasBalance, generateImageZip } from '../nai/client'
import type { GenerationQueue } from '../queue/generation-queue'
import { pasteNaiResult, writeAtomic } from './apply'

/**
 * NAI 인페인팅으로 검열 태그를 그리기 (커스텀, 시험 기능).
 *
 * Anlas를 아끼려고 겹겹이 막는다 (사용자 요청 "nai 토큰 아껴다오"):
 *  1) Opus 무료 조건(1024×1024 이하 화소, 64 배수, 28스텝 이하, 1장, 캐릭레퍼·바이브 없음)을
 *     벗어나는 그림은 보내지 않는다 — 실패 목록에 이유를 적는다
 *  2) V5 무료 한도가 '남아 있다'고 확인될 때만 보낸다 — 바닥났거나 알 수 없으면 멈춘다
 *  3) 요청마다 같은 토큰으로 전후 잔액을 읽어, 줄었으면 멈춘다. 요청이 실패해도(연결 끊김 등)
 *     잔액을 다시 읽어 줄었으면 멈춘다. 시작 때 잔액보다 줄어 있어도 멈춘다
 *  4) 생성 큐와 겹치지 않게 큐를 잠깐 잡아둔다 (지금 생성 중인 한 장이 끝나길 기다림)
 * 결과는 가린 영역(살짝 넓혀 부드럽게)만 원본에 붙여, 나머지 픽셀은 원본 그대로 둔다.
 */

export interface NaiCensorContext {
  queue: GenerationQueue
  /** 중단 — 대기·요청 중에도 멈춘다 */
  signal?: AbortSignal
  /** 시작 때 잔액 — 이보다 줄면 멈춘다 */
  startAnlas?: number
  /** 잔액·계정 바뀜을 화면에 알린다 (상단 잔액·한도 게이지) */
  onBalance?: (anlas: number, opusUsage: OpusUsage | null) => void
  onSwitch?: (label: string) => void
}

export class StopJob extends Error {
  stopJob = true
}

const FREE_PIXELS = 1048576
const MAX_STEPS = 28

interface Balance {
  anlas: number
  quota: ReturnType<typeof quotaState>
  usage: OpusUsage | null
}

/** 이 토큰의 잔액·구독·한도 — 요청을 보낸 계정 그대로 읽어야 비교가 맞다 */
async function readBalance(token: string): Promise<Balance> {
  const b = await fetchAnlasBalance(token)
  if (b.anlas === null) throw new StopJob('NAI 잔액을 확인하지 못해 멈췄습니다')
  if (b.tier !== 'opus') throw new StopJob('Opus 구독이 아니라 멈췄습니다 (무료 생성이 없습니다)')
  return { anlas: b.anlas, quota: quotaState(b.opusUsage), usage: b.opusUsage }
}

function requireQuota(b: Balance): void {
  if (b.quota === 'exhausted') throw new StopJob('V5 무료 한도가 바닥나 멈췄습니다')
  if (b.quota !== 'available')
    throw new StopJob(
      'V5 무료 한도를 확인할 수 없어 멈췄습니다 (한도 게이지가 0%이면 기다렸다 다시)'
    )
}

function requireToken(): string {
  const token = getNaiToken()
  if (!token) throw new StopJob('NAI 토큰이 설정되지 않았습니다')
  return token
}

/** 시작 전 확인 — 토큰·Opus·한도, 그리고 기준 잔액 기록 */
export async function naiPreflight(ctx: NaiCensorContext): Promise<void> {
  const b = await readBalance(requireToken())
  requireQuota(b)
  ctx.startAnlas = b.anlas
}

/** 이 그림을 무료로 보낼 수 있는지 — 안 되면 이유 */
export function freeProblem(width: number, height: number): string | null {
  if (width * height > FREE_PIXELS) return `무료 조건보다 큽니다 (${width}×${height})`
  if (width % 64 || height % 64) return `NAI 해상도(64 배수)가 아닙니다 (${width}×${height})`
  return null
}

/** 가린 영역을 8px 블록에 맞춘 흑백 마스크 (흰색 = 다시 그림) */
async function maskPng(regions: Box[], width: number, height: number): Promise<Buffer> {
  const rgb = Buffer.alloc(width * height * 3)
  for (const r of regions) {
    const x0 = Math.max(0, Math.floor(r.x0 / 8) * 8)
    const y0 = Math.max(0, Math.floor(r.y0 / 8) * 8)
    const x1 = Math.min(width, Math.ceil(r.x1 / 8) * 8)
    const y1 = Math.min(height, Math.ceil(r.y1 / 8) * 8)
    for (let y = y0; y < y1; y++) rgb.fill(255, (y * width + x0) * 3, (y * width + x1) * 3)
  }
  return sharp(rgb, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer()
}

const CENSOR_NEGATIVE = 'uncensored, pointless censoring, transparent censoring'

/** 그림의 NAI 메타데이터로 인페인팅 요청을 만든다 — 없으면 검열 태그만 */
async function buildRequest(
  file: string,
  width: number,
  height: number,
  options: CensorOptions
): Promise<GenerationRequest> {
  const meta = await metadataFromImage(readFileSync(file))
  const tag = `1.3::${options.naiTag}::, censored`
  const base = 'nai-diffusion-5-full'
  return {
    prompt: meta?.prompt ? `${meta.prompt}, ${tag}` : tag,
    negativePrompt: meta?.negativePrompt
      ? `${meta.negativePrompt}, ${CENSOR_NEGATIVE}`
      : CENSOR_NEGATIVE,
    model: modelCaps(base).inpaintModel,
    width,
    height,
    steps: Math.min(MAX_STEPS, meta?.steps ?? 23),
    cfgScale: meta?.cfgScale ?? 5,
    cfgRescale: meta?.cfgRescale ?? 0,
    sampler: meta?.sampler ?? 'k_euler_ancestral',
    noiseSchedule: meta?.noiseSchedule ?? 'karras',
    seed: Math.floor(Math.random() * 2 ** 32),
    variety: false,
    // 메타데이터의 프롬프트·네거티브엔 품질 태그·UC 프리셋이 이미 합쳐져 있다 — 다시 붙이지 않는다
    qualityToggle: false,
    ucPreset: 4,
    characterPrompts: (meta?.characterPrompts ?? []).map((c) => ({
      prompt: c.prompt,
      negativePrompt: c.negativePrompt,
      center: c.center,
      enabled: true
    })),
    useCoords: !!meta?.useCoords,
    vibeIds: [],
    charRefIds: []
  }
}

/** NAI에 한 번 보내고 잔액을 확인한다 — 큐를 잡아둔 채로 */
async function inpaintOnce(
  ctx: NaiCensorContext,
  request: GenerationRequest,
  image: Buffer,
  mask: Buffer
): Promise<Buffer> {
  return ctx.queue.exclusive(async () => {
    if (ctx.signal?.aborted) throw new StopJob('중단했습니다')
    const swap = await ensureQuotaAccount(request.model)
    if (swap.allExhausted) throw new StopJob('모든 계정의 V5 무료 한도가 바닥나 멈췄습니다')
    if (swap.switched) ctx.onSwitch?.(swap.label ?? '')
    const token = requireToken()
    const before = await readBalance(token)
    requireQuota(before)
    if (ctx.startAnlas != null && before.anlas < ctx.startAnlas) {
      throw new StopJob(`작업 중 Anlas가 ${ctx.startAnlas - before.anlas} 줄어 멈췄습니다`)
    }
    let png: Buffer
    try {
      png = (
        await generateImageZip(
          token,
          request,
          {
            imageFormat: 'png',
            i2i: {
              strength: 1,
              noise: 0,
              extraNoiseSeed: Math.max(0, request.seed - 1),
              colorCorrect: false,
              imageBase64: image.toString('base64'),
              maskBase64: mask.toString('base64')
            }
          },
          ctx.signal
        )
      ).png
    } catch (e) {
      // 실패해도 서버가 처리(과금)했을 수 있다 — 잔액이 줄었으면 멈춘다
      const after = await readBalance(token).catch(() => null)
      if (after) ctx.onBalance?.(after.anlas, after.usage)
      if (after && after.anlas < before.anlas) {
        throw new StopJob(`요청은 실패했지만 Anlas가 ${before.anlas - after.anlas} 줄어 멈췄습니다`)
      }
      if (ctx.signal?.aborted) throw new StopJob('중단했습니다')
      throw e
    }
    const after = await readBalance(token)
    ctx.onBalance?.(after.anlas, after.usage)
    if (after.anlas < before.anlas) {
      throw new StopJob(
        `Anlas가 ${before.anlas - after.anlas} 줄어 멈췄습니다 — 무료로 처리되지 않았습니다`
      )
    }
    return png
  }, ctx.signal)
}

/** 한 장 — 무료 조건 확인 → 인페인팅 → 잔액 확인 → 원본에 붙여 저장 */
export async function censorWithNai(
  ctx: NaiCensorContext,
  file: string,
  dest: string,
  regions: Box[],
  options: CensorOptions,
  width: number,
  height: number
): Promise<void> {
  const problem = freeProblem(width, height)
  if (problem) throw new Error(problem)
  const request = await buildRequest(file, width, height, options)
  const image = await sharp(file, { failOn: 'none' }).removeAlpha().png().toBuffer()
  const mask = await maskPng(regions, width, height)
  const png = await inpaintOnce(ctx, request, image, mask)
  // 가린 영역만 NAI 결과로 — 나머지는 원본 픽셀·메타데이터 그대로
  writeAtomic(dest, await pasteNaiResult(file, png, regions))
}
