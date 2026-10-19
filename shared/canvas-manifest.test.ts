import { encodeCanvasPath } from './canvas-manifest.js'
import { describe, expect, it } from 'vitest'
import { canvasRelativePath, parseCanvasManifest } from './canvas-manifest.js'

const frame = { id: 'settings', title: 'Settings (top level)', platform: 'Mobile', src: 'Settings.html', x: 0, y: 0, focus: 1, interactive: true }
const example = {
  title: 'Settings, regrouped',
  sections: [{ id: 'regroup', title: 'Settings, regrouped', ticket: 'GIZMO-6094', status: 'ready-for-dev', frames: ['settings', 'notif', 'accounts'] }],
  frames: [frame, { id: 'notif', title: 'Notifications', src: 'Notifications.html', x: 480, y: 0 },
    { id: 'accounts', title: 'Connected accounts', src: 'Accounts.html', x: 960, y: 0, interactive: false,
      variant: { title: 'Needs attention', context: 'Connected accounts', description: "Shown when an account's token has expired" } }],
  annotations: [{ id: 'dev-outlook', kind: 'development', text: 'Outlook row opens Account details.', target: { frame: 'accounts', label: 'Outlook row' }, x: 1450, y: 250, w: 250 },
    { id: 'important', kind: 'important', title: 'Important', items: ['Daily planning moves to the top group.'], x: -30, y: -205 }],
}
describe('canvas manifest', () => {
  it('parses the Settings design example, defaults size, and ignores unknown keys', () => {
    const { manifest, errors } = parseCanvasManifest(JSON.stringify({ ...example, future: true, frames: [{ ...frame, extra: true }, ...example.frames.slice(1)] }))
    expect(errors).toEqual([])
    expect(manifest.frames[0]).toMatchObject({ ...frame, w: 390, h: 844 })
    expect(manifest).not.toHaveProperty('future')
    expect(manifest.frames[0]).not.toHaveProperty('extra')
    expect(manifest.sections[0].frames).toHaveLength(3)
    expect(manifest.annotations[0].target).toEqual({ frame: 'accounts', label: 'Outlook row' })
  })
  it('keeps an interactive note only on interactive frames', () => {
    const note = 'Supports dark mode — toggle the theme button in the menu'
    const { manifest, errors } = parseCanvasManifest({ title: 'Notes', frames: [{ ...frame, interactiveNote: note }, { ...frame, id: 'b', interactiveNote: 'x', interactive: false }, { ...frame, id: 'c', interactiveNote: 3 }] })
    expect(manifest.frames.map((f) => f.interactiveNote)).toEqual([note, undefined, undefined])
    expect(errors).toEqual(['frames[1].interactiveNote: requires interactive: true', 'frames[2].interactiveNote: must be a non-empty string'])
  })
  it.each(['../outside.html', 'frames/../../out', '/absolute', 'https://example.com', 'file:frame', 'C:\\frame', '\\outside', 'x\0.html', '%2e%2e/out', 'foo?bar', '#hash', '', './'])('rejects escaping or non-file path %j', (src) => {
    expect(canvasRelativePath(src)).toBeNull()
    expect(parseCanvasManifest({ title: 'test', frames: [{ ...frame, src }] }).errors).toContain('frames[0].src: must be a relative path inside the canvas folder')
  })
  it.each([
    ['title', { title: 3 }], ['frames', { frames: {} }], ['sections', { sections: {} }], ['annotations', { annotations: {} }],
    ['frames[0]', { frames: [null] }], ['sections[0]', { sections: [null] }], ['annotations[0]', { annotations: [null] }],
  ])('reports the readable path %s', (path, patch) => {
    expect(parseCanvasManifest({ ...example, ...patch }).errors.some((error) => error.startsWith(`${path}:`))).toBe(true)
  })
  it.each([
    ['id', ''], ['title', null], ['platform', 3], ['src', '..'], ['x', Infinity], ['y', null], ['w', 0], ['h', -1],
    ['focus', 0], ['focus', 1.5], ['interactive', 'yes'], ['variant', false],
    ['variant.title', { title: '' }], ['variant.context', { title: 'v', context: 2 }], ['variant.description', { title: 'v', description: false }],
  ])('reports invalid frame field %s', (path, value) => {
    const key = path.startsWith('variant.') ? 'variant' : path
    const result = parseCanvasManifest({ title: 'test', frames: [{ ...frame, [key]: value }] })
    expect(result.errors.some((error) => error.startsWith(`frames[0].${path}:`))).toBe(true)
  })
  it.each([['id', ''], ['title', 2], ['ticket', false], ['status', 'done'], ['frames', 1], ['frames[0]', ['absent']]])('reports invalid section field %s', (path, value) => {
    const key = path.startsWith('frames[') ? 'frames' : path
    expect(parseCanvasManifest({ ...example, sections: [{ ...example.sections[0], [key]: value }] }).errors.some((error) => error.startsWith(`sections[0].${path}:`))).toBe(true)
  })
  it.each([
    ['id', ''], ['kind', 'bad'], ['x', '1'], ['y', NaN], ['w', 0], ['title', 4], ['text', 3], ['items', 1], ['items[0]', [null]],
    ['target', false], ['target.frame', { frame: 'absent' }], ['target.frame', {}], ['target.label', { frame: 'accounts', label: 2 }],
  ])('reports invalid annotation field %s', (path, value) => {
    const key = path.startsWith('target.') ? 'target' : path.startsWith('items[') ? 'items' : path
    expect(parseCanvasManifest({ ...example, annotations: [{ ...example.annotations[0], [key]: value }] }).errors.some((error) => error.startsWith(`annotations[0].${path}:`))).toBe(true)
  })
  it('rejects duplicate ids, drops broken references, and retains valid content', () => {
    const result = parseCanvasManifest({ ...example, frames: [...example.frames, frame], sections: [{ ...example.sections[0], frames: ['settings', 'missing'] }], annotations: [{ ...example.annotations[0], target: { frame: 'missing' } }, { ...example.annotations[1], id: 'settings' }] })
    expect(result.errors).toEqual(expect.arrayContaining(['frames[3].id: duplicate id "settings"', 'annotations[1].id: duplicate id "settings"', 'sections[0].frames[1]: unknown frame "missing"', 'annotations[0].target.frame: unknown frame "missing"']))
    expect(result.manifest.frames).toHaveLength(3)
    expect(result.manifest.sections[0].frames).toEqual(['settings'])
    expect(result.manifest.annotations[0].target).toBeUndefined()
  })
  it('handles bad JSON and non-object roots', () => {
    expect(parseCanvasManifest('{').errors).toEqual(['canvas.json: must be valid JSON'])
    expect(parseCanvasManifest('[]').errors).toEqual(['canvas.json: must be an object'])
  })
})

it.each(['bad/id', 'x'.repeat(65), 'space id', '雪', ''])('rejects invalid ids in every manifest entity: %s', (id) => {
  const result = parseCanvasManifest({ title: 'Board', frames: [{ id, title: 'A', src: 'a.html', x: 0, y: 0 }],
    sections: [{ id, title: 'S', frames: [], status: 'idea' }], annotations: [{ id, kind: 'design', x: 0, y: 0 }] })
  expect(result.manifest.frames).toEqual([]); expect(result.manifest.sections).toEqual([]); expect(result.manifest.annotations).toEqual([])
  expect(result.errors.filter((error) => error.includes('.id:'))).toHaveLength(3)
})

it('encodes canvas path segments while preserving nested separators', () => {
  expect(encodeCanvasPath('folder name/雪 &.html')).toBe('folder%20name/%E9%9B%AA%20%26.html')
})
