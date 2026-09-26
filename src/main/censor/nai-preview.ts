import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import type { CensorOptions, CensorProgress } from '../../shared/censor'
import { previewDataUrl } from './apply'
import { analyzeFile, previewCensor } from './job'
import { censorWithNai, naiPreflight, type NaiCensorContext } from './nai'

/**
 * NAI로 1장 시험 (커스텀) — 실제로 인페인팅을 한 번 보내 결과만 보여준다(저장 안 함).
 * 무료 조건·잔액 감시는 일괄 작업과 같다. 화면에서 한 번 더 물어본 뒤에만 부른다.
 */
export async function previewWithNai(
  options: CensorOptions,
  file: string | undefined,
  ctx: NaiCensorContext,
  report: (patch: Partial<CensorProgress>) => void
): Promise<{
  file: string
  before: string
  after: string
  parts: import('../../shared/censor').CensorPart[]
  boxes: number
}> {
  // 탐지·영역은 로컬 미리보기와 같은 경로로 구한다
  const local = await previewCensor({ ...options, method: 'mosaic' }, file, report)
  if (!local.boxes) return local
  await naiPreflight(ctx)
  const dir = mkdtempSync(join(tmpdir(), 'nais3-censor-'))
  try {
    const out = join(dir, `preview${extname(local.file) || '.png'}`)
    const { regions, width, height } = await analyzeFile(options, local.file, report)
    report({ phase: 'work', message: 'NAI로 1장 그리는 중' })
    await censorWithNai(ctx, local.file, out, regions, options, width, height)
    return { ...local, after: await previewDataUrl(readFileSync(out)) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    report({ phase: 'idle', message: '' })
  }
}
