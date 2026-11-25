import {
  CloudUpload,
  Crosshair,
  Globe,
  Image,
  Images,
  LayoutGrid,
  Mountain,
  Shirt,
  Wand2,
  type LucideIcon
} from 'lucide-react'
import { motion } from 'motion/react'
import { cn } from '../lib/utils'
import { useLayoutStore, type CenterMode } from '../stores/layout-store'

const PAGES: { id: CenterMode; label: string; icon: LucideIcon }[] = [
  { id: 'main', label: '메인', icon: Image },
  { id: 'scene', label: '씬 태그', icon: LayoutGrid },
  { id: 'background', label: '배경 태그', icon: Mountain },
  { id: 'outfit', label: '복장', icon: Shirt },
  { id: 'composition', label: '배치', icon: Crosshair },
  { id: 'director', label: '디렉터', icon: Wand2 },
  { id: 'library', label: '라이브러리', icon: Images },
  { id: 'web', label: '웹', icon: Globe },
  { id: 'upload', label: '업로드', icon: CloudUpload }
]

/**
 * 상단 페이지 네비게이션 (NAIS2 AnimatedNavBar 이식).
 * - 데스크톱(compact=false): 타이틀바 중앙 플로팅 pill
 * - 세로/모바일(compact=true): 타이틀바 아래 전용 가로 스크롤 탭 바 (라벨 항상 표시 + 36px 터치 타겟)
 */
export function PageNav({ compact = false }: { compact?: boolean } = {}): React.JSX.Element {
  const centerMode = useLayoutStore((s) => s.centerMode)
  const setCenterMode = useLayoutStore((s) => s.setCenterMode)

  if (compact) {
    return (
      <nav
        aria-label="페이지 이동"
        className="no-drag flex w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-line/70 bg-surface/95 px-2 py-1 no-scrollbar"
      >
        {PAGES.map((page) => {
          const active = centerMode === page.id
          return (
            <button
              key={page.id}
              onClick={() => setCenterMode(page.id)}
              title={page.label}
              className={cn(
                'relative z-0 flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium transition-colors',
                active ? 'text-ink font-semibold' : 'text-muted hover:text-ink'
              )}
            >
              {active && (
                <motion.div
                  layoutId="pageNavActiveCompact"
                  className="absolute inset-0 -z-10 rounded-full border border-accent/30 bg-accent/15 shadow-sm"
                  transition={{ type: 'spring', bounce: 0.2, duration: 0.5 }}
                />
              )}
              <page.icon className={cn('size-4 shrink-0', active && 'text-accent')} />
              <span className="whitespace-nowrap">{page.label}</span>
            </button>
          )
        })}
      </nav>
    )
  }

  return (
    <nav className="no-drag pointer-events-auto flex items-center gap-1 rounded-full border border-line/70 bg-surface/95 p-1 shadow-md backdrop-blur max-[760px]:gap-0.5 max-[760px]:p-0.5">
      {PAGES.map((page) => {
        const active = centerMode === page.id
        return (
          <button
            key={page.id}
            onClick={() => setCenterMode(page.id)}
            title={page.label}
            className={cn(
              'relative z-0 rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors max-[1100px]:px-2.5 max-[900px]:px-2 max-[760px]:py-1',
              active ? 'text-ink' : 'text-muted hover:text-ink'
            )}
          >
            {active && (
              <motion.div
                layoutId="pageNavActive"
                className="absolute inset-0 -z-10 rounded-full border border-ink/10 bg-ink/[0.08] shadow-sm backdrop-blur-md"
                transition={{ type: 'spring', bounce: 0.2, duration: 0.6 }}
              />
            )}
            <span className="relative z-10 flex items-center gap-2">
              <page.icon className="size-4" />
              <span className="max-[900px]:hidden">{page.label}</span>
            </span>
          </button>
        )
      })}
    </nav>
  )
}
