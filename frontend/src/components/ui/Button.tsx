import { motion, useReducedMotion, type HTMLMotionProps } from 'framer-motion'
import type { ReactNode } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'outline'
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'className' | 'size' | 'children'> {
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
    'bg-[image:var(--accent-gradient)] text-[var(--on-accent)] shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow)]',
  secondary:
    'bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]',
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

/** 与 --spring-gentle / motion/Pressable 一致的回弹参数 */
const PRESS_SPRING = { type: 'spring', stiffness: 400, damping: 17 } as const

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
  const reduceMotion = useReducedMotion()
  const interactive = !disabled && !loading && !reduceMotion
  return (
    <motion.button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading}
      whileHover={interactive ? { y: -1 } : undefined}
      whileTap={interactive ? { scale: 0.97 } : undefined}
      transition={PRESS_SPRING}
      className={`
        relative inline-flex items-center justify-center
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
    </motion.button>
  )
}
