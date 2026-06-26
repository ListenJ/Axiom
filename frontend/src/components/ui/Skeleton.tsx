interface SkeletonProps {
  width?: string | number
  height?: string | number
  rounded?: 'none' | 'sm' | 'md' | 'full'
  className?: string
  'data-testid'?: string
}

const ROUNDED_CLASSES = {
  none: '',
  sm: 'rounded-sm',
  md: 'rounded',
  full: 'rounded-full',
} as const

export default function Skeleton({
  width = '100%',
  height = '1rem',
  rounded = 'sm',
  className = '',
  'data-testid': testId,
}: SkeletonProps) {
  return (
    <span
      role="status"
      aria-label="加载中"
      data-testid={testId}
      className={`skeleton block ${ROUNDED_CLASSES[rounded]} ${className}`}
      style={{ width, height }}
    />
  )
}
