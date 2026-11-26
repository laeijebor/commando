import { describe, expect, it } from 'vitest'
import { isReportBackTaskStatus, REPORT_BACK_TASK_STATUSES } from './report-back.js'

describe('shared/report-back', () => {
  it('accepts every defined task status', () => {
    for (const status of REPORT_BACK_TASK_STATUSES) {
      expect(isReportBackTaskStatus(status)).toBe(true)
    }
  })

  it('rejects unknown or non-string statuses', () => {
    expect(isReportBackTaskStatus('pending')).toBe(false)
    expect(isReportBackTaskStatus('RUNNING')).toBe(false)
    expect(isReportBackTaskStatus('')).toBe(false)
    expect(isReportBackTaskStatus(null)).toBe(false)
    expect(isReportBackTaskStatus(42)).toBe(false)
  })
})
