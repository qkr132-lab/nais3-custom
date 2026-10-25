import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { CharacterCard, ExposeNote, IpcInvokeMap, Scene } from '../../src/shared/types'
import type { Outfit, OutfitChoice } from '../../src/shared/outfit'
import { ExposeBlock } from '../../src/renderer/src/components/expose-notes'
import { MainExposeBlock } from '../../src/renderer/src/components/main-expose-block'
import { OutfitMode } from '../../src/renderer/src/components/outfit-mode'
import { OutfitPicker } from '../../src/renderer/src/components/outfit-picker'
import { SceneDetail } from '../../src/renderer/src/components/scene-detail'
import { AdditionDialog } from '../../src/renderer/src/components/scene-extras-dialogs'
import { ScenePlacementDialog } from '../../src/renderer/src/components/scene-placement-dialog'
import { SettingsDialog } from '../../src/renderer/src/components/token-dialog'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { DEFAULT_REQUEST, useGenerationStore } from '../../src/renderer/src/stores/generation-store'
import { useCharactersStore } from '../../src/renderer/src/stores/characters-store'
import { useOutfitsStore } from '../../src/renderer/src/stores/outfits-store'
import { useSceneExtrasStore } from '../../src/renderer/src/stores/scene-extras-store'
import { useScenesStore } from '../../src/renderer/src/stores/scenes-store'
import { useCharRefsStore, useVibesStore } from '../../src/renderer/src/stores/refs-store'
import { tokenFixtureInvoke } from './token-fixture'
import './placement.css'

/**
 * 입은 옷 자동 젖힘 화면 검증 하네스 — 실제 컴포넌트를 합성 카드·합성 문장으로 그린다.
 * window.nais 는 메모리 가짜이고 NAI·파일·DB 호출은 막혀 있다. 사용자 데이터는 들어 있지 않다.
 *
 * 주소 인자
 *   ?mode=block      접이식 「자동 젖힘」 블록에 상태 13가지를 전부 넣은 합성 메모 (기본)
 *   ?mode=detail     실제 SceneDetail (계산은 핵심 모듈이 하므로 실제 메모가 나온다)
 *   ?mode=placement  실제 배치 창 + 합성 메모 (캐릭터 줄 「자동 +N」·호버, 복장 선택)
 *   ?mode=addition   실제 씬별 추가 창 → 넓게 배치 (배치 창 배지는 실제 계산 결과)
 *   ?mode=picker     실제 복장 선택 (카드에 직접 적은 옷 / 복장 있음)
 *   ?mode=outfit     실제 복장 탭 (카드 글에서 읽은 옷 구역)
 *   ?mode=settings   실제 설정 창 (생성 탭의 「입은 옷 자동 젖힘」 스위치)
 *   &enabled=0       설정 「입은 옷 자동 젖힘」 꺼짐
 *   &empty=1         (block) 메모 없음
 *   &rounds=2        (block) 큐 반복 2회차 — 서로 다른 결과
 *   &open=1          (block·detail) 블록을 펴 둔 채로
 *   &notes=0         (picker) 씬을 모르는 상태 (메모 없음)
 *   &card=1|3        (picker) 1 = 복장 없는 카드, 3 = 복장 있는 카드
 */

const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'block'
const enabled = params.get('enabled') !== '0'

try {
  if (params.get('open') === '1') localStorage.setItem('scene_expose_open', '1')
  else if (params.has('open')) localStorage.removeItem('scene_expose_open')
} catch {
  // 저장소가 막힌 환경에서는 접힌 채로 시작한다
}

const card = (
  patch: Partial<CharacterCard> & Pick<CharacterCard, 'id' | 'name'>
): CharacterCard => ({
  prompt: '',
  negativePrompt: '',
  thumbnail: '',
  enabled: true,
  center: { x: 0.5, y: 0.5 },
  slotNo: null,
  folderId: null,
  charRefId: null,
  role: null,
  partnerTags: '',
  outfitId: null,
  ...patch
})

