import { act, fireEvent, render, screen } from '@testing-library/react-native'
import type { ChatReplyImage } from '@commando/agent-chat'
import { ThemeProvider } from '../theme'
import { fitImage } from './ImageViewer'
import { Markdown } from './Markdown'

const PNG = `${'a'.repeat(64)}.png`
const SVG = `${'b'.repeat(64)}.svg`
const BASE = 'http://mac.local:4310'

async function show(text: string, images?: ChatReplyImage[], running = false) {
  render(<ThemeProvider><Markdown text={text} images={images} baseUrl={BASE} running={running} /></ThemeProvider>)
  await act(async () => undefined)
}

it('shows the images a reply stored, an SVG as the PNG the daemon draws of it, with the text around them', async () => {
  await show('Before ![Slide](/Users/me/slide.png) between ![PR diagram](<./out/my diagram.svg>) after', [
    { src: '/Users/me/slide.png', id: PNG },
    { src: './out/my diagram.svg', id: SVG },
  ])
  expect(screen.getByLabelText('Slide').props.source).toEqual({ uri: `${BASE}/chat-images/${PNG}` })
  expect(screen.getByLabelText('PR diagram').props.source).toEqual({ uri: `${BASE}/chat-images/${SVG}.png` })
  expect(screen.getByText('Before')).toBeTruthy()
  expect(screen.getByText('between')).toBeTruthy()
  expect(screen.getByText('after')).toBeTruthy()
})

it('keeps no stray line breaks around an image', async () => {
  await show('Here is the screenshot:\n![Shot](/tmp/s.png)\nAnd the diagram:', [{ src: '/tmp/s.png', id: PNG }])
  expect(screen.getByText('Here is the screenshot:')).toBeTruthy()
  expect(screen.getByText('And the diagram:')).toBeTruthy()
})

it('names an image it cannot show instead of drawing a broken one', async () => {
  await show('![Gone](~/gone.png) and ![Old](/tmp/old.png)', [{ src: '~/gone.png', error: 'missing' }])
  expect(screen.getByText('Image not found: ~/gone.png')).toBeTruthy()
  expect(screen.getByText("Image isn't available: /tmp/old.png")).toBeTruthy()
  expect(screen.queryByLabelText('Gone')).toBeNull()
})

it('waits for a streaming reply to store its image', async () => {
  await show('![Chart](/tmp/chart.png)', undefined, true)
  expect(screen.getByText('Chart')).toBeTruthy()
  expect(screen.queryByText(/isn't available/)).toBeNull()
})

it('opens an image full screen on tap, and closes it', async () => {
  await show('![Slide](/Users/me/slide.png)', [{ src: '/Users/me/slide.png', id: PNG }])
  fireEvent.press(screen.getByLabelText('Open Slide'))
  expect(screen.getByTestId('chat-image-viewer')).toBeTruthy()
  fireEvent.press(screen.getAllByRole('button', { name: 'Close image' }).at(-1)!)
  await act(async () => undefined)
  expect(screen.queryByTestId('chat-image-viewer')).toBeNull()
})

it('opens an image as large as the screen allows, keeping its shape', () => {
  expect(fitImage({ w: 1708, h: 428 }, { w: 390, h: 700 })).toEqual({ w: 390, h: 428 * (390 / 1708) })
  expect(fitImage({ w: 100, h: 400 }, { w: 390, h: 700 })).toEqual({ w: 175, h: 700 })
  expect(fitImage(null, { w: 390, h: 700 })).toEqual({ w: 390, h: 292.5 })
})
