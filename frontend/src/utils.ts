export type DeepLink = {
  threadId: string
  messageId: string | null
}

export function timeLabel(raw: string) {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() <= 1) return 'Unknown date'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    hourCycle: 'h23',
  }).format(date)
}

export function relativeTimeLabel(raw: string) {
  const timestamp = new Date(raw).getTime()
  if (!Number.isFinite(timestamp)) return 'Unknown date'
  const seconds = (timestamp - Date.now()) / 1000
  if (Math.abs(seconds) < 10) return 'just now'
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ]
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  for (const [unit, unitSeconds] of units) {
    if (Math.abs(seconds) >= unitSeconds || unit === 'second') {
      return formatter.format(Math.round(seconds / unitSeconds), unit)
    }
  }
  return 'just now'
}

export function pathMessageRef(): DeepLink | null {
  const match = window.location.pathname.match(/^\/sms\/([^/?#]+)(?:\/([^/?#]+))?\/?$/)
  if (!match) return null
  try {
    const first = decodeURIComponent(match[1])
    return {
      threadId: first,
      messageId: match[2] ? decodeURIComponent(match[2]) : null,
    }
  } catch {
    return null
  }
}

export function tellowsURL(number: string) {
  const digits = number.replace(/\D/g, '')
  const normalized = number.trim().startsWith('+') ? `+${digits}` : digits
  return normalized ? `https://www.tellows.com/num/${encodeURIComponent(normalized)}` : ''
}

export function phoneURL(number: string) {
  const digits = number.replace(/\D/g, '')
  const normalized = number.trim().startsWith('+') ? `+${digits}` : digits
  return normalized ? `tel:${normalized}` : ''
}

export function threadSeed(sender: string) {
  const digits = sender.replace(/\D/g, '')
  return digits || sender.trim().toLocaleLowerCase()
}

const crockfordAlphabet = '0123456789abcdefghjkmnpqrstvwxyz'

export function base32(bytes: Uint8Array) {
  let buffer = 0
  let bits = 0
  let output = ''
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += crockfordAlphabet[(buffer >>> bits) & 31]
    }
    buffer &= bits === 0 ? 0 : (1 << bits) - 1
  }
  if (bits > 0) output += crockfordAlphabet[(buffer << (5 - bits)) & 31]
  return output
}

export async function syntheticThreadID(sender: string) {
  const input = new TextEncoder().encode(`hilink-sms-thread:v2\0${threadSeed(sender)}`)
  const digest = await crypto.subtle.digest('SHA-512', input)
  return base32(new Uint8Array(digest).slice(0, 12))
}

export function calendarDateKey(raw: string) {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return raw
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

export function calendarDateLabel(raw: string) {
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return 'Unknown date'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
}
