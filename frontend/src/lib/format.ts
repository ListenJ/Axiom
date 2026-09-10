const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
})

const shortDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
})

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
})

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

const numberFormatter = new Intl.NumberFormat('zh-CN')

function toDate(value: number | string | Date): Date {
  return value instanceof Date ? value : new Date(value)
}

export function formatDate(value: number | string | Date): string {
  return dateFormatter.format(toDate(value))
}

export function formatShortDate(value: number | string | Date): string {
  return shortDateFormatter.format(toDate(value))
}

export function formatClockTime(value: number | string | Date): string {
  return timeFormatter.format(toDate(value))
}

export function formatDateTime(value: number | string | Date): string {
  return dateTimeFormatter.format(toDate(value))
}

export function formatNumber(value: number): string {
  return numberFormatter.format(value)
}
