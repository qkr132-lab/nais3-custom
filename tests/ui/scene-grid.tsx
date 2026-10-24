import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import type { IpcInvokeMap, Scene } from '../../src/shared/types'
import { SceneMode } from '../../src/renderer/src/components/scene-mode'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { useCharactersStore } from '../../src/renderer/src/stores/characters-store'
import { useGenerationStore } from '../../src/renderer/src/stores/generation-store'
import { useLayoutStore } from '../../src/renderer/src/stores/layout-store'
import { useVibesStore, useCharRefsStore } from '../../src/renderer/src/stores/refs-store'
import { useScenesStore } from '../../src/renderer/src/stores/scenes-store'
import { bindShortcuts } from '../../src/renderer/src/stores/shortcuts-store'
import './placement.css'

/**
 * 씬 격자 이동 검증 페이지 — 실제 SceneMode(빠른 이동 막대·씬 찾기·키 이동·이름 목록)를
 * 씬 120개짜리 가짜 프리셋 2개(배경 모드는 40개 1개)로 그린다.
 * 모든 데이터는 이 파일이 만든 가짜이고, window.nais 는 메모리에서만 답한다 (NAI·파일·DB 호출 없음).
 *
 * 주소 매개변수
 *   ?kind=background  배경 라이브러리로 열기 (프리셋 1개, 씬 40개)
 *   ?count=300        프리셋당 씬 수 (기본 120)
 *   ?busy=5           순번 5번 씬을 「생성 중」으로 표시
 *   ?panels=1         격자 양옆에 스크롤되는 가짜 패널(왼쪽 프롬프트·오른쪽 히스토리)을 둔다 — 키 이동 범위 확인용
 *   ?panels=app       실제 앱과 같은 배치(격자를 줄의 직속 칸으로 + 오른쪽 히스토리 240px) — &left=폭 으로 왼쪽 패널 폭.
 *                     넓은 창에서 왼쪽 패널을 넓혀도 히스토리가 창 밖으로 밀리지 않는지 확인용
 * 시험용 함수는 window.sceneGridFixture (기록된 IPC 호출·순서·상태 조회)
 */

const params = new URLSearchParams(location.search)
const kind = params.get('kind') === 'background' ? 'background' : 'scene'
const COUNT = Math.max(1, Number(params.get('count')) || 120)

const PLACES_A = ['교실', '옥상', '복도', '도서관', '운동장', '급식실', '체육관', '정문']
const PLACES_B = ['해변', '카페', '역', '골목', '공원', '온천', '놀이공원', '시장']
const MOODS = ['아침', '노을', '비 오는 날', '한밤', '점심', '방과후']

/** 번호가 적힌 가짜 그림 (캔버스로 직접 그린 색 그라데이션 — 실제 이미지가 아니다) */
function fakeThumb(seed: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 187
  const g = canvas.getContext('2d')!
  const hue = (seed * 47) % 360
  const grad = g.createLinearGradient(0, 0, 128, 187)
  grad.addColorStop(0, `hsl(${hue} 45% 38%)`)
  grad.addColorStop(1, `hsl(${(hue + 50) % 360} 50% 22%)`)
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 187)
  g.fillStyle = 'rgba(255,255,255,0.85)'
  g.font = 'bold 44px sans-serif'
  g.textAlign = 'center'
  g.fillText(String(seed), 64, 105)
  return canvas.toDataURL('image/webp', 0.6).split(',')[1]
}

function makeScenes(presetId: number, firstId: number, count: number, places: string[]): Scene[] {
  return Array.from({ length: count }, (_, i) => {
    const imageCount = i % 7 === 0 ? 0 : (i % 5) + 1
    return {
      id: firstId + i,
      presetId,
      kind: presetId === 3 ? 'background' : 'scene',
      name: `${places[i % places.length]} ${MOODS[i % MOODS.length]} ${String(i + 1).padStart(3, '0')}`,
      prompt: 'landscape, blue sky',
      negativePrompt: '',
      width: 832,
      height: 1216,
      reserveCount: i % 11 === 3 ? 2 : 0,
      varietyPlus: i % 9 === 4,
      sourceTags: '',
      targetTags: '',
      sourcePos: null,
      targetPos: null,
      exportNo: i % 10 === 6 ? i + 1 : null,
      thumbnail: imageCount > 0 ? fakeThumb(i + 1) : '',
      thumbnailPath: '',
      imageCount,
      censorKinds: []
    } satisfies Scene
  })
}

