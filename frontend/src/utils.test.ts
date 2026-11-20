import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  base32,
  pathMessageRef,
  phoneURL,
  relativeTimeLabel,
  syntheticThreadID,
  tellowsURL,
  threadSeed,
  timeLabel,
} from './utils'

describe('time helpers', () => {
  afterEach(() => vi.useRealTimers())

  it('formats relative times using the nearest useful unit', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T20:00:00Z'))

    expect(relativeTimeLabel('2026-11-20T19:58:00Z')).toBe(
      new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-2, 'minute'),
    )
    expect(relativeTimeLabel('2026-11-20T20:00:05Z')).toBe('just now')
    expect(relativeTimeLabel('not-a-date')).toBe('Unknown date')
  })

  it('rejects invalid absolute dates', () => {
    expect(timeLabel('not-a-date')).toBe('Unknown date')
  })
})

describe('phone and deep-link helpers', () => {
  afterEach(() => window.history.replaceState(null, '', '/'))

  it('keeps the plus sign in phone links and URL encodes tellows links', () => {
    expect(phoneURL(' +43 664 888 66060 ')).toBe('tel:+4366488866060')
    expect(tellowsURL(' +43 664 888 66060 ')).toBe('https://www.tellows.com/num/%2B4366488866060')
  })

  it('decodes thread-only and message deep links', () => {
    window.history.replaceState(null, '', '/sms/thread%20id/message%2Fid')
    expect(pathMessageRef()).toEqual({ threadId: 'thread id', messageId: 'message/id' })

    window.history.replaceState(null, '', '/sms/thread%20id')
    expect(pathMessageRef()).toEqual({ threadId: 'thread id', messageId: null })
  })
})

describe('opaque thread IDs', () => {
  it('uses the normalized sender as the thread seed', () => {
    expect(threadSeed('+43 664 888 66060')).toBe('4366488866060')
    expect(threadSeed('  StripeLink ')).toBe('stripelink')
  })

  it('encodes 12 bytes into a 20-character lowercase Base32 value', async () => {
    expect(base32(new Uint8Array(12))).toBe('00000000000000000000')

    const first = await syntheticThreadID('+43 664 888 66060')
    const equivalent = await syntheticThreadID('+43 (664) 888-66060')
    expect(first).toBe(equivalent)
    expect(first).toMatch(/^[0-9abcdefghjkmnpqrstvwxyz]{20}$/)
  })
})
