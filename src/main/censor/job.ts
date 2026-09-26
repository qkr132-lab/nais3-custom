import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import {
  censorRegions,
  combineDetections,
  mosaicBlockSize,
  thresholdsFor,
  type CensorFileResult,
  type CensorOptions,
  type CensorPart,
  type CensorProgress,
  type Detection
} from '../../shared/censor'
import { previewDataUrl, renderCensored, writeCensored } from './apply'
import { Detector, runtimeProblem } from './detector'
import { askGemma, defaultGemmaDir, findGemma, startGemma, type GemmaSetup } from './gemma'
import { BUILTIN_MODELS, builtinPath, downloadModel, isInstalled } from './models'
import { censorWithNai, naiPreflight, type NaiCensorContext } from './nai'

/**
 * 폴더 자동 검열 (커스텀). 원본은 건드리지 않고 저장 폴더에 같은 구조로 쓴다.
 * 한 번에 하나만 돈다. 진행은 onProgress로 알린다.
 */

const IMAGE_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg'])

export const idleProgress = (): CensorProgress => ({
  running: false,
  phase: 'idle',
  done: 0,
  total: 0,
  censored: 0,
  clean: 0,
  skipped: 0,
  failed: 0,
  current: '',
  outputFolder: '',
  message: ''
})

let progress: CensorProgress = idleProgress()
let abort: AbortController | null = null
let lastResults: CensorFileResult[] = []

export function censorStatus(): CensorProgress {
  return progress
}

export function censorResults(): CensorFileResult[] {
  return lastResults
}

/** 중단 — 파일 사이는 물론, NAI 대기·요청 중에도 멈춘다 */
export function cancelCensor(): void {
  if (progress.running) abort?.abort()
}

/** 실제 경로 (정션·대소문자까지 풀어서) — 아직 없는 폴더는 있는 조상까지 풀고 나머지를 붙인다 */
function realPath(path: string): string {
  let head = resolve(path)
  const tail: string[] = []
  while (!existsSync(head)) {
    const parent = dirname(head)
    if (parent === head) break
    tail.unshift(basename(head))
    head = parent
  }
  let real = head
  try {
    real = realpathSync.native(head)
  } catch {
    // 못 풀면 그대로
  }
  const full = join(real, ...tail)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

const inside = (parent: string, child: string): boolean => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !/^[a-z]:/i.test(rel))
}

/** 시작 전 검사 — 화면에 바로 알려야 하는 잘못(폴더 없음·같은 폴더·이미 도는 중) */
export function validateStart(options: CensorOptions): void {
  if (progress.running) throw new Error('이미 검열 중입니다')
  if (!options.folder || !existsSync(options.folder)) throw new Error('원본 폴더를 고르세요')
  if (!options.parts.length) throw new Error('가릴 부위를 하나 이상 고르세요')
  const src = realPath(options.folder)
  const out = realPath(outputFolderFor(options))
  // 원본을 덮어쓰지 않게 — 같은 폴더거나, 저장 폴더가 원본을 품으면(원본 옆 파일을 덮을 수 있음) 막는다.
  // 원본 안에 저장 폴더를 두는 것은 괜찮다 (읽을 때 건너뛴다)
  if (inside(out, src)) throw new Error('저장 폴더가 원본 폴더와 같거나 원본을 품고 있습니다')
}

export function outputFolderFor(options: CensorOptions): string {
  if (options.outputFolder.trim()) return resolve(options.outputFolder.trim())
  const src = resolve(options.folder)
  return join(dirname(src), `${basename(src)}_검열`)
}

/** 폴더 안 이미지 (저장 폴더는 빼고) — 상대 경로 순으로 */
export function listImages(folder: string, recursive: boolean, exclude: string): string[] {
  const out: string[] = []
  const skip = resolve(exclude)
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (recursive && resolve(full) !== skip) walk(full)
      } else if (entry.isFile() && IMAGE_EXT.has(extname(entry.name).toLowerCase())) out.push(full)
    }
  }
  walk(folder)
  return out.sort((a, b) => a.localeCompare(b))
}

interface Detectors {
  primary: Detector
  extra: Detector | null
  gemma: GemmaSetup | null
}

