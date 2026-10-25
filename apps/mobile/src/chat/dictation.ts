import { useEffect, useRef, useState } from 'react'
import * as Haptics from 'expo-haptics'
import type { ExpoSpeechRecognitionErrorEvent } from 'expo-speech-recognition'

import { speech } from './speech'

/** A press shorter than this that heard nothing was a tap, so the mic says to hold it. */
export const DICTATION_TAP_MS = 400

export const DICTATION_HINT_HOLD = 'Hold the mic to talk'
export const DICTATION_HINT_SILENT = "Didn't hear anything"
export const DICTATION_DENIED = 'Allow Microphone and Speech Recognition for Commando in Settings to talk'

/**
 * Puts what was said in place of the selection, with a space either side
 * where the neighbouring text needs one, and the caret after it.
 */
export function spliceDictation(text: string, at: { start: number; end: number }, spoken: string): { text: string; cursor: number } {
  const said = spoken.trim()
  const before = text.slice(0, at.start)
  const after = text.slice(at.end)
  if (!said) return { text, cursor: at.end }
  const lead = before && !/\s$/.test(before) ? ' ' : ''
  const trail = after && !/^\s/.test(after) ? ' ' : ''
  return { text: before + lead + said + trail + after, cursor: before.length + lead.length + said.length }
}

/** What to tell the owner about a recogniser error, or null for the ones that need no message. */
export function dictationError(event: Pick<ExpoSpeechRecognitionErrorEvent, 'error' | 'message'>): string | null {
  switch (event.error) {
    case 'aborted':
    case 'no-speech':
    case 'speech-timeout':
      return null
    case 'not-allowed':
      return DICTATION_DENIED
    case 'language-not-supported':
      return "Speech recognition doesn't support this phone's language"
    case 'network':
      return 'Dictation needs a connection to Apple and lost it'
    case 'interrupted':
      return 'Dictation stopped for a call or Siri'
    default:
      return `Dictation stopped: ${event.message || event.error}`
  }
}

/** The phone's own language, which the recogniser defaults to US English without. */
function deviceLanguage(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined
  } catch {
    return undefined
  }
}

type Take = { finished: string; heard: boolean; pressedAt: number; started: boolean }

/**
 * Press-and-hold dictation through Apple's speech recogniser. `begin` on
 * press, `end` on release; the transcript so far streams to `onTranscript`
 * as words are recognised, and the final words arrive just after release.
 */
export function useDictation(handlers: {
  onTranscript: (text: string) => void
  onError: (message: string) => void
  onHint: (message: string) => void
}): { available: boolean; listening: boolean; begin: () => void; end: () => void } {
  const [listening, setListening] = useState(false)
  const take = useRef<Take | null>(null)
  const held = useRef(false)
  const latest = useRef(handlers)
  latest.current = handlers

  const finish = (hint?: string) => {
    const done = take.current
    take.current = null
    setListening(false)
    if (!done) return
    if (hint) latest.current.onHint(hint)
    else if (!done.heard) latest.current.onHint(Date.now() - done.pressedAt < DICTATION_TAP_MS ? DICTATION_HINT_HOLD : DICTATION_HINT_SILENT)
  }

  useEffect(() => {
    if (!speech) return
    const subscriptions = [
      speech.addListener('start', () => {
        if (take.current) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
      }),
      speech.addListener('result', (event) => {
        const current = take.current
        if (!current) return
        // Each final result closes a phrase; what follows is the next phrase's partial.
        const said = current.finished + (event.results[0]?.transcript ?? '')
        if (event.isFinal) current.finished = said
        if (!said.trim()) return
        current.heard = true
        latest.current.onTranscript(said)
      }),
      speech.addListener('error', (event) => {
        if (!take.current) return
        const message = dictationError(event)
        if (message) {
          latest.current.onError(message)
          // The error is the message; no hint on top of it.
          take.current.heard = true
        }
      }),
      speech.addListener('end', () => {
        if (!take.current) return
        void Haptics.selectionAsync()
        finish()
      }),
    ]
    return () => {
      for (const subscription of subscriptions) subscription.remove()
      if (take.current?.started) speech?.abort()
      take.current = null
    }
    // The listeners read the latest handlers through a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const begin = () => {
    if (!speech || take.current) return
    const current: Take = { finished: '', heard: false, pressedAt: Date.now(), started: false }
    take.current = current
    held.current = true
    setListening(true)
    void (async () => {
      try {
        let permission = await speech.getPermissionsAsync()
        // The first time, iOS asks; the prompt ends the press, so the owner holds again after.
        if (!permission.granted && permission.canAskAgain) permission = await speech.requestPermissionsAsync()
        if (take.current !== current) return
        if (!permission.granted) {
          latest.current.onError(DICTATION_DENIED)
          current.heard = true
          finish()
          return
        }
        if (!held.current) {
          finish(DICTATION_HINT_HOLD)
          return
        }
        speech.start({ lang: deviceLanguage(), interimResults: true, continuous: true, addsPunctuation: true, iosTaskHint: 'dictation' })
        current.started = true
      } catch (error) {
        if (take.current !== current) return
        latest.current.onError(`Dictation didn't start: ${error instanceof Error ? error.message : String(error)}`)
        current.heard = true
        finish()
      }
    })()
  }

  const end = () => {
    held.current = false
    // Not started yet: begin sees the release and stops there. Started: the last words arrive, then `end`.
    if (take.current?.started) speech?.stop()
  }

  return { available: Boolean(speech), listening, begin, end }
}
