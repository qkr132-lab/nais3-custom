export interface GitHubReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

export interface GitHubRelease {
  tag_name?: string
  assets?: GitHubReleaseAsset[]
}

interface ParsedVersion {
  core: number[]
  prerelease: Array<number | string>
}

function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/i, '').split('+', 1)[0]
  const [coreText, prereleaseText] = normalized.split('-', 2)
  const coreParts = coreText.split('.')
  if (
    coreParts.length < 1 ||
    coreParts.length > 3 ||
    coreParts.some((part) => !/^\d+$/.test(part))
  ) {
    return null
  }

  const core = coreParts.map(Number)
  while (core.length < 3) core.push(0)
  const prerelease = prereleaseText
    ? prereleaseText.split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
    : []
  return { core, prerelease }
}

/** SemVer 순서로 candidate가 current보다 새 버전인지 비교한다. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  if (!a || !b) return false

  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i]
  }

  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === 0 && b.prerelease.length > 0
  }

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let i = 0; i < length; i++) {
    const av = a.prerelease[i]
    const bv = b.prerelease[i]
    if (av === undefined || bv === undefined) return av !== undefined
    if (av === bv) continue
    if (typeof av === 'number' && typeof bv === 'number') return av > bv
    if (typeof av === 'number') return false
    if (typeof bv === 'number') return true
    return av.localeCompare(bv) > 0
  }
  return false
}

export function releaseVersion(release: GitHubRelease): string | null {
  const version = String(release.tag_name ?? '')
    .trim()
    .replace(/^v/i, '')
  return parseVersion(version) ? version : null
}
