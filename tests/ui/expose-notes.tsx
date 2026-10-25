/* eslint-disable react-refresh/only-export-components -- 시험 화면 전용 파일: 컴포넌트를 내보내지 않고 바로 화면에 그린다 */
import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type {
  BodyNote,
  CharacterCard,
  ExposeNote,
  IpcInvokeMap,
  Scene
} from '../../src/shared/types'
import type { Outfit, OutfitChoice } from '../../src/shared/outfit'
import { BodyBlock } from '../../src/renderer/src/components/body-notes'
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
 *   ?mode=settings   실제 설정 창 (생성 탭의 「입은 옷 자동 젖힘」·「후타 자동 재조립」·「후타 시점·구도 정리」 스위치)
 *   ?mode=body       접이식 「몸·후타」 블록에 종류 7가지를 전부 넣은 합성 메모
 *   ?mode=main       메인 탭 블록 (실제 메인 요청 조립 · &futa=1 이면 후타 카드가 있어 「몸·후타」도 나온다)
 *   &enabled=0       설정 「입은 옷 자동 젖힘」 꺼짐
 *   &futa=0          설정 「후타 자동 재조립」 꺼짐 (settings 에서 시점·구도 스위치가 잠기는지)
 *   &fake=1          (main) 핵심 모듈 없이 메인 탭 배선만 보려고 buildMainRequest 결과에 합성 몸·후타 메모와 후타 2명 계획을 얹는다
 *   &futacard=1      재조립 설정과 상관없이 합성 후타 카드(E)만 더한다 — &futa=0 과 함께면 「재조립 꺼짐」 한 줄이 나오는지 (detail)
 *   &futa=1          합성 후타 카드(E)를 더한다 — detail·main 에서 실제 요청 조립이 「몸·후타」 메모를 만든다
 *   &empty=1         (block·body) 메모 없음
 *   &quiet=1         (body) 후타 1명이 그려지는데 바꾼 것이 없다 — 「후타 1명 · 바꾼 것 없음」 한 줄
 *   &rounds=2        (block·body) 큐 반복 2회차 — 서로 다른 결과
 *   &open=1          (block·body·detail) 블록을 펴 둔 채로
 *   &notes=0         (picker) 씬을 모르는 상태 (메모 없음)
 *   &card=1|3        (picker) 1 = 복장 없는 카드, 3 = 복장 있는 카드
 */

const params = new URLSearchParams(location.search)
const mode = params.get('mode') ?? 'block'
const enabled = params.get('enabled') !== '0'

