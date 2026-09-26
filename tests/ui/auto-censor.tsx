import { createRoot } from 'react-dom/client'
import type { IpcEventMap, IpcInvokeMap } from '../../src/shared/types'
import {
  DEFAULT_CENSOR_OPTIONS,
  normalizeCensorOptions,
  type CensorProgress
} from '../../src/shared/censor'
import { CensorMode } from '../../src/renderer/src/components/censor-mode'
import { PageNav } from '../../src/renderer/src/components/page-nav'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { useLayoutStore } from '../../src/renderer/src/stores/layout-store'
import './placement.css'

// 자동 검열 탭 화면 검증 — 이미지·IPC는 전부 가짜 (사용자 이미지 없음)
const params = new URLSearchParams(location.search)
const runtimeProblem = params.get('runtime') === 'bad' ? '탐지 실행기를 불러오지 못했습니다 (지원하지 않는 기기)' : ''
const withGemma = params.get('gemma') !== 'none'

function fakeImage(label: string, hue: number): string {
  const c = document.createElement('canvas')
  c.width = 640
  c.height = 900
  const g = c.getContext('2d')!
  const grad = g.createLinearGradient(0, 0, 640, 900)
  grad.addColorStop(0, `hsl(${hue} 60% 55%)`)
  grad.addColorStop(1, `hsl(${hue + 60} 60% 35%)`)
  g.fillStyle = grad
  g.fillRect(0, 0, 640, 900)
  g.fillStyle = '#fff'
  g.font = '40px sans-serif'
  g.fillText(label, 40, 80)
  if (label === 'after') {
    for (let y = 380; y < 560; y += 20)
      for (let x = 240; x < 400; x += 20) {
        g.fillStyle = `hsl(${(x + y) % 360} 30% 60%)`
        g.fillRect(x, y, 20, 20)
      }
  }
  return c.toDataURL('image/jpeg')
}

let options = { ...DEFAULT_CENSOR_OPTIONS, folder: params.get('empty') ? '' : 'D:\\그림\\원본 폴더' }
const listeners: ((p: CensorProgress) => void)[] = []
let progress: CensorProgress = {
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
}
const emit = (p: Partial<CensorProgress>): void => {
  progress = { ...progress, ...p }
  listeners.forEach((l) => l(progress))
}

useLayoutStore.setState({ centerMode: 'censor' })
window.nais = {
  invoke: async <C extends keyof IpcInvokeMap>(
    channel: C,
    req: IpcInvokeMap[C]['req']
  ): Promise<IpcInvokeMap[C]['res']> => {
    let result: unknown
    switch (channel) {
      case 'censor:getOptions':
        result = { options }
        break
      case 'censor:setOptions':
        options = normalizeCensorOptions((req as { options: unknown }).options)
        break
      case 'censor:status':
        result = {
          progress,
          runtime: runtimeProblem,
          models: [
            { id: 'a', name: 'deepghs 애니 검열 탐지 v1.0 (s)', installed: false, bytes: 44586353, license: 'MIT' },
            { id: 'b', name: '01miku 애니 NSFW 분할 nano', installed: false, bytes: 5902685, license: 'MIT' }
          ],
          gemma: {
            dir: 'C:\\Users\\me\\AppData\\Roaming\\NAIS3 Custom\\gemma',
            model: withGemma ? 'gemma-4-12b.gguf' : null
          },
          outputFolder: options.folder ? `${options.folder}_검열` : ''
        }
        break
      case 'censor:pickFolder':
        result = { path: 'D:\\그림\\고른 폴더' }
        break
      case 'censor:preview':
        await new Promise((r) => setTimeout(r, 400))
        result = {
          file: 'a.webp',
          before: fakeImage('before', 200),
          after: fakeImage('after', 200),
          parts: ['vulva', 'penis'],
          boxes: 2
        }
        break
      case 'censor:start': {
        const total = 40
        emit({ running: true, phase: 'model', message: 'deepghs 받는 중', download: 0.4, outputFolder: `${options.folder}_검열` })
        let done = 0
        const tick = setInterval(() => {
          done++
          emit({
            phase: 'work',
            download: undefined,
            total,
            done,
            censored: Math.floor(done * 0.6),
            clean: done - Math.floor(done * 0.6) - (done > 30 ? 1 : 0),
            failed: done > 30 ? 1 : 0,
            current: `하위 폴더\\그림_${done}.webp`
          })
          if (done >= total) {
            clearInterval(tick)
            emit({ running: false, phase: 'done', current: '', message: '끝났습니다' })
          }
        }, 60)
        break
      }
      case 'censor:results':
        result = {
          items: [
            { file: '하위 폴더\\그림_31.webp', status: 'failed', parts: [], error: '이미지 크기를 읽지 못했습니다' }
          ]
        }
        break
      default:
        result = undefined
    }
    return result as IpcInvokeMap[C]['res']
  },
  on: <C extends keyof IpcEventMap>(channel: C, listener: (payload: IpcEventMap[C]) => void) => {
    if (channel === 'censor:progress') listeners.push(listener as (p: CensorProgress) => void)
    return () => undefined
  },
  pathForFile: () => ''
} as typeof window.nais

createRoot(document.getElementById('root')!).render(
  <TooltipProvider>
    <div className="flex h-screen flex-col bg-paper text-ink">
      <div className="flex justify-center p-2">
        <PageNav />
      </div>
      <div className="flex min-h-0 flex-1">
        <CensorMode />
      </div>
    </div>
  </TooltipProvider>
)
