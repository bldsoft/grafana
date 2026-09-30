import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Voice input for the chat composer via the browser's Web Speech API
 * (Chrome, Edge, Safari; not Firefox). No audio passes through Analytix or the
 * AI Insider service — the browser transcribes (Chrome does it on its own
 * speech servers) and only the resulting text lands in the composer.
 */

// lib.dom ships the result types but not the recognizer itself (it is still
// prefixed in Chrome/Safari); this is the subset the hook uses.
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

function recognitionCtor(): SpeechRecognitionCtor | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

function toSpeechInputError(error: string): SpeechInputError {
  switch (error) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'not-allowed';
    case 'audio-capture':
    case 'network':
      return error;
    default:
      return 'other';
  }
}

/** Joins the text typed before dictation with the transcript. Exported for tests. */
export function joinDictation(prefix: string, transcript: string): string {
  const spoken = transcript.trim();
  if (spoken === '') {
    return prefix;
  }
  return prefix === '' || /\s$/.test(prefix) ? prefix + spoken : `${prefix} ${spoken}`;
}

/** Errors worth telling the user about; "no-speech" / "aborted" just end the session. */
export type SpeechInputError = 'not-allowed' | 'audio-capture' | 'network' | 'other';

interface Options {
  /** Receives the full composer text (typed prefix + transcript so far) on every update. */
  onText: (text: string) => void;
  onError: (error: SpeechInputError) => void;
}

export function useSpeechInput({ onText, onError }: Options) {
  const [supported] = useState(() => Boolean(recognitionCtor()));
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  // Latest callbacks without re-creating a running recognizer on every render.
  const callbacksRef = useRef({ onText, onError });
  callbacksRef.current = { onText, onError };

  /** Start dictating after `prefix` (the text already in the composer). */
  const start = useCallback((prefix: string) => {
    const Ctor = recognitionCtor();
    if (!Ctor || recognitionRef.current) {
      return;
    }
    const recognition = new Ctor();
    // The browser language, not the Grafana UI locale: users write prompts
    // in their own language (Russian, Albanian, Arabic...) under an English UI.
    recognition.lang = navigator.language || 'en-US';
    // Keep listening through pauses until the user stops (or sends).
    recognition.continuous = true;
    // Live partial text, so the user sees the words appear as they speak.
    recognition.interimResults = true;
    recognition.onresult = (event) => {
      // Rebuilt from every result of the session: finals and the current
      // interim guess together, so a revised guess replaces the old one.
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0]?.transcript ?? '';
      }
      callbacksRef.current.onText(joinDictation(prefix, transcript));
    };
    recognition.onerror = (event) => {
      if (event.error === 'no-speech' || event.error === 'aborted') {
        return;
      }
      callbacksRef.current.onError(toSpeechInputError(event.error));
    };
    recognition.onend = () => {
      if (recognitionRef.current === recognition) {
        recognitionRef.current = null;
        setListening(false);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      recognitionRef.current = null;
      callbacksRef.current.onError('other');
    }
  }, []);

  /** Finish dictating: pending speech is still transcribed into the composer. */
  const stop = useCallback(() => {
    recognitionRef.current?.stop();
  }, []);

  /**
   * End dictating and drop any late result — used on send and on manual
   * edits, so a trailing transcript cannot overwrite what is on screen.
   */
  const cancel = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) {
      return;
    }
    recognitionRef.current = null;
    recognition.onresult = null;
    recognition.abort();
    setListening(false);
  }, []);

  // Release the microphone when the chat closes mid-dictation.
  useEffect(() => () => recognitionRef.current?.abort(), []);

  return { supported, listening, start, stop, cancel };
}
