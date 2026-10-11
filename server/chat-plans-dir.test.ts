import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chatPlansDir, isChatPlanDir } from './chat-plans-dir.js'

describe('stashed plan folders', () => {
  const env = { COMMANDO_CHAT_PLANS_DIR: '/state/chat-plans' }
  const folder = 'a'.repeat(32)

  it("accepts one plan's own folder and nothing else", () => {
    expect(chatPlansDir(env)).toBe('/state/chat-plans')
    expect(isChatPlanDir(`/state/chat-plans/${folder}`, env)).toBe(true)
    // The plans folder itself would expose every other chat's plan.
    expect(isChatPlanDir('/state/chat-plans', env)).toBe(false)
    expect(isChatPlanDir(`/state/chat-plans/${folder}/nested`, env)).toBe(false)
    expect(isChatPlanDir(`/state/chat-plans/${folder}/..`, env)).toBe(false)
    expect(isChatPlanDir(`/state/chat-plans/../chat-plans/${folder}`, env)).toBe(false)
    expect(isChatPlanDir(`/state/chat-plans/${folder}/`, env)).toBe(false)
    expect(isChatPlanDir(`chat-plans/${folder}`, env)).toBe(false)
    expect(isChatPlanDir(`/elsewhere/${folder}`, env)).toBe(false)
    expect(isChatPlanDir('/state/chat-plans/not-a-plan-folder', env)).toBe(false)
    expect(isChatPlanDir(undefined, env)).toBe(false)
    expect(isChatPlanDir(join(chatPlansDir({}), folder), {})).toBe(true)
  })
})
