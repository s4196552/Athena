'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import s from './speech.module.css';

/* "Listen" -- whatever the app is currently saying, read aloud.
 *
 * Three things use it: the brief, the agent's description of one file, and the
 * agent's answer to a question about the library. In all three it sits INSIDE
 * the panel holding the text it reads, which is the whole of its flow design.
 * There is no way to press it without the words being on screen, so audio is
 * never the only copy of an answer: someone who cannot hear it has lost
 * nothing, and someone who can is free to look at the file list while it
 * plays, which is the actual reason to want this.
 *
 * THE SUBJECT IS A REFERENCE, NOT TEXT, and the type below is the place that
 * is enforced for the client half -- there is no variant here that carries a
 * string to be spoken, so a caller cannot pass one by accident. The route and
 * lib/ai/elevenlabs.ts give the reasoning: an endpoint that speaks what it is
 * posted is a free text-to-speech service billed to one shared key.
 *
 * Two of the three subjects name something the server must REMEMBER rather
 * than rebuild, because they came out of a model call. That failure -- "ask
 * again, this server no longer has it" -- arrives as an ordinary error message
 * and is shown like any other, which is why this component needs to know
 * nothing about it.
 */

export type SpeechSubject =
  /** A filter string. The brief for it is rebuilt from the catalogue. */
  | { kind: 'brief'; query: string }
  /** A file id. Reads back the explanation the agent gave for it. */
  | { kind: 'explain'; fileId: string }
  /** A question. Reads back the plan the agent produced for it. */
  | { kind: 'plan'; question: string };

type Phase = 'idle' | 'loading' | 'playing' | 'error';

interface Props {
  ws: string;
  subject: SpeechSubject;
  /** False when no ELEVENLABS_API_KEY is configured on this server. */
  ready: boolean;
  /** Overrides the resting label. "Listen" everywhere but the graph rail,
   *  where the surrounding controls are all two words or fewer. */
  label?: string;
  /** True where the control CLOSES a block rather than opening one -- the file
   *  panel and the graph rail, where the answer is above it. Moves the margin
   *  to the other side; the brief keeps it below, since there it sits above
   *  the text it reads. */
  trailing?: boolean;
}

export function ListenButton({ ws, subject, ready, label = 'Listen', trailing }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string>('');
  const [short, setShort] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  /* Object URLs are a manual allocation in a garbage-collected language: the
     blob stays alive until revoke is called, so a person who summarises six
     selections and listens to each would leave six mp3s in memory for the life
     of the tab. Revoked on replacement and on unmount. */
  const release = () => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  };

  /* Unmount is the only place the blob is released, because a new subject
     REMOUNTS this component -- every caller keys it on the text being read.
     Resetting four pieces of state in an effect would have done the same job a
     beat later and a render noisier; letting React discard the instance is the
     cheaper and more obviously correct version of "this recording is no longer
     the answer to what is on screen". */
  useEffect(() => release, []);

  async function play() {
    if (phase === 'playing') {
      audioRef.current?.pause();
      setPhase('idle');
      return;
    }

    // Already fetched: replay costs nothing, so it must not re-request.
    if (urlRef.current && audioRef.current) {
      audioRef.current.currentTime = 0;
      await audioRef.current.play();
      setPhase('playing');
      return;
    }

    setPhase('loading');
    setError('');

    try {
      const res = await fetch(`/api/w/${encodeURIComponent(ws)}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(subject),
      });

      if (!res.ok) {
        // Every failure path on the route answers with JSON, and every one of
        // its messages says what to do next -- so it is shown verbatim rather
        // than replaced with a generic line.
        const body = await res.json().catch(() => null);
        setError(body?.error ?? 'That could not be read aloud.');
        setPhase('error');
        return;
      }

      setShort(res.headers.get('X-Speech-Truncated') === '1');

      const url = URL.createObjectURL(await res.blob());
      release();
      urlRef.current = url;

      const el = audioRef.current;
      if (!el) return;
      el.src = url;
      await el.play();
      setPhase('playing');
    } catch {
      setError('That could not be read aloud. Check the connection and try again.');
      setPhase('error');
    }
  }

  if (!ready) return null;

  return (
    <div className={trailing ? `${s.listenRow} ${s.after}` : s.listenRow}>
      <button
        type="button"
        className={s.listen}
        onClick={play}
        disabled={phase === 'loading'}
        /* The icon changes AND the label changes AND aria-pressed changes.
           Three signals rather than a colour, because "is it playing?" is the
           one state a person needs while looking somewhere else. */
        aria-pressed={phase === 'playing'}
      >
        <Icon
          name={phase === 'playing' ? 'stop' : phase === 'loading' ? 'volume_up' : 'play_arrow'}
          size={14}
        />
        {phase === 'loading' ? 'Preparing…' : phase === 'playing' ? 'Stop' : label}
      </button>

      {short && phase !== 'error' && (
        <span className={s.listenNote}>Reads the first part only</span>
      )}

      {/* Announced rather than only drawn: the button that started it may no
          longer have focus by the time this appears. */}
      {error && (
        <span className={s.listenError} role="status">
          {error}
        </span>
      )}

      <audio
        ref={audioRef}
        onEnded={() => setPhase('idle')}
        onPause={() => setPhase((p) => (p === 'playing' ? 'idle' : p))}
        onError={() => {
          setError('That audio could not be played in this browser.');
          setPhase('error');
        }}
        hidden
      />
    </div>
  );
}