// 합성 카드 — 이름도 태그도 가짜다
const cards: CharacterCard[] = [
  card({
    id: 1,
    name: '합성 카드 A',
    prompt: '1girl, adult, long hair, skirt, shirt, bra',
    role: 'target'
  }),
  card({ id: 2, name: '합성 카드 B', prompt: '1boy, adult, short hair, pants', role: 'source' }),
  card({
    id: 3,
    name: '합성 카드 C',
    prompt: '1girl, adult, ponytail',
    outfitId: 1,
    role: 'target'
  }),
  card({ id: 4, name: '합성 카드 D', prompt: '1girl, adult, short hair, smile' })
]

const outfits: Outfit[] = [
  {
    id: 1,
    name: '합성 원피스',
    negative: '',
    pieces: [
      { id: 'p1', name: '원피스', tags: 'red dress', on: true },
      { id: 'p2', name: '젖히기(아래)', tags: 'dress lift', on: false, when: 'nsfw-lower' }
    ]
  },
  {
    id: 2,
    name: '합성 수영복',
    negative: '',
    pieces: [{ id: 'p1', name: '비키니', tags: 'bikini', on: true }]
  }
]

const note = (
  n: Partial<ExposeNote> & Pick<ExposeNote, 'charIndex' | 'area' | 'status'>
): ExposeNote => ({
  charId: null,
  name: '',
  tags: [],
  garments: [],
  evidence: [],
  reason: '',
  ...n
})

/** 상태 13가지를 한 번씩 이상 보이는 합성 메모 */
function allStatusNotes(): ExposeNote[] {
  const A = { charIndex: 0, charId: 1, name: '합성 카드 A' }
  const B = { charIndex: 1, charId: 2, name: '합성 카드 B' }
  const C = { charIndex: 2, charId: 3, name: '합성 카드 C' }
  const D = { charIndex: 3, charId: 4, name: '합성 카드 D' }
  const E = { charIndex: 4, charId: null, name: '합성 인물 E' }
  return [
    note({
      ...A,
      area: 'lower',
      status: 'added',
      tags: ['skirt lift'],
      garments: ['skirt'],
      evidence: ['sex'],
      reason: '삽입 행위 → 아래 필요'
    }),
    note({
      ...A,
      area: 'chest',
      status: 'added',
      tags: ['shirt lift', 'bra lift'],
      garments: ['shirt', 'bra'],
      evidence: ['nipples'],
      reason: '약한 신호지만 겹이 맞음'
    }),
    note({
      ...B,
      area: 'lower',
      status: 'no-garment',
      tags: ['clothing aside'],
      garments: ['shirt'],
      reason:
        '아래: 아래를 가린 옷을 못 읽음 (읽은 옷: shirt) — 붙이지 않음 · 가린 옷 이름을 카드에 적거나 제안 태그를 직접 적으세요'
    }),
    note({ ...B, area: 'chest', status: 'not-needed' }),
    note({
      ...C,
      area: 'lower',
      status: 'piece',
      tags: ['dress lift'],
      reason: 'nsfw 아래 조각이 맡음'
    }),
    note({
      ...C,
      area: 'chest',
      status: 'already',
      tags: ['dress pull'],
      reason: '씬 글에 이미 있음'
    }),
    note({
      ...D,
      area: 'lower',
      status: 'nude',
      evidence: ['nude'],
      reason: '아래: 알몸이라 젖힐 옷이 없음 (completely nude 태그)'
    }),
    note({
      ...D,
      area: 'chest',
      status: 'over-clothes',
      evidence: ['stain'],
      reason: '옷 위: stain'
    }),
    note({
      ...E,
      area: 'lower',
      status: 'conflict',
      evidence: ['clothing aside'],
      tags: ['clothing aside'],
      reason: '아래: 알몸(옷 벗기기 둘 다)인데 clothing aside 가 있음 — 자동으로 풀지 않음'
    }),
    note({ ...E, area: 'chest', status: 'off-frame', evidence: ['upper body'], reason: '화면 밖' }),
    note({
      charIndex: 5,
      charId: null,
      name: '합성 인물 F',
      area: 'lower',
      status: 'negated',
      evidence: ['not shown'],
      reason: '부정: not shown'
    }),
    note({
      charIndex: 5,
      charId: null,
      name: '합성 인물 F',
      area: 'chest',
      status: 'after',
      evidence: ['after sex'],
      reason: '사후 어구'
    }),
    note({
      charIndex: 6,
      charId: null,
      name: '합성 인물 G',
      area: 'lower',
      status: 'unknown',
      reason: '주인 모름'
    }),
    note({
      charIndex: 6,
      charId: null,
      name: '합성 인물 G',
      area: 'chest',
      status: 'vetoed',
      tags: ['shirt lift'],
      reason: '카드 글의 -1::shirt lift::'
    }),
    // 옷 글이 아예 없는 카드 — 경고가 아니라 조용한 「옷 글 없음」
    note({
      charIndex: 7,
      charId: null,
      name: '합성 인물 H',
      area: 'lower',
      status: 'no-garment',
      reason: '아래: 카드·복장에 입은 옷이 적혀 있지 않음'
    })
  ]
}