async function prepare(
  options: CensorOptions,
  report: (patch: Partial<CensorProgress>) => void
): Promise<Detectors> {
  const problem = await runtimeProblem()
  if (problem) throw new Error(problem)
  // Gemma를 먼저 — 못 켜면 탐지기 세션을 열었다 버리지 않게
  let gemma: GemmaSetup | null = null
  if (options.gemma) {
    gemma = findGemma(defaultGemmaDir())
    if (!gemma)
      throw new Error(
        `Gemma를 찾지 못했습니다 — ${defaultGemmaDir()} 에 llama-server와 GGUF를 두세요`
      )
    report({ phase: 'gemma', message: '처음엔 1분쯤 걸립니다' })
    await startGemma(gemma)
  }
  const wanted = BUILTIN_MODELS.filter((_, i) => i === 0 || options.extraModel)
  for (const model of wanted) {
    if (isInstalled(model)) continue
    report({ phase: 'model', message: model.name, download: 0 })
    await downloadModel(model, (got, total) => report({ download: total ? got / total : 0 }))
  }
  report({ download: undefined })
  const [primaryModel, extraModel] = wanted
  const primary = await Detector.open(builtinPath(primaryModel.id), primaryModel)
  try {
    const extra = extraModel ? await Detector.open(builtinPath(extraModel.id), extraModel) : null
    return { primary, extra, gemma }
  } catch (e) {
    await primary.close()
    throw e
  }
}

/** Gemma에 묻기 — 서버가 꺼져 있으면(오래 쉬어 자동으로 꺼짐 등) 한 번 다시 켜고 묻는다 */
async function askGemmaSafely(
  setup: GemmaSetup,
  file: string,
  width: number,
  height: number
): Promise<Awaited<ReturnType<typeof askGemma>>> {
  try {
    return await askGemma(file, width, height)
  } catch {
    await startGemma(setup)
    return askGemma(file, width, height)
  }
}

/** 한 장 탐지 → 합치기 → 가릴 영역 */
async function analyze(
  file: string,
  det: Detectors,
  options: CensorOptions
): Promise<{
  width: number
  height: number
  accepted: Detection[]
  regions: ReturnType<typeof censorRegions>
  block: number
}> {
  const th = thresholdsFor(options.sensitivity)
  const primary = await det.primary.detect(file, th.confirm)
  const extra = det.extra ? (await det.extra.detect(file, th.confirm)).detections : []
  const { width, height } = primary
  const gemma = det.gemma ? await askGemmaSafely(det.gemma, file, width, height) : null
  const { accepted } = combineDetections({
    primary: primary.detections,
    extra,
    gemma,
    thresholds: th
  })
  const parts = new Set(options.parts)
  const block = mosaicBlockSize(width, height, options.mosaicScale)
  const regions = censorRegions(accepted, {
    parts,
    expandScale: options.expandScale,
    width,
    height,
    block
  })
  return {
    width,
    height,
    accepted: accepted.filter((d) => parts.has(d.part)),
    regions,
    block
  }
}

/** 한 장 분석 — 탐지기를 열고 닫는다 (미리보기·NAI 시험용) */
export async function analyzeFile(
  options: CensorOptions,
  file: string,
  report: (patch: Partial<CensorProgress>) => void
): Promise<Awaited<ReturnType<typeof analyze>>> {
  const det = await prepare(options, report)
  try {
    return await analyze(file, det, options)
  } finally {
    await det.primary.close()
    await det.extra?.close()
  }
}

export interface CensorPreview {
  file: string
  before: string
  after: string
  parts: CensorPart[]
  boxes: number
}

/** 한 장 미리보기 — 저장하지 않는다. file을 안 주면 폴더의 첫 그림 */
export async function previewCensor(
  options: CensorOptions,
  file: string | undefined,
  report: (patch: Partial<CensorProgress>) => void
): Promise<CensorPreview> {
  const target = file ?? listImages(options.folder, options.recursive, outputFolderFor(options))[0]
  if (!target) throw new Error('폴더에 그림이 없습니다')
  try {
    const a = await analyzeFile(options, target, report)
    const paint = options.method === 'nai' ? 'mosaic' : options.method
    const rendered = await renderCensored(target, a.regions, paint, a.block)
    return {
      file: target,
      before: await previewDataUrl(target),
      after: await previewDataUrl(rendered),
      parts: [...new Set(a.accepted.map((d) => d.part))],
      boxes: a.regions.length
    }
  } finally {
    report({ phase: 'idle', message: '' })
  }
}

