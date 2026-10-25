import { requireOptionalNativeModule } from 'expo'
import type { PermissionResponse } from 'expo-modules-core'
import type {
  ExpoSpeechRecognitionErrorEvent,
  ExpoSpeechRecognitionOptions,
  ExpoSpeechRecognitionResultEvent,
} from 'expo-speech-recognition'

export type SpeechEvents = {
  start: () => void
  result: (event: ExpoSpeechRecognitionResultEvent) => void
  error: (event: ExpoSpeechRecognitionErrorEvent) => void
  end: () => void
}

/** The part of expo-speech-recognition's native module the composer uses. */
export interface SpeechModule {
  start(options: ExpoSpeechRecognitionOptions): void
  stop(): void
  abort(): void
  getPermissionsAsync(): Promise<PermissionResponse>
  requestPermissionsAsync(): Promise<PermissionResponse>
  addListener<K extends keyof SpeechEvents>(event: K, listener: SpeechEvents[K]): { remove(): void }
}

/**
 * Apple's speech recogniser, or null in a build made before it was added.
 * The package's own entry point throws on import when the native module is
 * missing, so it is looked up here instead and the mic is hidden without it.
 */
export const speech: SpeechModule | null = requireOptionalNativeModule<SpeechModule>('ExpoSpeechRecognition')