const notesRound2 = (): ExposeNote[] => allStatusNotes().slice(0, 4)

window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    request: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    switch (channel) {
      case 'tokens:count':
      case 'tokens:preview':
        return tokenFixtureInvoke(
          channel,
          request as IpcInvokeMap['tokens:count']['req'] | IpcInvokeMap['tokens:preview']['req']
        ) as IpcInvokeMap[C]['res']
      case 'tags:search':
      case 'promptPresets:list':
        return { items: [] } as IpcInvokeMap[C]['res']
      case 'outfits:list':
        return { items: structuredClone(outfits) } as IpcInvokeMap[C]['res']
      case 'outfits:classifyTags':
        return { kinds: {} } as IpcInvokeMap[C]['res']
      case 'outfits:stateCandidates':
        return { items: [] } as IpcInvokeMap[C]['res']
      case 'scenes:images':
      case 'images:list':
        return { items: [], total: 0 } as IpcInvokeMap[C]['res']
      case 'settings:get': {
        const key = (request as { key: string }).key
        let value: string | null = null
        try {
          value = localStorage.getItem(`fixture-setting-${key}`)
        } catch {
          // 저장소가 막힌 환경
        }
        return { value } as IpcInvokeMap[C]['res']
      }
      case 'settings:set': {
        const { key, value } = request as { key: string; value: string }
        try {
          localStorage.setItem(`fixture-setting-${key}`, value)
        } catch {
          // 저장소가 막힌 환경
        }
        return undefined as IpcInvokeMap[C]['res']
      }
      case 'chars:update':
      case 'scenes:update':
      case 'outfits:update':
        return undefined as IpcInvokeMap[C]['res']
      default:
        throw new Error(`UI harness blocked IPC channel: ${channel}`)
    }
  },
  on: () => () => undefined,
  pathForFile: () => {
    throw new Error('UI harness blocks filesystem access')
  }
}

const scene = {
  id: 1,
  presetId: 1,
  name: '합성 장면',
  prompt: 'indoors, sex, vaginal, nipples',
  negativePrompt: '',
  width: 832,
  height: 1216,
  reserveCount: 0,
  varietyPlus: false,
  sourceTags: 'penis',
  targetTags: '',
  sourcePos: null,
  targetPos: null,
  exportNo: null,
  thumbnail: '',
  thumbnailPath: '',
  imageCount: 0,
  censorKinds: []
} as unknown as Scene

