import { act, render, screen } from '@testing-library/react-native'
import { ThemeProvider, THEMES } from '../theme'
import { Markdown } from './Markdown'
it('keeps completed tasks muted and checked without a strike, preserving ordinary Markdown deletion', async () => {
  render(<ThemeProvider><Markdown text={'- [x] Done task\n- [x] ~~Finished edit~~\n- [ ] Next task\n\n~~Old idea~~'} /></ThemeProvider>)
  await act(async () => undefined)
  expect(screen.getByText('Done task')).toHaveStyle({ color: THEMES.purple.muted })
  expect(screen.getByText('Finished edit')).not.toHaveStyle({ textDecorationLine: 'line-through' })
  expect(screen.getAllByText('✓')).toHaveLength(2)
  expect(screen.getAllByText('✓')[0]).toHaveStyle({ color: THEMES.purple.green })
  expect(screen.getByText('Old idea')).toHaveStyle({ textDecorationLine: 'line-through' })
})