try {
  for (const key of ['scene_expose_open', 'scene_body_open']) {
    if (params.get('open') === '1') localStorage.setItem(key, '1')
    else if (params.has('open')) localStorage.removeItem(key)
  }
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

// &futa=1 — 합성 후타 카드. 실제 요청 조립(핵심 모듈)이 「몸·후타」 메모를 만드는지 detail·main 에서 본다
if (params.get('futa') === '1' || params.get('futacard') === '1')
  cards.push(
    card({
      id: 5,
      name: '합성 카드 E',
      prompt: '1girl, adult, futanari, large penis, long hair',
      role: 'source'
    })
  )

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

const bodyNote = (n: Partial<BodyNote> & Pick<BodyNote, 'kind' | 'where'>): BodyNote => ({
  reason: '',
  ...n
})

/**
 * 종류 7가지를 한 번씩 이상 보이는 합성 몸·후타 메모. 접힌 줄은
 * 「후타 1명 · 바꿈 3 · 뺌 1 · 더함 1 · pink nipples 1 · 충돌 1 · 후타 의심 1 · 못 읽음 1 · 안 바꿈 2」가 된다
 * (후타 명수는 후타 메모가 가리키는 캐릭터 — 합성 카드 A 한 명).
 */
const EXPECTED_BODY_SUMMARY =
  '후타 1명 · 바꿈 3 · 뺌 1 · 더함 1 · pink nipples 1 · 충돌 1 · 후타 의심 1 · 못 읽음 1 · 안 바꿈 2'
function allKindBodyNotes(): BodyNote[] {
  const A = { charIndex: 0, name: '합성 카드 A' }
  const B = { charIndex: 1, name: '합성 카드 B' }
  const C = { charIndex: 2, name: '합성 카드 C' }
  return [
    bodyNote({
      kind: 'replaced',
      where: 'scene',
      before: 'hetero',
      after: 'futa with female',
      reason: '남자 장면의 관계 태그를 후타 구성으로 바꿈'
    }),
    bodyNote({
      kind: 'replaced',
      where: 'scene',
      before: '1girl, 1boy',
      after: '2girls',
      evidence: 'hetero',
      reason: '후타는 girl 로 세어 인원수를 합침'
    }),
    bodyNote({
      kind: 'replaced',
      where: 'source',
      ...A,
      before: 'faceless male',
      after: 'faceless female',
      reason: '남자 묘사를 후타 구성으로 바꿈'
    }),
    bodyNote({
      kind: 'removed',
      where: 'scene',
      before: 'testicles',
      reason: '후타는 고환이 없어 뺌'
    }),
    bodyNote({
      kind: 'added',
      where: 'char',
      ...A,
      after: 'no testicles',
      reason: '카드에 고환 유형 태그가 없어 더함'
    }),
    bodyNote({
      kind: 'added',
      where: 'char',
      ...A,
      after: 'pink nipples',
      evidence: '사용자 실측',
      reason: '알몸이고 가슴이 여성이라 더함'
    }),
    bodyNote({
      kind: 'kept',
      where: 'scene',
      before: 'leaning against him',
      reason: '문장 속 him 은 안전하게 바꿀 수 없어 그대로 둠'
    }),
    bodyNote({
      kind: 'kept',
      where: 'scene',
      before: 'his hard cock',
      reason: '문장 속 his 는 안전하게 바꿀 수 없어 그대로 둠'
    }),
    bodyNote({
      kind: 'suspect',
      where: 'char',
      ...B,
      evidence: 'penis',
      reason: '여성 카드에 penis 만 있어 후타로 보지 않음'
    }),
    bodyNote({
      kind: 'conflict',
      where: 'char',
      ...C,
      evidence: '1boy, futanari',
      reason: '같은 카드에 1boy 와 futanari 가 함께 있어 바꾸지 않음'
    }),
    bodyNote({
      kind: 'unreadable',
      where: 'char',
      ...C,
      before: '__body__',
      reason: '와일드카드는 미리 읽을 수 없음'
    })
  ]
}
const bodyRound2 = (): BodyNote[] => allKindBodyNotes().slice(0, 2)

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
useOutfitsStore.setState({
  items: outfits,
  loaded: true,
  exposeWorn: enabled,
  futaReassembly: params.get('futa') !== '0',
  futaViewFix: true
})
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
// &fake=1 — 실제 조립 결과에 합성 몸·후타 메모를 얹어, 메인 탭 블록이 요청의 bodyNotes·futaPlan 을 읽어 그리는지만 본다
if (mode === 'main' && params.get('fake') === '1') {
  const real = useGenerationStore.getState().buildMainRequest
  useGenerationStore.setState({
    buildMainRequest: async (...args: Parameters<typeof real>) => ({
      ...(await real(...args)),
      bodyNotes: allKindBodyNotes(),
      futaPlan: { counts: { futa: 2, female: 1, male: 0 }, viewFix: true, dedupePenis: false }
    })
  })
}
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

function Body(): React.JSX.Element {
  const empty = params.get('empty') === '1'
  const quiet = params.get('quiet') === '1'
  const two = params.get('rounds') === '2'
  const first = empty || quiet ? [] : allKindBodyNotes()
  // 후타 명수는 요청의 재조립 계획이 알려 준다 (메모로 짐작하지 않는다) — 후타 한 명이 그려지는 요청
  const futa = empty ? undefined : 1
  return (
    <BodyBlock
      rounds={
        two
          ? [
              { label: '기본 설정', notes: first, futa },
              { label: '조합 2', notes: bodyRound2(), futa }
            ]
          : [{ label: '기본 설정', notes: first, futa }]
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
      bodyNotes={allKindBodyNotes()}
      futaCharIds={[1]}
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
  if (mode === 'body') return <Body />
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
    if (mode === 'detail' && params.get('futa') === '0' && params.get('futacard') === '1') {
      // 재조립을 껐는데 후타 카드가 그려진다 — 후타를 못 알아본 것이 아니라 껐다는 한 줄
      const body = document.querySelector<HTMLElement>('[data-testid="body-block"]')
      const bodySummary = body?.querySelector('[data-testid="body-summary"]')?.textContent ?? ''
      ok('재조립이 꺼져 있어도 후타 카드가 있으면 「몸·후타」 줄이 보인다', !!body)
      ok(
        '그 줄은 「재조립 꺼짐」을 말한다',
        bodySummary.includes('후타 카드 1장 · 재조립 꺼짐'),
        bodySummary
      )
    }
    if (mode === 'detail' && params.get('futa') === '1') {
      // 핵심 모듈이 후타 카드를 읽어 몸·후타 메모를 요청에 실었는지 — 실제 조립 결과를 DOM 으로만 본다
      const body = document.querySelector<HTMLElement>('[data-testid="body-block"]')
      const bodySummary = body?.querySelector('[data-testid="body-summary"]')?.textContent ?? ''
      ok('후타 카드가 있는 씬에는 「몸·후타」 블록이 보인다', !!body)
      ok(
        '블록 요약은 비어 있지 않고 「후타」로 시작하거나 pink nipples 를 센다',
        /^(후타|pink nipples)/.test(bodySummary),
        bodySummary
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
  if (mode === 'body') {
    const block = document.querySelector<HTMLElement>('[data-testid="body-block"]')
    const empty = params.get('empty') === '1'
    if (empty) {
      ok('후타도 메모도 없으면 「몸·후타」 블록을 그리지 않는다', !block)
    } else if (params.get('quiet') === '1') {
      const summary = block?.querySelector('[data-testid="body-summary"]')?.textContent ?? ''
      ok(
        '후타가 그려지는데 바꾼 것이 없으면 한 줄만 보인다',
        !!block?.hasAttribute('data-body-empty')
      )
      ok('그 줄은 「후타 1명 · 바꾼 것 없음」이다', summary === '후타 1명 · 바꾼 것 없음', summary)
      ok('펼치는 버튼은 없다', !block?.querySelector('button'))
    } else {
      ok('접이식 「몸·후타」 블록이 있다', !!block)
      const summary = block?.querySelector('[data-testid="body-summary"]')?.textContent ?? ''
      const toggle = block?.querySelector<HTMLElement>('button')
      if (params.get('rounds') === '2') {
        ok('회차 결과가 다르면 「회차마다 다름」', summary.includes('회차마다 다름'), summary)
        if (toggle?.getAttribute('aria-expanded') !== 'true') {
          toggle?.click()
          await wait(100)
        }
        const labels = $$('[data-testid="body-block"] p').map((p) => p.textContent)
        ok('회차별 이름이 보인다', labels.includes('기본 설정') && labels.includes('조합 2'))
      } else {
        ok(
          '접힌 요약이 후타 명수·바꿈·뺌·더함·pink nipples·충돌·후타 의심·못 읽음·안 바꿈을 센다',
          summary === EXPECTED_BODY_SUMMARY,
          summary
        )
        const pieces = [
          ...(block?.querySelectorAll<HTMLElement>('[data-testid="body-summary"] > span > span') ??
            [])
        ]
        ok(
          '바뀐 것과 눈여겨볼 것은 접어도 색이 있고 그대로 둔 것은 색이 없다',
          pieces.length === 9 &&
            pieces
              .filter((e) =>
                /^(바꿈|뺌|더함|pink|충돌|후타 의심|못 읽음)/.test(e.textContent ?? '')
              )
              .every((e) => e.className.includes('text-')) &&
            pieces
              .filter((e) => (e.textContent ?? '').startsWith('안 바꿈'))
              .every((e) => e.className === ''),
          String(pieces.length)
        )
        if (toggle?.getAttribute('aria-expanded') !== 'true') {
          toggle?.click()
          await wait(100)
        }
        const rows = $$('[data-body-row]')
        const kinds = new Set(rows.map((r) => r.dataset.kind))
        ok('열면 종류 7가지가 모두 한 줄 이상 보인다', kinds.size === 7, [...kinds].join(','))
        const labels = new Set($$('[data-body-kind]').map((e) => e.textContent))
        ok(
          '종류 이름이 정해진 한국어다',
          ['바꿈', '뺌', '더함', '안 바꿈', '못 읽음', '후타 의심', '충돌'].every((n) =>
            labels.has(n)
          ),
          [...labels].join(',')
        )
        const replaced = $$('[data-body-row][data-kind="replaced"]')
        ok(
          '바꿈은 이전(취소선) → 이후 로 보인다',
          replaced.length === 3 &&
            replaced.every((r) => {
              const codes = [...r.querySelectorAll('code')]
              return (
                codes.length === 2 &&
                codes[0].className.includes('line-through') &&
                !codes[1].className.includes('line-through') &&
                (r.textContent ?? '').includes('→')
              )
            })
        )
        const added = $$('[data-body-row][data-kind="added"] code').map((c) => c.textContent)
        ok(
          '더한 태그에는 + 가 붙는다',
          added.length === 2 &&
            added.every((t) => t?.startsWith('+')) &&
            added.includes('+pink nipples'),
          added.join(',')
        )
        ok(
          'pink nipples 는 근거 「사용자 실측」이 같이 보인다',
          $$('[data-body-row][data-kind="added"]').some(
            (r) =>
              (r.textContent ?? '').includes('+pink nipples') &&
              (r.textContent ?? '').includes('근거 사용자 실측')
          )
        )
        ok(
          '이유가 줄마다 보인다',
          rows.every((r) => (r.textContent ?? '').replace(/\s/g, '').length > 10)
        )
        ok(
          '위치(씬·캐릭터 이름·하는쪽 칸)가 줄에 보인다',
          rows.some((r) => (r.textContent ?? '').startsWith('씬')) &&
            rows.some((r) => (r.textContent ?? '').startsWith('합성 카드 A · 하는쪽 칸'))
        )
        ok(
          '안내 글에 pink nipples 가 설정과 무관하다고 쓴다',
          (block?.textContent ?? '').includes('pink nipples 는 이 설정과 무관합니다')
        )
        toggle?.click()
        await wait(100)
        ok(
          '다시 누르면 접힌다',
          toggle?.getAttribute('aria-expanded') === 'false' && $$('[data-body-row]').length === 0
        )
        toggle?.click()
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
    if (params.get('fake') === '1') {
      const body = document.querySelector<HTMLElement>(
        '[data-testid="main-body"] [data-testid="body-block"]'
      )
      const bodySummary = body?.querySelector('[data-testid="body-summary"]')?.textContent ?? ''
      ok('요청의 bodyNotes 가 메인 탭 「몸·후타」 블록으로 보인다', !!body)
      ok(
        '요청의 futaPlan 이 알려 준 후타 수(2명)를 요약 맨 앞에 쓴다',
        bodySummary.startsWith('후타 2명 · 바꿈 3'),
        bodySummary
      )
      ok(
        '자동 젖힘 블록과 나란히 보인다',
        !!document.querySelector('[data-testid="main-expose"] [data-testid="expose-block"]') ===
          enabled
      )
    }
    if (params.get('futa') === '1') {
      const body = document.querySelector<HTMLElement>(
        '[data-testid="main-body"] [data-testid="body-block"]'
      )
      ok('후타 카드가 켜져 있으면 메인 탭에도 「몸·후타」 블록이 있다', !!body)
    }
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
    // 몸·후타 배지는 자동 젖힘과 따로 — 자동 젖힘이 꺼져 있어도 후타 메모가 오면 보인다
    const bodyBadges = $$('[data-body-badge]')
    const byId = (id: string): HTMLElement[] => bodyBadges.filter((b) => b.dataset.bodyBadge === id)
    ok(
      '후타로 읽힌 카드 줄에 「후타」 배지가 한 번 보인다',
      byId('futa').length === 1 && byId('futa')[0].textContent === '후타'
    )
    ok(
      '후타 의심 배지가 한 번 보인다',
      byId('suspect').length === 1 && byId('suspect')[0].textContent === '후타 의심'
    )
    ok(
      '충돌·못 읽음 배지는 「후타」를 붙여 자동 젖힘 배지와 헷갈리지 않게 한다',
      byId('conflict')[0]?.textContent === '후타 충돌' &&
        byId('unreadable')[0]?.textContent === '후타 못 읽음'
    )
    ok(
      '후타 배지 호버 글에 그 캐릭터 메모가 있고 다른 캐릭터 메모는 없다',
      !!byId('futa')[0]?.title.includes('+no testicles') &&
        !byId('futa')[0]?.title.includes('와일드카드')
    )
    ok(
      '후타 배지도 이름 칸(말줄임) 밖에 있다',
      bodyBadges.length > 0 && bodyBadges.every((b) => !b.closest('.truncate'))
    )
    // 배지는 이름 아래 둘째 줄 — 이름 칸이 배지와 폭을 다투지 않는다
    const nameOf = (badge: HTMLElement): HTMLElement | null | undefined =>
      badge.closest('li, div')?.querySelector<HTMLElement>('.truncate')
    ok(
      '배지는 이름 아래 줄에 있어 이름이 배지 때문에 줄어들지 않는다',
      bodyBadges.length > 0 &&
        bodyBadges.every((b) => {
          const name = nameOf(b)
          return !!name && b.getBoundingClientRect().top >= name.getBoundingClientRect().bottom - 1
        })
    )
    // 카드 A(후타로 읽힘)만 「후타」 배지 — 상대 카드에는 글을 바꾼 메모가 있어도 「후타」를 달지 않는다
    ok(
      '「후타」 배지는 계획이 후타라고 알려 준 카드에만 달린다',
      byId('futa').length === 1 &&
        !!byId('futa')[0].closest('li, div')?.textContent?.includes('합성 카드 A')
    )
    ok('카드 A 는 후타라 pink nipples 배지를 따로 달지 않는다', byId('pink').length === 0)
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
    const switchOf = (label: string): HTMLElement | null | undefined =>
      $$('[role="dialog"] p')
        .find((p) => p.textContent === label)
        ?.closest('.py-2\\.5')
        ?.querySelector<HTMLElement>('button[role="switch"]')
    const reassembly = switchOf('후타 자동 재조립')
    const viewFix = switchOf('후타 시점·구도 정리')
    const futaOn = params.get('futa') !== '0'
    ok(
      '설정 생성 탭에 「후타 자동 재조립」 스위치가 있고 설정값(기본 켬)을 따른다',
      reassembly?.getAttribute('aria-checked') === String(futaOn),
      reassembly?.getAttribute('aria-checked') ?? '없음'
    )
    ok(
      '「후타 시점·구도 정리」 스위치는 재조립이 켜져 있을 때만 누를 수 있다',
      !!viewFix && viewFix.hasAttribute('disabled') === !futaOn
    )
    const hints = $$('[role="dialog"] p').map((p) => p.textContent ?? '')
    ok(
      '안내 글에 「당신」이 없고 pink nipples 가 설정과 무관하다고 쓴다',
      hints.every((t) => !t.includes('당신')) &&
        hints.some((t) => t.includes('pink nipples') && t.includes('이 설정과 무관'))
    )
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
