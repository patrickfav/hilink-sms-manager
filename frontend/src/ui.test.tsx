import { describe, expect, it } from 'vitest'
import { detectOTP } from './ui'

describe('detectOTP', () => {
  it('extracts a code near verification wording', () => {
    expect(detectOTP('Your verification code is 482913.')).toBe('482913')
    expect(detectOTP('Ihr Sicherheitscode lautet 482913.')).toBe('482913')
    expect(detectOTP('Ihr Verifizierungscode lautet 482913.')).toBe('482913')
    expect(detectOTP('Your code is 1234')).toBe('1234')
  })

  it('accepts a standalone six digit code and ignores other numbers', () => {
    expect(detectOTP('Code: 843201')).toBe('843201')
    expect(detectOTP('Your balance is 1234 dollars')).toBeNull()
  })
})