useCharactersStore.setState({ items: cards, folders: [], loaded: true })
useOutfitsStore.setState({ items: outfits, loaded: true, exposeWorn: enabled })
useCharRefsStore.setState({ items: [], folders: [], loaded: true })
useVibesStore.setState({ items: [], folders: [], loaded: true })
useGenerationStore.setState({
  request: {
    ...DEFAULT_REQUEST,
    model: 'nai-diffusion-5-full',
    // 메인 탭 모드는 아래·가슴이 드러나는 메인 프롬프트로 (실제 메인 요청 조립을 읽기 전용으로 다시 돌린다)
    prompt: mode === 'main' ? 'indoors, sex, vaginal, nipples' : 'base'
  },
  promptSplitEnabled: false
})
useScenesStore.setState({
  scenes: [scene],
  activePresetId: 1,
  selectedId: 1,
  images: [],
  imagesTotal: 0
})
useSceneExtrasStore.setState({
  loaded: true,
  additionsEnabled: false,
  sequenceEnabled: false,
  additions: {},
  entries: []
})

function Block(): React.JSX.Element {
  const empty = params.get('empty') === '1'
  const two = params.get('rounds') === '2'
  const first = empty ? [] : allStatusNotes()
  return (
    <ExposeBlock
      enabled={enabled}
      rounds={
        two
          ? [
              { label: '기본 설정', notes: first },
              { label: '조합 2', notes: notesRound2() }
            ]
          : [{ label: '기본 설정', notes: first }]
      }
    />
  )
}

function Placement(): React.JSX.Element {
  const [outfitMap, setOutfitMap] = useState<Record<number, OutfitChoice>>({})
  return (
    <ScenePlacementDialog
      open
      onOpenChange={() => undefined}
      characterIds={[1, 2, 3]}
      useCoords={false}
      outfits={outfitMap}
      roles={{ 1: 'target', 2: 'source', 3: 'target' }}
      scene={{ prompt: scene.prompt, sourceTags: scene.sourceTags }}
      exposeNotes={enabled ? allStatusNotes() : undefined}
      onPatch={(patch) => patch.outfits && setOutfitMap(patch.outfits)}
    />
  )
}

