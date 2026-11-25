import { app, shell } from 'electron'
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_CARD_FIT_RULES } from '../shared/card-fit-default'

/**
 * 카드 태그 씬 맞춤 규칙표 파일 (커스텀) — %APPDATA%\NAIS3 Custom\card-fit-rules.json.
 * 사용자가 메모장으로 고치는 파일이라 앱은 글 그대로 읽어 렌더러에 넘기고, 해석·적용은 렌더러(shared/card-fit)가 한다.
 * 파일이 없으면 기본 규칙표로 만든다 (지운 뒤 다시 켜면 기본으로 돌아온다).
 */

const FILE = 'card-fit-rules.json'

export const cardFitPath = (): string => join(app.getPath('userData'), FILE)

const defaultText = (): string => JSON.stringify(DEFAULT_CARD_FIT_RULES, null, 2) + '\n'

export function readCardFitFile(): {
  path: string
  text: string
  created: boolean
  error?: string
} {
  const path = cardFitPath()
  let created = false
  try {
    if (!existsSync(path)) {
      writeFileSync(path, defaultText(), 'utf8')
      created = true
    }
    return { path, text: readFileSync(path, 'utf8'), created }
  } catch (e) {
    return { path, text: '', created, error: `규칙표 파일을 읽지 못함 — ${(e as Error).message}` }
  }
}

export function openCardFitFile(): void {
  const { path, error } = readCardFitFile()
  if (!error) void shell.openPath(path)
}

/** 기본 규칙표로 되돌린다 — 지금 파일은 옆에 시각을 붙여 남긴다 */
export function resetCardFitFile(): {
  path: string
  text: string
  created: boolean
  backup?: string
  error?: string
} {
  const path = cardFitPath()
  let backup: string | undefined
  try {
    if (existsSync(path)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      backup = join(app.getPath('userData'), `card-fit-rules.bak-${stamp}.json`)
      copyFileSync(path, backup)
    }
    writeFileSync(path, defaultText(), 'utf8')
    return { path, text: readFileSync(path, 'utf8'), created: true, ...(backup ? { backup } : {}) }
  } catch (e) {
    return {
      path,
      text: '',
      created: false,
      ...(backup ? { backup } : {}),
      error: `기본 규칙표로 되돌리지 못함 — ${(e as Error).message}`
    }
  }
}
