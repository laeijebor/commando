import { useEffect, useMemo, useRef, useState } from 'react'
import * as Haptics from 'expo-haptics'
import type { ExpoSpeechRecognitionErrorEvent } from 'expo-speech-recognition'

import { speech, type SpeechModule } from './speech'

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

/**
 * The recogniser locale for the phone's locale. The phone's can mix a
 * language with another region (en-DE, fr-GB) that Apple has no recogniser
 * for, so it falls back to the language's home region, then any region of
 * the language; undefined leaves the recogniser on its US English default.
 */
export function pickSpeechLocale(device: string | undefined, supported: readonly string[]): string | undefined {
  if (!device) return undefined
  const wanted = device.replace(/_/g, '-')
  const byKey = new Map(supported.map((locale) => [locale.replace(/_/g, '-').toLowerCase(), locale]))
  const exact = byKey.get(wanted.toLowerCase())
  if (exact) return exact
  const language = wanted.split('-')[0]!.toLowerCase()
  const home = byKey.get(`${language}-${language === 'en' ? 'us' : language}`)
  if (home) return home
  return [...byKey.entries()].filter(([key]) => key.split('-')[0] === language).sort(([a], [b]) => a.localeCompare(b))[0]?.[1]
}

function deviceLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || undefined
  } catch {
    return undefined
  }
}

let speechLocale: Promise<string | undefined> | null = null
function speechLanguage(module: SpeechModule): Promise<string | undefined> {
  speechLocale ??= module.getSupportedLocales({})
    .then(({ locales }) => pickSpeechLocale(deviceLocale(), locales))
    .catch(() => undefined)
  return speechLocale
}

type Take = {
  /** The transcript of the phrases the recogniser has closed. */
  finished: string
  heard: boolean
  pressedAt: number
  releasedAt: number | null
  /** `start` was called on the recogniser. */
  started: boolean
  /** The recogniser said it started; until then a stop has to wait, or it misses the task. */
  live: boolean
  waiting: 'stop' | 'abort' | null
  cancelled: boolean
}

type Handlers = {
  /** A take is starting: what is said replaces the composer's selection as it is now. */
  onBegin: () => void
  onTranscript: (text: string) => void
  onError: (message: string) => void
  onHint: (message: string) => void
}

/**
 * Press-and-hold dictation through Apple's speech recogniser. `begin` on
 * press, `end` on release, `cancel` when the mic goes away mid-hold. The
 * transcript so far streams to `onTranscript` as words are recognised, and
 * the final words arrive just after release.
 */
export function useDictation(handlers: Handlers): { available: boolean; listening: boolean; begin: () => void; end: () => void; cancel: () => void } {
  const [listening, setListening] = useState(false)
  const latest = useRef(handlers)
  latest.current = handlers

  // Everything below reads refs, so it is made once and the listeners never go stale.
  const dictation = useMemo(() => {
    let take: Take | null = null
    let held = false
    /** Pressed again while the last take was still finishing: this take starts when that one ends. */
    let pressedAgain = false

    const finish = (hint?: string) => {
      const done = take
      take = null
      if (done && !done.cancelled && pressedAgain && held) {
        pressedAgain = false
        open()
        return
      }
      pressedAgain = false
      setListening(false)
      if (!done || done.cancelled) return
      if (hint) latest.current.onHint(hint)
      else if (!done.heard) {
        const quick = done.releasedAt !== null && done.releasedAt - done.pressedAt < DICTATION_TAP_MS
        latest.current.onHint(quick ? DICTATION_HINT_HOLD : DICTATION_HINT_SILENT)
      }
    }

    const fail = (current: Take, message: string) => {
      latest.current.onError(message)
      current.heard = true
      finish()
    }

    const open = () => {
      if (!speech) return
      const module = speech
      const current: Take = { finished: '', heard: false, pressedAt: Date.now(), releasedAt: null, started: false, live: false, waiting: null, cancelled: false }
      take = current
      setListening(true)
      latest.current.onBegin()
      void (async () => {
        try {
          let permission = await module.getPermissionsAsync()
          // The first time, iOS asks; the prompt ends the press, so the owner holds again after.
          if (!permission.granted && permission.canAskAgain) permission = await module.requestPermissionsAsync()
          if (take !== current) return
          if (!permission.granted) return fail(current, DICTATION_DENIED)
          const lang = current.releasedAt === null ? await speechLanguage(module) : undefined
          if (take !== current) return
          // Let go (or cancelled) before the recogniser was asked to start: nothing to stop.
          if (current.releasedAt !== null) return finish(DICTATION_HINT_HOLD)
          module.start({ lang, interimResults: true, continuous: true, addsPunctuation: true, iosTaskHint: 'dictation' })
          current.started = true
        } catch (error) {
          if (take === current) fail(current, `Dictation didn't start: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    }

    const release = (how: 'stop' | 'abort') => {
      held = false
      pressedAgain = false
      const current = take
      if (!current) return
      // A cancel also cuts short a take that is already finishing.
      if (how === 'abort') current.cancelled = true
      else if (current.releasedAt !== null) return
      current.releasedAt ??= Date.now()
      if (current.live) speech?.[how]()
      else if (current.started) current.waiting = how
      // Not started yet: open() sees the release and stops there.
    }

    return {
      begin: () => {
        if (!speech) return
        held = true
        if (take) pressedAgain = true
        else open()
      },
      end: () => release('stop'),
      cancel: () => release('abort'),
      listen: (module: SpeechModule) => [
        module.addListener('start', () => {
          if (!take) return
          take.live = true
          if (take.waiting) module[take.waiting]()
          else void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
        }),
        module.addListener('result', (event) => {
          const current = take
          if (!current || current.cancelled) return
          // Each final result closes a phrase; what follows is the next phrase's partial.
          const said = current.finished + (event.results[0]?.transcript ?? '')
          if (event.isFinal) current.finished = said
          if (!said.trim()) return
          current.heard = true
          latest.current.onTranscript(said)
        }),
        module.addListener('error', (event) => {
          if (!take || take.cancelled) return
          const message = dictationError(event)
          if (!message) return
          latest.current.onError(message)
          take.heard = true
        }),
        module.addListener('end', () => {
          if (!take) return
          if (!take.cancelled) void Haptics.selectionAsync()
          finish()
        }),
      ],
      unmount: () => {
        if (take?.started) speech?.abort()
        take = null
      },
    }
  }, [])

  useEffect(() => {
    if (!speech) return
    const subscriptions = dictation.listen(speech)
    return () => {
      for (const subscription of subscriptions) subscription.remove()
      dictation.unmount()
    }
  }, [dictation])

  return { available: Boolean(speech), listening, begin: dictation.begin, end: dictation.end, cancel: dictation.cancel }
}