let records: Scene[] =
  kind === 'background'
    ? makeScenes(3, 301, 40, PLACES_A)
    : [...makeScenes(1, 1, COUNT, PLACES_A), ...makeScenes(2, 1001, COUNT, PLACES_B)]
const calls: { channel: string; req: unknown }[] = []
const reorders: number[][] = []

useCharactersStore.setState({ loaded: true })
useVibesStore.setState({ loaded: true })
useCharRefsStore.setState({ loaded: true })
useLayoutStore.setState({ centerMode: kind })
const busyOrdinal = Number(params.get('busy'))
if (busyOrdinal > 0) {
  const target = records.filter((s) => s.presetId === (kind === 'background' ? 3 : 1))[
    busyOrdinal - 1
  ]
  if (target) useGenerationStore.setState({ generatingSceneId: target.id })
}

window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    req: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    calls.push({ channel, req })
    let result: unknown
    switch (channel) {
      case 'scenePresets:list': {
        const background = (req as { kind?: string } | undefined)?.kind === 'background'
        const ids = background ? [3] : [1, 2]
        result = {
          items: ids.map((id) => ({
            id,
            kind: id === 3 ? 'background' : 'scene',
            name: id === 1 ? '프리셋 A' : id === 2 ? '프리셋 B' : '배경 모음',
            defaultWidth: 832,
            defaultHeight: 1216,
            sceneCount: records.filter((s) => s.presetId === id).length
          }))
        }
        break
      }
      case 'scenes:list':
        result = {
          items: structuredClone(
            records.filter((s) => s.presetId === (req as { presetId: number }).presetId)
          )
        }
        break
      case 'scenes:reorder': {
        const { ids } = req as IpcInvokeMap['scenes:reorder']['req']
        reorders.push(ids)
        const byId = new Map(records.map((s) => [s.id, s]))
        const presetId = byId.get(ids[0])?.presetId
        records = [
          ...records.filter((s) => s.presetId !== presetId),
          ...ids.map((id) => byId.get(id)!)
        ]
        break
      }
      case 'scenes:update': {
        const { id, patch } = req as IpcInvokeMap['scenes:update']['req']
        records = records.map((s) =>
          s.id === id
            ? {
                ...s,
                ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
              }
            : s
        )
        break
      }
      case 'scenes:create': {
        const { name, presetId } = req as IpcInvokeMap['scenes:create']['req']
        const id = Math.max(...records.map((s) => s.id)) + 1
        records.push({
          ...makeScenes(presetId, id, 1, ['새'])[0],
          name,
          imageCount: 0,
          thumbnail: ''
        })
        result = { id }
        break
      }
      case 'scenes:duplicate': {
        const source = records.find((s) => s.id === (req as { id: number }).id)!
        const id = Math.max(...records.map((s) => s.id)) + 1
        records.push({
          ...structuredClone(source),
          id,
          name: `${source.name} 복제`,
          reserveCount: 0
        })
        result = { id }
        break
      }
      case 'scenes:delete':
        records = records.filter((s) => s.id !== (req as { id: number }).id)
        break
      case 'scenes:trash':
      case 'scenePresets:trash':
        result = { items: [] }
        break
      case 'settings:get':
        result = { value: localStorage.getItem(`fixture-setting-${(req as { key: string }).key}`) }
        break
      case 'settings:set':
        localStorage.setItem(
          `fixture-setting-${(req as { key: string }).key}`,
          (req as { value: string }).value
        )
        break
      case 'r2sync:getConfig':
        result = null
        break
      case 'queue:pending':
        result = { items: [], total: 0 }
        break
      default:
        throw new Error(`UI fixture blocked IPC: ${channel}`)
    }
    return result as IpcInvokeMap[C]['res']
  },
  on: () => () => undefined,
  pathForFile: () => {
    throw new Error('No filesystem in fixture')
  }
}

