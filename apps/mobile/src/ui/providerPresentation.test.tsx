import { act, render, screen } from '@testing-library/react-native'
import { buildSessionTree } from '../agents/selectors'
import { NEEDS_INPUT_STATUS, SNAPSHOT } from '../testing/fixtures'
import { ThemeProvider } from '../theme'
import { ProviderPill } from './primitives'
import { SessionTree } from './SessionTree'

jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({ hostId: 'host-1' }), useRouter: () => ({ push: jest.fn() }) }))

it('renders the Cursor pill and CU pane initials with a dedicated provider tone', async () => {
  const groups = buildSessionTree(SNAPSHOT, { '%14': { ...NEEDS_INPUT_STATUS, provider: 'cursor' } })
  render(<ThemeProvider><ProviderPill provider="cursor" /><SessionTree groups={groups} selectedPaneId="%14" /></ThemeProvider>)
  await act(async () => undefined)
  expect(screen.getByText('Cursor')).toBeTruthy()
  expect(screen.getByText('CU')).toBeTruthy()
})
