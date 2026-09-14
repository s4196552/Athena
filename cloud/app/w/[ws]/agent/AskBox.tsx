'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { Icon } from '@/lib/icons';
import { formatNumber } from '@/lib/format';
import { askForView } from './actions';
import type { AskResult } from './actions';
import { ListenButton } from '@/components/speech/ListenButton';
import s from './agent.module.css';

/* "Ask for a view."
 *
 * A question goes in, and what comes back is a FILTER -- not an answer. The
 * distinction is drawn in the UI as hard as it is in the code: the card shows
 * the tags that were chosen as chips a person can read, the count beside them
 * is labelled as the catalogue's, and the model's own words appear once, as a
 * quoted reason for the choice.
 *
 * That shape is deliberate. A box that answered questions in prose would be
 * unfalsifiable -- there is no way to check "about four hundred" against
 * anything. A box that produces a filter can be checked by opening it, which
 * is what both buttons do.
 */

const EXAMPLES = [
  'how do finance and legal overlap',
  'what did Aria Chen work on in 2024',
  'break down what the invoices contain',
];

const MODE_LABEL: Record<string, string> = {
  files: 'file graph',
  tags: 'tag graph',
  pyramid: 'pyramid',
};

export function AskBox({
  ws,
  ready,
  canSpeak,
}: {
  ws: string;
  ready: boolean;
  /** False when no speech key is configured; the plan is then readable but
   *  not audible, which is the same shape every other AI control takes here. */
  canSpeak: boolean;
}) {
  const [question, setQuestion] = useState('');
  /* The question the plan on screen came from, which is not necessarily what
     is in the box -- the next question can be half typed while this answer is
     still up. Speech names a question rather than carrying text, so it has to
     name the one that was actually asked. */
  const [asked, setAsked] = useState('');
  const [result, setResult] = useState<AskResult | null>(null);
  const [pending, start] = useTransition();

  function ask(text: string) {
    const q = text.trim();
    if (!q) return;
    setQuestion(q);
    start(async () => {
      setResult(await askForView(ws, q));
      setAsked(q);
    });
  }

  return (
    <section className={s.askPanel}>
      <h2 className={s.h2}>Ask for a view</h2>
      <p className={s.askSub}>
        The agent turns a question into a filter and picks which of the three
        drawings answers it. It never reports a number — once it has chosen,
        the catalogue does the counting.
      </p>

      <form
        className={s.askForm}
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input
          type="text"
          className={s.askInput}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="what did Aria Chen work on in 2024"
          aria-label="Ask a question about this library"
          maxLength={300}
          disabled={!ready || pending}
        />
        <button type="submit" className={s.askGo} disabled={!ready || pending || !question.trim()}>
          <Icon name="auto_awesome" size={14} />
          {pending ? 'Thinking…' : 'Ask'}
        </button>
      </form>

      {!ready ? (
        <p className={s.askNote}>
          No model is configured on this server, so questions cannot be turned into
          views. The facet rail in <Link href={`/w/${ws}/library`}>the library</Link>{' '}
          does the same job by hand.
        </p>
      ) : (
        !result && (
          /* An empty state that gives something to press, per the HIG: a box
             that only says "type a question" leaves the reader guessing at the
             shape of question it can take. */
          <p className={s.examples}>
            Try{' '}
            {EXAMPLES.map((e, i) => (
              <span key={e}>
                {i > 0 && ' · '}
                <button type="button" className={s.example} onClick={() => ask(e)}>
                  {e}
                </button>
              </span>
            ))}
          </p>
        )
      )}

      {result && !result.ok && <p className={s.error}>{result.error}</p>}

      {result?.ok && (
        <div className={s.plan}>
          <div className={s.planHead}>
            <h3 className={s.planTitle}>{result.plan.title}</h3>
            <span className={s.planMode}>
              <Icon name="hub" size={12} /> {MODE_LABEL[result.plan.mode] ?? result.plan.mode}
            </span>
          </div>

          <div className={s.planChips}>
            {Object.entries(result.plan.tags).flatMap(([axis, names]) =>
              names.map((name) => (
                <span key={`${axis}-${name}`} className={s.planChip}>
                  <span className={s.planAxis}>{axis}</span>
                  {name}
                </span>
              )),
            )}
            {result.plan.q && (
              <span className={s.planChip}>
                <span className={s.planAxis}>name contains</span>
                {result.plan.q}
              </span>
            )}
            {!Object.keys(result.plan.tags).length && !result.plan.q && (
              <span className={s.planChip}>everything in this workspace</span>
            )}
          </div>

          {/* Counted, and labelled as counted. */}
          <p className={s.planCount}>
            <strong>{formatNumber(result.matches)}</strong>{' '}
            {result.matches === 1 ? 'file matches' : 'files match'}, counted from the
            catalogue.
          </p>

          {result.plan.why && (
            <p className={s.planWhy}>
              &ldquo;{result.plan.why}&rdquo;
              <span className={s.model}> — {result.plan.model}</span>
            </p>
          )}

          {/* Shown, never swallowed. A question that was only partly understood
              must not be presented as one that was understood. */}
          {result.plan.dropped.length > 0 && (
            <p className={s.dropped}>
              <Icon name="warning" size={12} />
              Ignored {result.plan.dropped.map((d) => `“${d.name}”`).join(', ')} — no
              such {result.plan.dropped.length === 1 ? 'tag' : 'tags'} in this library,
              so {result.plan.dropped.length === 1 ? 'it was' : 'they were'} left out of
              the filter rather than guessed at.
            </p>
          )}

          <div className={s.planGo}>
            <Link href={result.href} className={s.planPrimary}>
              <Icon name="hub" size={14} /> Open the {MODE_LABEL[result.plan.mode]}
            </Link>
            <Link href={result.libraryHref} className={s.planSecondary}>
              <Icon name="view_list" size={14} /> See the files
            </Link>
          </div>

          {/* Below the two ways of opening the plan, because hearing it is a
              third way of taking it in rather than a fourth destination. The
              reading always includes the ignored terms above: a question that
              was half understood must not SOUND like one that was understood.
              Keyed on the question, so a new plan is never played back with
              the previous recording. */}
          <ListenButton
            key={asked}
            ws={ws}
            subject={{ kind: 'plan', question: asked }}
            ready={canSpeak}
            label="Read it out"
            trailing
          />
        </div>
      )}
    </section>
  );
}
