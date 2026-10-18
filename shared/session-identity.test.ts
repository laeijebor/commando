// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { assignSessionIdentities, deriveSessionIdentity, isSessionGlyph, MAX_SESSION_IDENTITIES, normalizeSessionIdentities, SESSION_ANIMALS, SESSION_COLORS, sessionAvatarSvg } from './session-identity.js'

describe('session identity', () => {
  it('is deterministic and uses the fixed palette', () => {
    expect(deriveSessionIdentity('Subscriptions')).toEqual(deriveSessionIdentity('Subscriptions'))
    expect(SESSION_COLORS).toContain(deriveSessionIdentity('Subscriptions').color)
    expect(deriveSessionIdentity('xylophone')).toEqual(deriveSessionIdentity('xylophone'))
  })
  it.each([
    ['Subscriptions', '💷'], ['Stripe billing', '💷'], ['Battery usage', '🔋'], ['Chat', '💬'], ['Simplify LHN', '🧹'],
    ['ci', '🚦'], ['Github rate limits', '⏱️'], ['rate limits', '⏱️'], ['release', '🚀'], ['e2e', '🧪'],
    ['fix crash', '🐛'], ['UI', '🎨'], ['docs', '📚'], ['landing', '🛬'], ['simulator', '📱'], ['cpu', '📈'],
    ['login', '🔐'], ['PostHog', '📊'], ['realtime', '📡'], ['cards', '🃏'], ['flags', '🚩'],
    ['cost', '💸'], ['costs', '💸'], ['billing-cost', '💸'], ['DO Costs', '💸'],
    ['Canvas', '🖼️'], ['Aura', '✨'], ['failure', '🚨'], ['fail', '🚨'], ['broken', '🚨'], ['CI failures', '🚨'],
    ['bug', '🐛'], ['crash', '🐛'], ['bot', '🤖'], ['bots', '🤖'], ['agent bots', '🤖'],
    ['admin', '🛡️'], ['permission', '🛡️'], ['permissions', '🛡️'], ['Admin permissions', '🛡️'], ['admin auth', '🛡️'],
    ['smoke', '🧪'], ['Smoke tests', '🧪'], ['concurrency', '🔀'], ['concurrent', '🔀'], ['parallel workers', '🔀'],
    ['reporting', '📊'], ['report', '📊'], ['nutrition', '🥗'], ['food', '🥗'], ['meal planning', '🥗'],
    ['subscription', '💷'], ['landing page', '🛬'], ['database migrations', '🗄️'], ['cache', '🧊'],
    ['git worktrees', '🌿'], ['Docker containers', '🐳'], ['xyzzy canvas xyzzy', '🖼️'], ['xyzzy food xyzzy', '🥗'],
  ])('matches words and stems in %s', (name, glyph) => expect(deriveSessionIdentity(name).glyph).toBe(glyph))
  it('does not match ci or ui within unrelated words', () => {
    expect(deriveSessionIdentity('circuit').glyph).not.toBe('🚦')
    expect(deriveSessionIdentity('buildings').glyph).not.toBe('🎨')
  })
  it('probes collisions and preserves assigned identities independent of input order', () => {
    const first = deriveSessionIdentity('work')
    const probed = deriveSessionIdentity('work', [first.codename])
    expect(probed.codename).not.toBe(first.codename)
    expect(probed.glyph).toBe(first.glyph)
    const names = Array.from({ length: 500 }, (_, index) => `session-${index}`)
    const assigned = assignSessionIdentities({}, names)
    expect(new Set(Object.values(assigned).map((identity) => identity.codename)).size).toBe(500)
    expect(assignSessionIdentities({}, names.reverse())).toEqual(assigned)
    expect(assignSessionIdentities(assigned, ['work'])['session-1']).toEqual(assigned['session-1'])
  })
  it.each(['💬', '⏱️', '👩🏽‍💻', '🇬🇧', '1️⃣', '👨‍👩‍👧‍👦', '🏳️‍🌈'])('accepts one emoji grapheme %s', (glyph) => expect(isSessionGlyph(glyph)).toBe(true))
  it.each(['', 'a', '1', '💬🐛', ' 💬', '💬 ', '<svg/>', '\n', '🇬'])('rejects invalid glyph %s', (glyph) => expect(isSessionGlyph(glyph)).toBe(false))
  it('drops invalid entries and fields and caps the map', () => {
    const identity = deriveSessionIdentity('work')
    expect(normalizeSessionIdentities({ good: { ...identity, unknown: true }, bad: { ...identity, glyph: 'abc' }, invalid: { ...identity, color: '#000000' }, animal: { ...identity, codename: 'Amber Dragon' } })).toEqual({ good: identity })
    const map = Object.fromEntries(Array.from({ length: 600 }, (_, index) => [`name-${index}`, identity]))
    expect(Object.keys(normalizeSessionIdentities(map))).toHaveLength(MAX_SESSION_IDENTITIES)
    expect(Object.keys(assignSessionIdentities(normalizeSessionIdentities(map), ['new']))).toHaveLength(MAX_SESSION_IDENTITIES)
    expect(assignSessionIdentities(normalizeSessionIdentities(map), ['new']).new).toBeDefined()
  })
  it('treats prototype names as ordinary keys', () => {
    const identities = assignSessionIdentities({}, ['__proto__', 'constructor'])
    expect(Object.hasOwn(identities, '__proto__')).toBe(true)
    expect(normalizeSessionIdentities(identities)).toEqual(identities)
  })
})

describe('sessionAvatarSvg', () => {
  it('keeps at least twenty drawable animals available for generated codenames', () => {
    expect(SESSION_ANIMALS.length).toBeGreaterThanOrEqual(20)
    const identities = assignSessionIdentities({}, Array.from({ length: 500 }, (_, index) => `work-${index}`))
    for (const identity of Object.values(identities)) {
      expect(SESSION_ANIMALS).toContain(identity.codename.split(' ').at(-1))
    }
    expect(normalizeSessionIdentities(identities)).toEqual(identities)
  })
  it.each(SESSION_ANIMALS.flatMap((animal) => [18, 56].map((size) => [animal, size] as const)))('renders a well-formed distinctive %s avatar at %i px containing the color', (animal, size) => {
    const identity = { ...deriveSessionIdentity('work'), codename: `Amber ${animal}` }
    const svg = sessionAvatarSvg(identity, size)
    const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
    expect(parsed.querySelector('parsererror')).toBeNull()
    expect(parsed.documentElement.tagName).toBe('svg')
    expect(parsed.documentElement.getAttribute('width')).toBe(String(size))
    expect(svg).toContain(identity.color)
    expect(parsed.querySelector('g')).not.toBeNull()
    expect(parsed.querySelector('text')).toBeNull()
  })
  it('has a distinct mark per animal and safely falls back to the glyph', () => {
    const identity = deriveSessionIdentity('work')
    const marks = SESSION_ANIMALS.map((animal) => new DOMParser().parseFromString(sessionAvatarSvg({ ...identity, codename: `Amber ${animal}` }), 'image/svg+xml').querySelector('g')!.innerHTML)
    expect(new Set(marks).size).toBe(SESSION_ANIMALS.length)
    const fallback = sessionAvatarSvg({ ...identity, codename: 'Amber Missing', glyph: '<script>' })
    const parsed = new DOMParser().parseFromString(fallback, 'image/svg+xml')
    expect(parsed.querySelector('script')).toBeNull()
    expect(parsed.querySelector('text')?.textContent).toBe('<script>')
  })
})
