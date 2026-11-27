import type { AgentUsage, TokenUsage } from '@cursor/sdk'
import type { ChatSessionUsage } from '../../../shared/agent-chat.js'
import { record } from './items.js'

interface TokenTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
}

interface CostTotals {
  chargedCents?: number
  rawCostCents?: number
}

function emptyTokens(): TokenTotals {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function normalizeTokens(raw: unknown): TokenTotals | null {
  const obj = record(raw)
  const inputTokens = nonNegativeFinite(obj.inputTokens)
  const outputTokens = nonNegativeFinite(obj.outputTokens)
  if (inputTokens === undefined || outputTokens === undefined) return null
  const cacheReadTokens = nonNegativeFinite(obj.cacheReadTokens) ?? 0
  const cacheWriteTokens = nonNegativeFinite(obj.cacheWriteTokens) ?? 0
  const reasoningTokens = nonNegativeFinite(obj.reasoningTokens) ?? 0
  // Per @cursor/sdk, totalTokens excludes reasoningTokens (a subset of outputTokens).
  const totalTokens = nonNegativeFinite(obj.totalTokens) ?? (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens)
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens }
}

function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

function normalizeCost(raw: unknown): CostTotals | undefined {
  const obj = record(raw)
  const chargedCents = nonNegativeFinite(obj.chargedCents)
  const rawCostCents = nonNegativeFinite(obj.rawCostCents)
  if (chargedCents === undefined && rawCostCents === undefined) return undefined
  return {
    ...(chargedCents !== undefined ? { chargedCents } : {}),
    ...(rawCostCents !== undefined ? { rawCostCents } : {}),
  }
}

function toSessionUsage(tokens: TokenTotals, cost: CostTotals | undefined, updatedAt: number): ChatSessionUsage | null {
  if (tokens.totalTokens <= 0) return null
  return {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    ...(tokens.cacheReadTokens > 0 ? { cacheReadTokens: tokens.cacheReadTokens } : {}),
    ...(tokens.cacheWriteTokens > 0 ? { cacheWriteTokens: tokens.cacheWriteTokens } : {}),
    ...(tokens.reasoningTokens > 0 ? { reasoningTokens: tokens.reasoningTokens } : {}),
    totalTokens: tokens.totalTokens,
    ...(cost?.chargedCents !== undefined ? { chargedCents: cost.chargedCents } : {}),
    ...(cost?.rawCostCents !== undefined ? { rawCostCents: cost.rawCostCents } : {}),
    updatedAt,
  }
}

/**
 * Tracks cumulative Cursor session tokens and server-reported billed cost across
 * runs without double-counting `turn-ended` deltas and `RunResult.usage`.
 */
export class CursorUsageTracker {
  private base: TokenTotals = emptyTokens()
  private inFlight: TokenTotals = emptyTokens()
  private hasInFlight = false
  private cost?: CostTotals

  constructor(private readonly now: () => number = Date.now) {}

  beginRun(): void {
    this.inFlight = emptyTokens()
    this.hasInFlight = false
  }

  /** Accumulates a `turn-ended` delta payload during the active run. */
  recordTurnDelta(rawUsage: unknown): ChatSessionUsage | null {
    const delta = normalizeTokens(rawUsage)
    if (!delta || delta.totalTokens <= 0) return null
    this.inFlight = addTokens(this.inFlight, delta)
    this.hasInFlight = true
    return toSessionUsage(addTokens(this.base, this.inFlight), this.cost, this.now())
  }

  /**
   * Finalizes the active run. Prefers `resultUsage` when present so a run's
   * `turn-ended` deltas and final `RunResult.usage` are never double-counted.
   */
  finishRun(resultUsage?: TokenUsage): ChatSessionUsage | null {
    const final = normalizeTokens(resultUsage)
    if (final && final.totalTokens > 0) {
      this.base = addTokens(this.base, final)
    } else if (this.hasInFlight) {
      this.base = addTokens(this.base, this.inFlight)
    } else {
      return null
    }
    this.inFlight = emptyTokens()
    this.hasInFlight = false
    return toSessionUsage(this.base, this.cost, this.now())
  }

  /** Commits any `turn-ended` deltas seen before a run aborted or threw. */
  commitInFlight(): ChatSessionUsage | null {
    if (!this.hasInFlight) return null
    this.base = addTokens(this.base, this.inFlight)
    this.inFlight = emptyTokens()
    this.hasInFlight = false
    return toSessionUsage(this.base, this.cost, this.now())
  }

  /** Applies authoritative server totals and optional cost from `agent.getUsage()`. */
  applyServerUsage(agentUsage: AgentUsage): ChatSessionUsage | null {
    const serverTokens = normalizeTokens(agentUsage.usage)
    if (serverTokens && serverTokens.totalTokens > 0) {
      this.base = serverTokens
    }
    const serverCost = normalizeCost(agentUsage.cost)
    if (serverCost) this.cost = serverCost
    const combined = this.hasInFlight ? addTokens(this.base, this.inFlight) : this.base
    return toSessionUsage(combined, this.cost, this.now())
  }

  reset(): void {
    this.base = emptyTokens()
    this.inFlight = emptyTokens()
    this.hasInFlight = false
    this.cost = undefined
  }
}
