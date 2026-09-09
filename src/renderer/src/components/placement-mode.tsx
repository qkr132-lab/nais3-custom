/** undefined is a real inherited/automatic mode, not an unchecked switch. */
export function PlacementMode({
  value,
  onChange
}: {
  value?: boolean
  onChange: (value: boolean | undefined) => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 text-[11.5px] text-muted">
      <label className="flex items-center gap-2">
        위치 적용
        <select
          aria-label="위치 적용 모드"
          className="h-8 rounded-md border border-line bg-paper px-2 text-ink outline-none focus:border-accent"
          value={value === undefined ? 'auto' : value ? 'on' : 'off'}
          onChange={(e) =>
            onChange(e.target.value === 'auto' ? undefined : e.target.value === 'on')
          }
        >
          <option value="auto">자동</option>
          <option value="on">사용</option>
          <option value="off">사용 안 함</option>
        </select>
      </label>
      <span>
        {value === undefined
          ? '자리·역할 위치 또는 큐 설정에 따름'
          : value
            ? '지정한 좌표로 생성'
            : 'AI가 위치 결정 · 태그는 유지'}
      </span>
    </div>
  )
}
