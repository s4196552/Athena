'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import s from './brief.module.css';

/* "Listen" -- the brief, read aloud.
 *
 * It sits INSIDE the summary sheet rather than next to the Summarise button,
 * which is the whole of its flow design: there is no way to press it without
 * the text it reads being on screen, so audio is never the only copy of an
 * answer. Someone who cannot hear it has lost nothing, and someone who can is
 * free to look at the file list while it plays, which is the actual reason to
 * want this.
 *
 * The request sends the FILTER, never the text -- see the route and
 * lib/ai/elevenlabs.ts for why that is the load-bearing decision and not a
 * detail.
 */

type Phase = 'idle' | 'loading' | 'playing' | 'error';

interface Props {
  ws: string;
  /** The canonical filter for the selection being summarised. */
  query: string;
  /** False when no ELEVENLABS_API_KEY is configured on this server. */
  ready: boolean;
}

export function ListenButton({ ws, query, ready }: Props) {
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

  /* Unmount is the only place the blob is released, because a new selection
     REMOUNTS this component -- BriefPanel keys it on `query`. Resetting four
     pieces of state in an effect would have done the same job a beat later and
     a render noisier; letting React discard the instance is the cheaper and
     more obviously correct version of "this recording is no longer the answer
     to what is on screen". */
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
        body: JSON.stringify({ query }),
      });

      if (!res.ok) {
        // Every failure path on the route answers with JSON, and every one of
        // its messages says what to do next -- so it is shown verbatim rather
        // than replaced with a generic line.
        const body = await res.json().catch(() => null);
        setError(body?.error ?? 'The summary could not be read aloud.');
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
      setError('The summary could not be read aloud. Check the connection and try again.');
      setPhase('error');
    }
  }

  if (!ready) return null;

  return (
    <div className={s.listenRow}>
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
        {phase === 'loading' ? 'Preparing…' : phase === 'playing' ? 'Stop' : 'Listen'}
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
