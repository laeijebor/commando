import { describe, expect, it } from 'vitest'
import { commanderAllowedTools, commanderToolRules } from './commander-tools.js'

describe('commanderAllowedTools', () => {
  it('pre-approves only the Commander CLI for a chat in the Commander folder', () => {
    expect(commanderAllowedTools('/home/me/.commando/commander/', '/home/me')).toEqual([
      'Bash(node "/home/me/.commando/hooks/commando-agents.mjs":*)',
      'Bash(node /home/me/.commando/hooks/commando-agents.mjs:*)',
    ])
  })
  it('pre-approves nothing anywhere else', () => {
    expect(commanderAllowedTools('/home/me/project', '/home/me')).toEqual([])
    expect(commanderAllowedTools('/home/me/.commando/commander/sub', '/home/me')).toEqual([])
  })
  it('quotes the CLI path the way the instructions do', () => {
    expect(commanderToolRules('/a b/cli.mjs')[0]).toBe('Bash(node "/a b/cli.mjs":*)')
  })
})
