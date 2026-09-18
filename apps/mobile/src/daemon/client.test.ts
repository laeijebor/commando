import { nextRequestId, retryDelay } from './client'

describe('reconnect backoff', () => {
  it('doubles from 500ms and caps at 15s', () => {
    expect(retryDelay(1)).toBe(500)
    expect(retryDelay(2)).toBe(1_000)
    expect(retryDelay(4)).toBe(4_000)
    expect(retryDelay(6)).toBe(15_000)
    expect(retryDelay(40)).toBe(15_000)
  })
})

describe('nextRequestId', () => {
  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextRequestId()))
    expect(ids.size).toBe(50)
  })
})
