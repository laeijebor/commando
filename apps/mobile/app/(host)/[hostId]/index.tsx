import { Redirect, useLocalSearchParams } from 'expo-router'

/** `/[hostId]` lands on the Sessions tab. */
export default function HostIndex(): React.JSX.Element {
  const { hostId } = useLocalSearchParams<{ hostId: string }>()
  return <Redirect href={{ pathname: '/(host)/[hostId]/sessions', params: { hostId } }} />
}
