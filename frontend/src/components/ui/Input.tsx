import { useId } from 'react'
import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes, SelectHTMLAttributes } from 'react'

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string
  hint?: string
  error?: string
  iconLeft?: ReactNode
  iconRight?: ReactNode
  className?: string
}

export function Input({ label, hint, error, iconLeft, iconRight, className = '', ...rest }: InputProps) {
  const hintId = useId()
  const describedBy = (error || hint) ? hintId : undefined
  return (
    <label className={`block ${className}`}>
      {label && (
        <span className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
          {label}
        </span>
      )}
      <span className="relative block">
        {iconLeft && (
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[var(--text-muted)]">
            {iconLeft}
          </span>
        )}
        <input
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          className={`
            w-full h-10 rounded-lg border bg-[var(--bg)] px-3 text-sm text-[var(--text)]
            placeholder:text-[var(--text-muted)]
            transition-colors duration-200
            focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]
            ${error ? 'border-[var(--danger)]' : 'border-[var(--border)] hover:border-[var(--border-hover)]'}
            ${iconLeft ? 'pl-9' : ''}
            ${iconRight ? 'pr-9' : ''}
          `}
          {...rest}
        />
        {iconRight && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[var(--text-muted)]">
            {iconRight}
          </span>
        )}
      </span>
      {(error || hint) && (
        <span id={hintId} className={`mt-1 block text-xs ${error ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
          {error || hint}
        </span>
      )}
    </label>
  )
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: string
  error?: string
  className?: string
}

export function Textarea({ label, hint, error, className = '', ...rest }: TextareaProps) {
  const hintId = useId()
  const describedBy = (error || hint) ? hintId : undefined
  return (
    <label className={`block ${className}`}>
      {label && (
        <span className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
          {label}
        </span>
      )}
      <textarea
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={`
          w-full rounded-lg border bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]
          placeholder:text-[var(--text-muted)]
          transition-colors duration-200
          focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]
          ${error ? 'border-[var(--danger)]' : 'border-[var(--border)] hover:border-[var(--border-hover)]'}
        `}
        {...rest}
      />
      {(error || hint) && (
        <span id={hintId} className={`mt-1 block text-xs ${error ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
          {error || hint}
        </span>
      )}
    </label>
  )
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  hint?: string
  error?: string
  children: ReactNode
  className?: string
}

export function Select({ label, hint, error, children, className = '', ...rest }: SelectProps) {
  const hintId = useId()
  const describedBy = (error || hint) ? hintId : undefined
  return (
    <label className={`block ${className}`}>
      {label && (
        <span className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]">
          {label}
        </span>
      )}
      <select
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        className={`
          w-full h-10 rounded-lg border bg-[var(--bg)] px-3 text-sm text-[var(--text)]
          transition-colors duration-200
          focus:outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]
          ${error ? 'border-[var(--danger)]' : 'border-[var(--border)] hover:border-[var(--border-hover)]'}
        `}
        {...rest}
      >
        {children}
      </select>
      {(error || hint) && (
        <span id={hintId} className={`mt-1 block text-xs ${error ? 'text-[var(--danger)]' : 'text-[var(--text-muted)]'}`}>
          {error || hint}
        </span>
      )}
    </label>
  )
}
