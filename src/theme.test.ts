// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DEFAULT_THEME, THEMES, applyTheme, storedTheme } from './theme'

function themeColorMeta(): HTMLMetaElement {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.setAttribute('name', 'theme-color')
    document.head.append(meta)
  }
  return meta
}

beforeEach(() => {
  themeColorMeta().setAttribute('content', '#0c0a14')
})

afterEach(() => {
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
})

describe('storedTheme', () => {
  it('defaults to purple when nothing is stored', () => {
    expect(storedTheme()).toBe(DEFAULT_THEME)
  })

  it('returns the stored theme name', () => {
    window.localStorage.setItem('commando-theme', 'ocean')
    expect(storedTheme()).toBe('ocean')
  })

  it('falls back to purple on an unknown stored value', () => {
    window.localStorage.setItem('commando-theme', 'chartreuse')
    expect(storedTheme()).toBe(DEFAULT_THEME)
  })
})

describe('applyTheme', () => {
  it('sets data-theme, persists, and updates the theme-color meta', () => {
    applyTheme('emerald')
    expect(document.documentElement.dataset.theme).toBe('emerald')
    expect(window.localStorage.getItem('commando-theme')).toBe('emerald')
    const emerald = THEMES.find((theme) => theme.name === 'emerald')!
    expect(themeColorMeta().getAttribute('content')).toBe(emerald.bg)
  })

  it('clears data-theme for the default theme so :root applies', () => {
    applyTheme('rose')
    applyTheme(DEFAULT_THEME)
    expect(document.documentElement.dataset.theme).toBeUndefined()
    expect(window.localStorage.getItem('commando-theme')).toBe(DEFAULT_THEME)
    expect(themeColorMeta().getAttribute('content')).toBe('#0c0a14')
  })
})
