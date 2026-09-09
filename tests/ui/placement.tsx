import { useState, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import type { CharacterCard, IpcInvokeMap, Scene } from '../../src/shared/types'
import { ScenePlacementDialog } from '../../src/renderer/src/components/scene-placement-dialog'
import {
  AdditionDialog,
  SequenceDialog
} from '../../src/renderer/src/components/scene-extras-dialogs'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { useCharactersStore } from '../../src/renderer/src/stores/characters-store'
import { useGenerationStore } from '../../src/renderer/src/stores/generation-store'
import { useCharRefsStore, useVibesStore } from '../../src/renderer/src/stores/refs-store'
import { useSceneExtrasStore } from '../../src/renderer/src/stores/scene-extras-store'
import { useScenesStore } from '../../src/renderer/src/stores/scenes-store'
import './placement.css'
import { tagFixtureInvoke } from './tag-fixture'
import { tokenFixtureInvoke } from './token-fixture'

type PlacementProps = ComponentProps<typeof ScenePlacementDialog>
type PlacementState = Omit<PlacementProps, 'open' | 'onOpenChange' | 'onPatch'>
type PlacementPatch = Parameters<PlacementProps['onPatch']>[0]

const params = new URLSearchParams(location.search)
const names = ['하늘 탐험가', '숲의 연구원', '보랏빛 망토의 여행자 이름이 긴 예시', '도서관 안내원']
const longTags = Array.from(
  { length: 32 },
  () => 'outdoors, blue sky, forest, sunlight, long coat, standing, looking at viewer'
).join(', ')

function makeCharacters(): CharacterCard[] {
  return Array.from({ length: 40 }, (_, index) => ({
    id: index + 1,
    name: names[index] ?? `검증 캐릭터 ${index + 1}`,
    prompt: index === 2 ? longTags : 'adult, jacket, standing',
    negativePrompt: '',
    thumbnail: '',
    enabled: index === 3,
    center: { x: 0.5, y: 0.5 },
    slotNo: null,
    folderId: null,
    charRefId: null,
    role: null
  }))
}

// This page never loads Electron or the application entry point. All IPC calls
// terminate here. Unknown channels fail closed, including generation/auth/files.
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
        return params.get('tags') === '1'
          ? ((await tagFixtureInvoke(channel, request)) as IpcInvokeMap[C]['res'])
          : ({ items: [] } as IpcInvokeMap[C]['res'])
      case 'tags:history':
      case 'tags:recordUse':
      case 'tags:setKo':
        return (await tagFixtureInvoke(channel, request)) as IpcInvokeMap[C]['res']
      case 'chars:update':
      case 'scenes:update':
      case 'settings:set':
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

useCharactersStore.setState({ items: makeCharacters(), folders: [], loaded: true })
useCharRefsStore.setState({ items: [], folders: [], loaded: true })
useVibesStore.setState({ items: [], folders: [], loaded: true })

const sizes: Record<string, [number, number]> = {
  tall: [832, 1216],
  wide: [1536, 640],
  square: [1024, 1024],
  narrow: [512, 2048]
}
const initialSize = sizes[params.get('size') ?? 'tall'] ? (params.get('size') ?? 'tall') : 'tall'
const initialModel =
  params.get('model') === 'v45' ? 'nai-diffusion-4-5-full' : 'nai-diffusion-5-full'
useGenerationStore.setState((state) => ({
  request: {
    ...state.request,
    model: initialModel,
    width: sizes[initialSize][0],
    height: sizes[initialSize][1]
  }
}))

function fixture(name: string): PlacementState {
  if (name === 'many') {
    return {
      characterIds: Array.from({ length: 32 }, (_, index) => index + 1),
      useCoords: true,
      positions: Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [
          index + 1,
          { x: ((index % 8) + 0.5) / 8, y: (Math.floor(index / 8) + 0.5) / 4 }
        ])
      )
    }
  }
  if (name === 'empty') return { characterIds: [], useCoords: false }
  if (name === 'overlap') {
    return {
      characterIds: [1, 2, 3, 4],
      useCoords: false,
      positions: {},
      charTags: { 3: longTags }
    }
  }
  return {
    characterIds: [1, 2, 3],
    baseCharacterIds: [4],
    useCoords: true,
    positions: { 3: { x: 0.5, y: 0.25 }, 4: { x: 0.85, y: 0.8 } },
    slots: [
      { x: 0.1, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0.9, y: 0.5 }
    ],
    slotChars: { 0: 1, 1: 1 },
    slotTags: { 0: 'waving, smile', 1: longTags, 2: 'holding book' },
    charTags: { 1: 'red scarf', 3: longTags }
  }
}

function seedNestedFixtures(name: string): void {
  const placement = fixture(name)
  const addition = { ...placement, charRefIds: [], vibeIds: [] }
  useSceneExtrasStore.setState({
    loaded: true,
    sequenceEnabled: false,
    additionsEnabled: true,
    additions: { 1: { 1: addition } },
    entries: [{ ...addition, id: 'fixture-entry', name: '검증 조합', enabled: true }]
  })
}

const mockScene: Scene = {
  id: 1,
  presetId: 1,
  name: '숲속 만남 — 씬 해상도 1536×640',
  prompt: 'forest, outdoors',
  negativePrompt: '',
  width: 1536,
  height: 640,
  reserveCount: 0,
  varietyPlus: false,
  sourceTags: '',
  targetTags: '',
  sourcePos: null,
  targetPos: null,
  exportNo: null,
  thumbnail: '',
  thumbnailPath: '',
  imageCount: 0
}
useScenesStore.setState({ scenes: [mockScene], activePresetId: 1, selectedId: 1 })
seedNestedFixtures(params.get('fixture') ?? 'slots')

