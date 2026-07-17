import { describe, expect, it } from 'vitest'
import { isNewerVersion, releaseVersion } from '../src/main/update-release'

describe('update release version comparison', () => {
  it('compares stable versions', () => {
    expect(isNewerVersion('1.6.0', '1.5.9')).toBe(true)
    expect(isNewerVersion('1.5.9', '1.6.0')).toBe(false)
  })

  it('compares experimental versions numerically', () => {
    expect(isNewerVersion('1.6.0-exp.12', '1.6.0-exp.11')).toBe(true)
    expect(isNewerVersion('1.6.0-exp.9', '1.6.0-exp.11')).toBe(false)
  })

  it('treats a stable release as newer than its prerelease', () => {
    expect(isNewerVersion('1.6.0', '1.6.0-exp.11')).toBe(true)
    expect(isNewerVersion('1.6.0-exp.11', '1.6.0')).toBe(false)
  })

  it('normalizes a GitHub v-prefixed tag', () => {
    expect(releaseVersion({ tag_name: 'v1.6.0-exp.12' })).toBe('1.6.0-exp.12')
    expect(releaseVersion({ tag_name: 'not-a-version' })).toBeNull()
  })
})