/** 씬별 추가 창을 열고 「넓게 배치」를 눌러 실제 계산 결과로 배치 창 배지를 그린다 */
function Addition(): React.JSX.Element {
  useEffect(() => {
    useSceneExtrasStore.setState({
      loaded: true,
      additionsEnabled: true,
      additions: {
        1: {
          1: {
            characterIds: [1, 2, 3, 4],
            charRefIds: [],
            vibeIds: [],
            roles: { 1: 'target', 2: 'source', 3: 'target' }
          }
        }
      }
    })
    let tries = 0
    const timer = window.setInterval(() => {
      const button = [...document.querySelectorAll<HTMLElement>('button')].find((b) =>
        b.textContent?.includes('넓게 배치')
      )
      if (button) {
        button.click()
        window.clearInterval(timer)
      } else if (++tries > 40) window.clearInterval(timer)
    }, 50)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <AdditionDialog presetId={1} sceneIds={[1]} sceneName={scene.name} onClose={() => undefined} />
  )
}

function Picker(): React.JSX.Element {
  const [choice, setChoice] = useState<OutfitChoice | undefined>()
  const cardId = Number(params.get('card') ?? 1)
  const target = cards.find((c) => c.id === cardId) ?? cards[0]
  const withNotes = params.get('notes') !== '0'
  const notes = allStatusNotes().filter((n) => n.charId === target.id)
  return (
    <div className="max-w-[460px] rounded-lg border border-line bg-surface-2/50 p-3">
      <OutfitPicker
        card={target}
        choice={choice}
        sceneContexts={withNotes ? [scene.prompt] : undefined}
        exposeNotes={withNotes ? notes : undefined}
        onChange={setChoice}
      />
    </div>
  )
}

function Settings(): React.JSX.Element {
  // 설정 창이 포털로 늦게 뜨므로 생성 탭이 나타날 때까지 잠깐 기다렸다 연다
  useEffect(() => {
    let tries = 0
    const timer = window.setInterval(() => {
      const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find((t) =>
        t.textContent?.includes('생성')
      )
      if (tab) {
        tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        window.clearInterval(timer)
      } else if (++tries > 40) window.clearInterval(timer)
    }, 50)
    return () => window.clearInterval(timer)
  }, [])
  return <SettingsDialog open onOpenChange={() => undefined} />
}

function Page(): React.JSX.Element {
  if (mode === 'detail')
    return (
      <div className="h-full p-4" data-testid="detail">
        <SceneDetail scene={scene} />
      </div>
    )
  if (mode === 'placement') return <Placement />
  if (mode === 'addition') return <Addition />
  if (mode === 'picker') return <Picker />
  if (mode === 'outfit')
    return (
      <div className="flex h-full" data-testid="outfit">
        <OutfitMode />
      </div>
    )
  if (mode === 'settings') return <Settings />
  if (mode === 'main') return <MainExposeBlock />
  return <Block />
}

/**
 * 브라우저 콘솔에서 `await exposeFixture.check()` — 지금 모드 화면을 DOM 으로 훑어 합격/불합격 목록을 돌려준다.
 * (이미지는 보지 않는다. block·placement·picker·outfit·settings 는 합성 메모라 값까지 확인하고,
 * detail 은 실제 계산 결과라 블록이 붙었는지만 본다)
 */
type Check = { name: string; ok: boolean; detail?: string }
const STATUS_NAMES = [
  '붙음',
  '이미 있음',
  '조각이 맡음',
  '알몸',
  '옷 위',
  '화면 밖',
  '부정문',
  '섹스 뒤',
  '옷 못 읽음',
  '판단 못 함',
  '충돌',
  '막음',
  '근거 없음'
]
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const $$ = (sel: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(sel)]

async function runChecks(): Promise<Check[]> {
  const out: Check[] = []
  const ok = (name: string, pass: boolean, detail?: string): void => {
    out.push({ name, ok: pass, detail })
  }
  await wait(300)
  if (mode === 'block' || mode === 'detail') {
    const block = document.querySelector<HTMLElement>('[data-testid="expose-block"]')
    ok('접이식 「자동 젖힘」 블록이 있다', !!block)
    const summary = block?.querySelector('[data-testid="expose-summary"]')?.textContent ?? ''
    const toggle = block?.querySelector<HTMLElement>('button')
    if (
      mode === 'block' &&
      enabled &&
      params.get('empty') !== '1' &&
      params.get('rounds') !== '2'
    ) {
      ok(
        '접힌 요약에 붙음(개)·충돌·판단 못 함·옷 못 읽음(명) 수가 보이고 조용한 「옷 글 없음」은 경고로 세지 않는다',
        /붙음 3개 · 충돌 1명 · 판단 못 함 1명 · 옷 못 읽음 1명/.test(summary) &&
          !summary.includes('근거 없음'),
        summary
      )
      if (toggle?.getAttribute('aria-expanded') !== 'true') {
        toggle?.click()
        await wait(100)
      }
      const rows = $$('[data-expose-row]')
      const seen = new Set(rows.map((r) => r.dataset.status))
      ok('열면 상태 13가지가 모두 한 번 이상 보인다', seen.size === 13, [...seen].join(','))
      ok(
        '옷 글이 없는 카드는 「옷 글 없음」으로 조용히 보인다',
        $$('[data-expose-status="no-garment"]').some((e) => e.textContent === '옷 글 없음')
      )
      const labels = new Set($$('[data-expose-status]').map((e) => e.textContent))
      ok(
        '상태 이름이 정해진 한국어다',
        STATUS_NAMES.every((n) => labels.has(n)),
        [...labels].join(',')
      )
      const addedCodes = $$('[data-expose-row][data-status="added"] code')
      ok(
        '붙은 태그에는 + 가 붙고 안 붙은 태그에는 없다',
        addedCodes.length === 3 &&
          addedCodes.every((c) => c.textContent?.startsWith('+')) &&
          $$('[data-expose-row]:not([data-status="added"]) code').every(
            (c) => !c.textContent?.startsWith('+')
          )
      )
      ok(
        '안 붙은 이유(reason)가 줄마다 보인다',
        rows
          .filter((r) => r.dataset.status !== 'not-needed')
          .every((r) => (r.textContent ?? '').replace(/\s/g, '').length > 8)
      )
      ok(
        '근거 없음은 이유 없이 한 줄로 묶인다',
        $$('[data-expose-row][data-status="not-needed"]').length === 1
      )
      toggle?.click()
      await wait(100)
      ok(
        '다시 누르면 접힌다',
        toggle?.getAttribute('aria-expanded') === 'false' && $$('[data-expose-row]').length === 0
      )
      toggle?.click()
    }
    if (mode === 'block' && !enabled)
      ok('꺼져 있으면 「꺼짐」이라고 쓴다', summary === '꺼짐', summary)
    if (mode === 'block' && params.get('empty') === '1')
      ok('메모가 없으면 「붙은 것 없음」', summary === '붙은 것 없음', summary)
    if (mode === 'block' && params.get('rounds') === '2') {
      if (toggle?.getAttribute('aria-expanded') !== 'true') {
        toggle?.click()
        await wait(100)
      }
      ok(
        '회차 결과가 다르면 회차별 묶음과 「회차마다 다름」',
        summary.includes('회차마다 다름') && $$('[data-expose-char]').length > 0,
        summary
      )
    }
    if (mode === 'detail') {
      ok('요약이 「꺼짐」이나 개수로 보인다', summary.length > 0, summary)
      if (enabled) {
        if (toggle?.getAttribute('aria-expanded') !== 'true') {
          toggle?.click()
          await wait(100)
        }
        ok(
          '실제 계산 결과의 행이 캐릭터별로 보이고 붙은 태그에 + 가 붙는다',
          $$('[data-expose-char]').length >= 2 &&
            $$('[data-expose-row][data-status="added"] code').every((c) =>
              c.textContent?.startsWith('+')
            )
        )
      }
    }
  }
  if (mode === 'main') {
    await wait(600)
    const block = document.querySelector<HTMLElement>(
      '[data-testid="main-expose"] [data-testid="expose-block"]'
    )
    ok(
      '메인 탭에도 「자동 젖힘」 블록이 있다 (붙은 태그를 몰래 붙이지 않는다)',
      enabled ? !!block : !block
    )
    if (enabled) {
      const summary = block?.querySelector('[data-testid="expose-summary"]')?.textContent ?? ''
      ok('요약에 붙은 태그 수가 보인다', /붙음 \d+개/.test(summary), summary)
      ok(
        '붙은 태그가 + 와 함께 줄로 보인다 (붙은 것이 있어 처음부터 펴 있다)',
        $$('[data-expose-row][data-status="added"] code').length > 0 &&
          $$('[data-expose-row][data-status="added"] code').every((c) =>
            c.textContent?.startsWith('+')
          )
      )
    }
  }
  if (mode === 'placement') {
    const badges = $$('[data-expose-badge]')
    const auto = badges.filter((b) => b.dataset.exposeBadge === 'auto').map((b) => b.textContent)
    if (enabled) {
      ok(
        '캐릭터 줄에 「자동 +3」이 보이고 붙은 게 없는 줄에는 「자동 0」이 없다',
        auto.includes('자동 +3') && !auto.includes('자동 0'),
        auto.join(',')
      )
      ok(
        '옷 못 읽음이 부위와 함께 알려진다',
        badges.some(
          (b) => b.dataset.exposeBadge === 'no-garment' && b.textContent === '옷 못 읽음(아래)'
        )
      )
      ok('「자동 +0」은 쓰지 않는다', !auto.includes('자동 +0'))
      ok(
        '경고 배지는 이름 칸(말줄임) 밖에 있어 이름이 길어도 잘리지 않는다',
        badges.every((b) => !b.closest('.truncate'))
      )
      const first = badges.find((b) => b.textContent === '자동 +3')
      ok(
        '호버 글에 부위별 붙은 태그와 이유가 있다',
        !!first?.title.includes('아래 · 붙음 +skirt lift') &&
          !!first?.title.includes('가슴 · 붙음 +shirt lift, bra lift'),
        first?.title
      )
      const row = $$('div').find(
        (d) =>
          d.onclick !== null &&
          d.textContent?.includes('합성 카드 A') &&
          d.className.includes('rounded-md')
      )
      row?.click()
      await wait(200)
      const picker = document.querySelector('[data-testid="expose-picker"]')
      ok(
        '캐릭터를 누르면 복장 선택에 읽은 옷과 메모가 나온다',
        !!picker?.textContent?.includes('읽은 옷') && !!picker?.querySelector('[data-expose-row]'),
        picker?.textContent?.slice(0, 80)
      )
    } else ok('꺼져 있으면 배지가 없다', badges.length === 0)
  }
  if (mode === 'addition') {
    const badges = $$('[data-expose-badge]')
    const auto = badges.filter((b) => b.dataset.exposeBadge === 'auto').map((b) => b.textContent)
    ok(
      '실제 계산 결과가 캐릭터 줄 「자동 +N」으로 보인다',
      auto.length >= 3 && auto.every((t) => /^자동 \+\d+$/.test(t ?? '')),
      auto.join(',')
    )
    ok(
      '옷 글이 아예 없는 카드는 경고 배지 없이 조용하다',
      !badges.some((b) => b.dataset.exposeBadge === 'no-garment')
    )
    ok(
      '호버 글에 붙은 태그가 있다',
      badges.some((b) => b.dataset.exposeBadge === 'auto' && b.title.includes('+skirt lift'))
    )
  }
  if (mode === 'picker') {
    const picker = document.querySelector('[data-testid="expose-picker"]')
    ok(
      '복장 선택에 「읽은 옷」 줄이 있다',
      !!document.querySelector('[data-testid="expose-garments"]')
    )
    if (!enabled) ok('꺼져 있으면 꺼짐 안내', !!picker?.textContent?.includes('꺼져 있습니다'))
    else if (params.get('notes') === '0')
      ok(
        '씬을 모르면 후보를 보이고 씬을 열라고 안내',
        !!document.querySelector('[data-testid="expose-candidates"]')
      )
    else ok('씬 안에서는 메모 줄이 나온다', $$('[data-expose-row]').length > 0)
  }
  if (mode === 'outfit') {
    const section = document.querySelector<HTMLElement>('[data-testid="card-wear"]')
    ok('복장 탭에 「카드 글에서 읽은 옷」 구역이 있다', !!section)
    section?.querySelector('button')?.click()
    await wait(100)
    const rows = $$('[data-card-wear]').map((r) => r.textContent ?? '')
    ok(
      '옷이 적힌 카드만 읽은 옷과 후보를 보인다',
      rows.length === 2 &&
        rows[0].includes('skirt') &&
        rows[0].includes('skirt lift') &&
        rows[1].includes('pants'),
      rows.join(' | ')
    )
  }
  if (mode === 'settings') {
    const title = $$('[role="dialog"] p').find((p) => p.textContent === '입은 옷 자동 젖힘')
    ok('설정 생성 탭에 「입은 옷 자동 젖힘」 줄이 있다', !!title)
    const sw = title?.closest('.py-2\\.5')?.querySelector<HTMLElement>('button[role="switch"]')
    ok('스위치가 설정값(기본 켬)을 따른다', sw?.getAttribute('aria-checked') === String(enabled))
  }
  return out
}
Object.assign(window, { exposeFixture: { check: runChecks } })

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <main className="h-full overflow-auto p-4 text-[14px]">
      <Page />
    </main>
  </TooltipProvider>
)
