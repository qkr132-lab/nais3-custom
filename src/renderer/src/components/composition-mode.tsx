import { CompositionBoard } from './composition-board'

/**
 * 배치 탭 — 캐릭터 위치를 한 화면에서 통째로 짜는 페이지.
 *
 * 캐릭터 카드마다 팝오버로 좌표를 찍는 방식은 인원이 늘면 감당이 안 돼서,
 * 만화·다인 구도용으로 전용 페이지를 뒀다. 내용은 배치판 하나이므로
 * 다이얼로그판(캐릭터 창의 '배치' 버튼)과 같은 컴포넌트를 쓴다.
 */
export function CompositionMode(): React.JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 justify-center overflow-auto p-4">
      <div className="flex min-h-0 w-full max-w-[1100px] flex-col">
        <CompositionBoard />
      </div>
    </div>
  )
}
