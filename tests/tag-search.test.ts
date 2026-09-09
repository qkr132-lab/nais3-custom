import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import type * as TagApi from '../src/main/tags'

const state = vi.hoisted(() => ({ settings: new Map<string, string>() }))
vi.mock('electron', () => ({ app: { getAppPath: () => resolve('.') } }))
vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => state.settings.get(key) ?? null,
  setSetting: (key: string, value: string) => state.settings.set(key, value)
}))
vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/sqlite-for-node')).TestDatabase
}))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  const { TagSearchEngine } = await import('../src/main/tag-search-engine')
  return {
    Worker: class extends EventEmitter {
      engine: InstanceType<typeof TagSearchEngine>
      constructor(_path: string, options: { workerData: { path: string } }) {
        super()
        this.engine = new TagSearchEngine(options.workerData.path)
      }
      unref(): void {}
      terminate(): Promise<number> {
        this.engine.close()
        return Promise.resolve(0)
      }
      postMessage(message): void {
        setTimeout(() => {
          try {
            if (message.personal) this.engine.setPersonal(message.personal)
            this.emit('message', {
              id: message.id,
              result: this.engine[message.method](...message.args)
            })
          } catch (error) {
            this.emit('message', { id: message.id, error: String(error) })
          }
        }, 0)
      }
    }
  }
})
let api: typeof TagApi
beforeAll(async () => {
  api = await import('../src/main/tags')
})
afterAll(() => api.shutdownTagSearch())

describe('shipped million-tag index and Korean search API', () => {
  it.each([
    ['카메하메하', 'kamehameha (dragon ball)'],
    ['에너르기파', 'kamehameha (dragon ball)'],
    ['에네르기파', 'kamehameha (dragon ball)'],
    ['카메하', 'kamehameha (dragon ball)'],
    ['ㅈ', 'full body'],
    ['ㅈㅅ', 'full body'],
    ['전ㅅ', 'full body'],
    ['전신'.normalize('NFD'), 'full body'],
    ['풀바디', 'full body'],
    ['에너지 구체', 'energy ball'],
    ['장풍', 'hadouken'],
    ['나선환', 'rasengan'],
    ['웃는', 'smile'],
    ['화가 난', 'angry'],
    ['청색 눈동자', 'blue eyes'],
    ['핑크머리', 'pink hair'],
    ['트윈테잉', 'twintails'],
    ['ㅌㅇㅌㅇ', 'twintails'],
    ['미드리프', 'midriff'],
    ['blue eyes', 'blue eyes'],
    ['blue_eyes', 'blue eyes'],
    ['위에서 내려다보는', 'from above'],
    ['달리고 있는', 'running'],
    ['검을 든', 'holding sword'],
    ['빛의 날개', 'energy wings'],
    ['검은색 재킷', 'black jacket'],
    ['장발', 'long hair'],
    ['흑발', 'black hair'],
    ['카메라를 보는', 'looking at viewer'],
    ['허리 위', 'upper body'],
    ['옆으로 누운', 'on side'],
    ['우주', 'space'],
    ['눈 감은', 'closed eyes'],
    ['손오공', 'son goku'],
    ['하츠네 미쿠', 'hatsune miku']
  ])('%s finds %s among the first ten', async (query, tag) => {
    expect((await api.searchTags(query, 10)).map((t) => t.tag)).toContain(tag)
  })
  it.each([
    ['카메하메하', 'kamehameha (dragon ball)'],
    ['에너르기파', 'kamehameha (dragon ball)'],
    ['전신', 'full body'],
    ['청색 눈동자', 'blue eyes'],
    ['파동권', 'hadouken'],
    ['energy beam', 'energy beam']
  ])('exact meaning %s is ranked first', async (query, tag) => {
    expect((await api.searchTags(query))[0].tag).toBe(tag)
  })
  it('does not introduce unrelated guesses for short Korean or nonsense queries', async () => {
    expect((await api.searchTags('눈')).some((r) => r.match === 'phonetic')).toBe(false)
    expect(await api.searchTags('없는말카쟈뤼푸뿡')).toEqual([])
  })
  it('offers explicit semantic neighbors after the exact technique, without changing its meaning', async () => {
    const result = await api.searchTags('카메하메하')
    expect(result[0].tag).toBe('kamehameha (dragon ball)')
    expect(result.find((r) => r.tag === 'energy beam')?.match).toBe('related')
    expect((await api.searchTags('마법')).map((r) => r.tag)).toContain('magic circle')
    expect((await api.searchTags('겨울 옷')).map((r) => r.tag)).toContain('coat')
  })
  it('does not confuse a blue eye query with other eye colors', async () => {
    const tags = (await api.searchTags('청색 눈동자')).map((r) => r.tag)
    expect(tags).toContain('blue eyes')
    expect(tags).not.toContain('red eyes')
    expect(tags).not.toContain('pink eyes')
  })
  it('custom synonyms invalidate cached results without rebuilding the dictionary', async () => {
    await api.searchTags('조용한행운')
    api.setUserTagKo('smile', '조용한행운, 살짝웃기')
    expect((await api.searchTags('조용한행운'))[0]).toMatchObject({
      tag: 'smile',
      userKo: true,
      match: 'exact'
    })
    expect((await api.searchTags('살짝웃기'))[0].tag).toBe('smile')
    api.setUserTagKo('smile', '')
    expect((await api.searchTags('조용한행운')).some((r) => r.userKo)).toBe(false)
  })
  it('records accepted known tags and blends history after matching tags', async () => {
    await api.recordTagUse('smile')
    await api.recordTagUse('smile')
    await api.recordTagUse('blue eyes')
    await api.recordTagUse('made up nonexistent local tag')
    expect((await api.historyTags('frequent'))[0]).toMatchObject({ tag: 'smile', usageCount: 2 })
    expect((await api.historyTags('recent'))[0].tag).toBe('blue eyes')
    expect(JSON.parse(state.settings.get('tag_usage_v1')!)).toHaveProperty('smile.count', 2)
    const results = await api.recommendTags('전신')
    expect(results[0].tag).toBe('full body')
    expect(results.some((r) => r.match === 'history')).toBe(true)
    api.clearTagUsage()
    expect(await api.historyTags('recent')).toEqual([])
  })
  it('returns bounded, unique real tags and isolated result objects', async () => {
    const tags = await api.searchTags('머리', 999)
    expect(tags.length).toBeLessThanOrEqual(30)
    expect(new Set(tags.map((r) => r.tag)).size).toBe(tags.length)
    const first = await api.searchTags('전신')
    first[0].ko = 'mutated'
    expect((await api.searchTags('전신'))[0].ko).toBe('전신')
    expect(await api.searchTags('')).toEqual([])
  })
  it('settles superseded requests and searches the final input', async () => {
    const jobs = ['에', '에너', '에너르', '에너르기', '에너르기파'].map((q) => api.searchTags(q))
    const results = await Promise.all(jobs)
    expect(results.at(-1)![0].tag).toBe('kamehameha (dragon ball)')
  })
  it('restores personal meanings and history after restart', async () => {
    await api.recordTagUse('smile')
    api.setUserTagKo('smile', '개인별칭검증, 나만의웃음')
    api.shutdownTagSearch()
    vi.resetModules()
    api = await import('../src/main/tags')
    expect((await api.historyTags('recent'))[0]).toMatchObject({ tag: 'smile', usageCount: 1 })
    expect((await api.searchTags('개인별칭검증'))[0]).toMatchObject({ tag: 'smile', userKo: true })
    api.clearTagUsage()
    api.setUserTagKo('smile', '')
  })
})