Object.assign(window, {
  sceneGridFixture: {
    /** 처음 상태로 — 기억된 보기·스크롤 위치를 지우고 다시 불러온다 */
    reset: () => {
      const keys = ['scene_grid_view', 'scene_grid_scroll', 'scene_columns', 'scene_orientation']
      const clear = (): void => keys.forEach((key) => localStorage.removeItem(key))
      clear()
      // 앱이 닫히기 직전에 위치를 저장하므로(beforeunload), 그 뒤에 한 번 더 지운다
      window.addEventListener('beforeunload', clear)
      location.reload()
    },
    state: () => useScenesStore.getState(),
    calls: () => calls,
    reorders: () => reorders,
    /** 프리셋의 현재 순서(씬 이름) */
    names: (presetId: number) => records.filter((s) => s.presetId === presetId).map((s) => s.name),
    ids: (presetId: number) => records.filter((s) => s.presetId === presetId).map((s) => s.id),
    setGenerating: (id: number | null) => useGenerationStore.setState({ generatingSceneId: id }),
    scrollTopOf: () =>
      document.querySelector<HTMLElement>('.no-scrollbar.overflow-y-auto.p-3')?.scrollTop ?? -1,
    /** 기억된 프리셋별 위치(localStorage 원문) */
    savedScrolls: () => localStorage.getItem('scene_grid_scroll'),
    /** 격자 안 씬 이름 바꾸기 (찾기 일치가 달라지는 상황 만들기) */
    rename: (id: number, name: string) => useScenesStore.getState().update(id, { name })
  }
})

/** 격자 밖에서 키를 받는 패널(왼쪽 프롬프트 패널·오른쪽 히스토리)을 흉내 낸 가짜 — 스크롤만 되는 긴 목록 */
function FakePanel({ testId, title }: { testId: string; title: string }): React.JSX.Element {
  return (
    <aside
      data-testid={testId}
      className="w-44 shrink-0 overflow-y-auto rounded-xl border border-line bg-surface p-2 text-[12px] text-muted"
    >
      <p className="mb-2 font-semibold text-ink">{title}</p>
      {Array.from({ length: 80 }, (_, i) => (
        <p key={i} className="py-1">
          {title} 줄 {i + 1}
        </p>
      ))}
    </aside>
  )
}

function Workspace(): React.JSX.Element {
  useEffect(() => bindShortcuts(), [])
  // ?panels=app — 실제 앱(App.tsx)과 같은 배치: 씬 화면을 감싸지 않고 줄의 직속 칸으로, 오른쪽 히스토리 240px(shrink-0).
  // 넓은 창에서 씬 화면이 줄지 않고 히스토리를 화면 밖으로 미는지 보는 용도 (?left=폭 으로 왼쪽 패널 폭)
  if (params.get('panels') === 'app')
    return (
      <main className="relative flex h-full min-h-0 gap-3 px-3 pb-3">
        <aside
          data-testid="fake-left"
          className="shrink-0 rounded-xl border border-line bg-surface"
          style={{ width: Number(params.get('left') ?? 560) }}
        />
        <SceneMode kind={kind} />
        <aside
          data-testid="fake-right"
          className="h-full w-[240px] shrink-0 overflow-hidden rounded-xl border border-line bg-surface"
        />
      </main>
    )
  if (params.get('panels') !== '1')
    return (
      <main className="flex h-full flex-col p-3">
        <SceneMode kind={kind} />
      </main>
    )
  return (
    <main className="flex h-full gap-3 p-3">
      <FakePanel testId="fake-left" title="왼쪽 패널" />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SceneMode kind={kind} />
      </div>
      <FakePanel testId="fake-right" title="히스토리" />
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <Workspace />
  </TooltipProvider>
)
