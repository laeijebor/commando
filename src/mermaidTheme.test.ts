import { describe, expect, it } from 'vitest'
import { mermaidThemeVariables } from './mermaidTheme'

describe('mermaidThemeVariables', () => {
  const ocean: Record<string, string> = {
    '--surface': '#0d151a', '--surface-raised': '#101920', '--surface-soft': '#142028', '--surface-hover': '#1a2731',
    '--border': '#253642', '--border-strong': '#3a5263', '--text': '#f3f7fa', '--text-soft': '#c0cdd6',
    '--muted': '#8799a6', '--accent': '#a3d9ff', '--accent-ink': '#0a141c',
  }

  it('maps the theme surfaces, borders, text and accent onto Mermaid variables', () => {
    const variables = mermaidThemeVariables((name) => ` ${ocean[name] ?? ''} `)
    expect(variables).toMatchObject({
      darkMode: true, background: '#0d151a', primaryColor: '#142028', primaryTextColor: '#f3f7fa', primaryBorderColor: '#3a5263',
      lineColor: '#8799a6', clusterBkg: '#101920', noteBorderColor: '#a3d9ff', actorBkg: '#142028', sequenceNumberColor: '#0a141c',
    })
  })

  it('falls back to the default theme for unset variables, and notices a light surface', () => {
    expect(mermaidThemeVariables(() => '')).toMatchObject({ darkMode: true, background: '#100d1a', primaryTextColor: '#f5f3fa' })
    expect(mermaidThemeVariables((name) => name === '--surface' ? '#fafafa' : '')).toMatchObject({ darkMode: false, background: '#fafafa' })
  })
})
