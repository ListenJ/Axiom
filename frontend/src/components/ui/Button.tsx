import type { ButtonHTMLAttributes, ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline'
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'size'> {
  children?: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  icon?: ReactNode
  iconRight?: ReactNode
  className?: string
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] active:bg-[var(--accent-active)] shadow-[var(--shadow-sm)]',
  secondary:
    'bg-[var(--surface)] text-[var(--text)] border border-[var(--border)] hover:bg-[var(--surface-hover)] hover:border-[var(--border-hover)]',
  ghost:
    'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]',
  outline:
    'border border-[var(--border-hover)] text-[var(--text)] hover:bg-[var(--surface-hover)] hover:border-[var(--border-strong)]',
  danger:
    'bg-[var(--danger-soft)] text-[var(--danger)] hover:bg-[var(--danger)] hover:text-white',
  success:
    'bg-[var(--success-soft)] text-[var(--success)] hover:bg-[var(--success)] hover:text-white',
}

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-6 text-base gap-2',
  icon: 'h-11 w-11',
}

const ICON_SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-5',
  icon: 'size-4',
}

export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  icon,
  iconRight,
  className = '',
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading}
      className={`
        press relative inline-flex items-center justify-center
        rounded-lg font-medium touch-manipulation
        ${SIZE_CLASSES[size]}
        ${VARIANT_CLASSES[variant]}
        disabled:cursor-not-allowed disabled:opacity-50
        focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]
        ${className}
      `}
      {...rest}
    >
      {loading ? (
        <>
          <span className={`${ICON_SIZE_CLASSES[size]} animate-spin rounded-full border-2 border-current border-t-transparent`} />
          <span className="sr-only">加载中</span>
        </>
      ) : icon ? (
        <span className={ICON_SIZE_CLASSES[size]}>{icon}</span>
      ) : null}
      {children && <span>{children}</span>}
      {iconRight && !loading && (
        <span className={ICON_SIZE_CLASSES[size]}>{iconRight}</span>
      )}
    </button>
  )
}
