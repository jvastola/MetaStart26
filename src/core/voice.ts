/**
 * Voice input via the browser's Web Speech API, when it exists.
 *
 * Voice is an accessibility alternative to hand input and the front door to
 * the agentic prototypes, never a hard dependency: callers always offer a
 * hands-only path (preset chips) when `Voice.supported` is false or when
 * recognition fails.
 */

interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type RecognitionCtor = new () => RecognitionLike;

function ctor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface VoiceHandlers {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (reason: string) => void;
  onEnd?: () => void;
}

export class Voice {
  static get supported(): boolean {
    return ctor() != null;
  }

  private rec: RecognitionLike | null = null;
  listening = false;

  start(handlers: VoiceHandlers): boolean {
    const Ctor = ctor();
    if (Ctor == null) return false;
    this.stop();
    const rec = new Ctor();
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e) => {
      let text = '';
      let final = false;
      for (let i = 0; i < e.results.length; i += 1) {
        text += e.results[i][0].transcript;
        if (e.results[i].isFinal) final = true;
      }
      if (final) handlers.onFinal(text.trim());
      else handlers.onPartial?.(text.trim());
    };
    rec.onerror = (e) => handlers.onError?.(e.error);
    rec.onend = () => {
      this.listening = false;
      handlers.onEnd?.();
    };
    try {
      rec.start();
    } catch {
      return false;
    }
    this.rec = rec;
    this.listening = true;
    return true;
  }

  stop(): void {
    if (this.rec) {
      try {
        this.rec.stop();
      } catch {
        // Already stopped.
      }
    }
    this.rec = null;
    this.listening = false;
  }
}