export function Harness(): React.JSX.Element {
  const [open, setOpen] = useState(params.get('open') !== '0')
  const [fixtureName, setFixtureName] = useState(params.get('fixture') ?? 'slots')
  const [state, setState] = useState<PlacementState>(() => fixture(fixtureName))
  const [lastPatch, setLastPatch] = useState<PlacementPatch>({})
  const [patchCount, setPatchCount] = useState(0)
  const [size, setSize] = useState(initialSize)
  const [mode, setMode] = useState(params.get('mode') ?? 'direct')
  const request = useGenerationStore((store) => store.request)
  const additions = useSceneExtrasStore((store) => store.additions)
  const entries = useSceneExtrasStore((store) => store.entries)
  const scenes = useScenesStore((store) => store.scenes)

  return (
    <TooltipProvider>
      <main className="h-full overflow-auto p-6 text-[14px]">
        <h1 className="mb-2 text-xl font-semibold">배치 UI 검증</h1>
        <p className="mb-5 text-muted">
          가상 캐릭터 40명 · 실제 앱 컴포넌트 · 저장 및 생성 API 없음
        </p>
        <div className="mb-5 flex flex-wrap items-center gap-4">
          <label>
            진입 경로{' '}
            <select
              aria-label="검증 진입 경로"
              className="rounded border border-line bg-surface p-2"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="direct">배치 창 직접 열기</option>
              <option value="addition">씬별 추가 → 넓게 배치</option>
              <option value="sequence">큐 반복 → 넓게 배치</option>
            </select>
          </label>
          <label>
            모델{' '}
            <select
              aria-label="검증 모델"
              className="rounded border border-line bg-surface p-2"
              value={request.model}
              onChange={(event) =>
                useGenerationStore.setState((store) => ({
                  request: { ...store.request, model: event.target.value }
                }))
              }
            >
              <option value="nai-diffusion-5-full">V5 자유 배치</option>
              <option value="nai-diffusion-4-5-full">V4.5 5×5 격자</option>
            </select>
          </label>
          <label>
            생성 비율{' '}
            <select
              aria-label="검증 생성 비율"
              className="rounded border border-line bg-surface p-2"
              value={size}
              onChange={(event) => {
                setSize(event.target.value)
                const [width, height] = sizes[event.target.value]
                useGenerationStore.setState((store) => ({
                  request: { ...store.request, width, height }
                }))
              }}
            >
              <option value="tall">세로 832×1216</option>
              <option value="wide">가로 1536×640</option>
              <option value="square">정사각 1024×1024</option>
              <option value="narrow">긴 세로 512×2048</option>
            </select>
          </label>
          <label>
            검증 데이터{' '}
            <select
              aria-label="검증 데이터"
              className="rounded border border-line bg-surface p-2"
              value={fixtureName}
              onChange={(event) => {
                setFixtureName(event.target.value)
                setState(fixture(event.target.value))
                seedNestedFixtures(event.target.value)
                setLastPatch({})
                setPatchCount(0)
              }}
            >
              <option value="slots">반복 배정 + 빈 자리 + 긴 태그</option>
              <option value="many">32명 전체 배치</option>
              <option value="overlap">중앙에 겹친 4명 + 위치 OFF</option>
              <option value="empty">빈 씬</option>
            </select>
          </label>
          <button className="rounded bg-accent px-4 py-2 text-white" onClick={() => setOpen(true)}>
            씬 배치 열기
          </button>
          <button
            className="rounded border border-line px-4 py-2"
            onClick={() => {
              document.documentElement.dataset.theme =
                document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
            }}
          >
            테마 전환
          </button>
        </div>
        <p className="mb-2 text-muted" data-testid="patch-count">
          반영 횟수: {patchCount}
        </p>
        <h2 className="mb-2 font-semibold">최근 변경</h2>
        <pre
          className="mb-5 whitespace-pre-wrap rounded border border-line bg-surface p-3 font-mono text-xs"
          data-testid="last-patch"
        >
          {JSON.stringify(lastPatch, null, 2)}
        </pre>
        <details>
          <summary className="cursor-pointer">현재 씬 상태</summary>
          <pre className="whitespace-pre-wrap p-3 font-mono text-xs" data-testid="placement-state">
            {JSON.stringify(state, null, 2)}
          </pre>
        </details>
        <details>
          <summary className="cursor-pointer">호출 창의 저장 상태 (씬별 추가 / 큐 반복)</summary>
          <pre className="whitespace-pre-wrap p-3 font-mono text-xs" data-testid="nested-state">
            {JSON.stringify({ additions, entries, scenes }, null, 2)}
          </pre>
        </details>
        {mode === 'addition' ? (
          <AdditionDialog
            presetId={1}
            sceneIds={open ? [1] : null}
            sceneName={mockScene.name}
            onClose={() => setOpen(false)}
          />
        ) : mode === 'sequence' ? (
          <SequenceDialog open={open} onOpenChange={setOpen} />
        ) : (
          <ScenePlacementDialog
            {...state}
            open={open}
            onOpenChange={setOpen}
            onPatch={(patch) => {
              setState((previous) => ({ ...previous, ...patch }))
              setLastPatch(patch)
              setPatchCount((count) => count + 1)
            }}
          />
        )}
      </main>
    </TooltipProvider>
  )
}

createRoot(document.getElementById('root')!).render(<Harness />)