/** 폴더 일괄 검열 */
export async function runCensor(
  options: CensorOptions,
  onProgress: (p: CensorProgress) => void,
  nai?: NaiCensorContext
): Promise<void> {
  validateStart(options)
  const out = outputFolderFor(options)
  const controller = new AbortController()
  abort = controller
  if (nai) nai.signal = controller.signal
  lastResults = []
  progress = { ...idleProgress(), running: true, phase: 'scan', outputFolder: out }
  let lastSent = 0
  const report = (patch: Partial<CensorProgress>, force = false): void => {
    progress = { ...progress, ...patch }
    const now = Date.now()
    if (force || now - lastSent > 120) {
      lastSent = now
      onProgress(progress)
    }
  }
  report({}, true)

  let det: Detectors | null = null
  try {
    det = await prepare(options, (p) => report(p, true))
    const files = listImages(options.folder, options.recursive, out)
    report({ phase: 'work', total: files.length, message: '' }, true)
    if (options.method === 'nai') {
      if (!nai) throw new Error('NAI 검열을 준비하지 못했습니다')
      await naiPreflight(nai)
    }
    for (const file of files) {
      if (controller.signal.aborted) break
      const rel = relative(options.folder, file)
      const dest = join(out, rel)
      report({ current: rel })
      const result: CensorFileResult = { file: rel, status: 'clean', parts: [] }
      try {
        if (existsSync(dest) && !options.overwrite) {
          result.status = 'skipped'
        } else {
          mkdirSync(dirname(dest), { recursive: true })
          const a = await analyze(file, det, options)
          result.parts = [...new Set(a.accepted.map((d) => d.part))]
          if (!a.regions.length) {
            if (options.copyClean) copyFileSync(file, dest)
          } else if (options.method === 'nai') {
            await censorWithNai(nai!, file, dest, a.regions, options, a.width, a.height)
            result.status = 'censored'
          } else {
            await writeCensored(file, dest, a.regions, options.method, a.block)
            result.status = 'censored'
          }
        }
      } catch (e) {
        // 중단 버튼으로 끊긴 것은 실패로 세지 않는다
        if (controller.signal.aborted) break
        result.status = 'failed'
        result.error = e instanceof Error ? e.message : String(e)
        // NAI가 막히면(Anlas 차감 감지·한도 소진) 더 돌리지 않는다
        if ((e as { stopJob?: boolean }).stopJob) {
          lastResults.push(result)
          throw e
        }
      }
      lastResults.push(result)
      report({
        done: progress.done + 1,
        censored: progress.censored + (result.status === 'censored' ? 1 : 0),
        clean: progress.clean + (result.status === 'clean' ? 1 : 0),
        skipped: progress.skipped + (result.status === 'skipped' ? 1 : 0),
        failed: progress.failed + (result.status === 'failed' ? 1 : 0)
      })
    }
    if (existsSync(out)) writeReport(out, options)
    report(
      {
        running: false,
        phase: controller.signal.aborted ? 'cancelled' : 'done',
        current: '',
        message: ''
      },
      true
    )
  } catch (e) {
    if (existsSync(out)) writeReport(out, options)
    report(
      {
        running: false,
        phase: 'error',
        current: '',
        message: e instanceof Error ? e.message : String(e)
      },
      true
    )
  } finally {
    await det?.primary.close()
    await det?.extra?.close()
    if (abort === controller) abort = null
  }
}

const PART_KO: Record<CensorPart, string> = {
  vulva: '여성 성기',
  penis: '남성 성기',
  testicles: '고환',
  anus: '항문',
  nipples: '유두'
}

/** 저장 폴더에 결과 목록 — 실패한 그림과 이유 */
function writeReport(out: string, options: CensorOptions): void {
  const failed = lastResults.filter((r) => r.status === 'failed')
  const lines = [
    `자동 검열 결과 — ${new Date().toLocaleString('ko-KR')}`,
    `원본 폴더: ${basename(resolve(options.folder))}`,
    `방식: ${options.method} · 부위: ${options.parts.map((p) => PART_KO[p]).join(', ')}`,
    `검열 ${lastResults.filter((r) => r.status === 'censored').length} · 탐지 없음 ${lastResults.filter((r) => r.status === 'clean').length} · 건너뜀 ${lastResults.filter((r) => r.status === 'skipped').length} · 실패 ${failed.length}`,
    '',
    '[실패]',
    ...(failed.length ? failed.map((r) => `${r.file}\t${r.error ?? ''}`) : ['없음'])
  ]
  try {
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, '_검열결과.txt'), lines.join('\r\n'), 'utf-8')
  } catch {
    // 결과 파일을 못 써도 검열 자체는 끝났다
  }
}
