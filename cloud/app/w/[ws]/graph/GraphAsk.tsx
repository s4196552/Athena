'use client';

import { useState, useTransition } from 'react';
import { Icon } from '@/lib/icons';
import { askForView } from '../agent/actions';
import { ListenButton } from '@/components/speech/ListenButton';
import type { AskResult } from '../agent/actions';
import s from '@/components/graph/graph.module.css';

/* Asking the graph a question, from inside the graph.
 *
 * The same verb the Agent page offers, put where the answer actually lands.
 * On that page a plan ends with a link you have to follow; here the drawing
 * you are already looking at rearranges itself, which is the difference
 * between reading a result and watching one.
 *
 * It sets the FILTER and the MODE and stops there. It does not touch the
 * colour rules, the sliders or the labels, because those are how a person is
 * choosing to look at the graph and a question is about what is in it. An
 * agent that quietly reset someone's view every time they asked something
 * would be answering a question they did not ask.
 */

const EXAMPLES = [
  'how do finance and legal overlap',
  'what did aria chen work on in 2024',
  'break down the structure of the invoices',
];

interface Props {
  ws: string;
  /** Applies the plan: the parent owns both the mode and the URL. */
  onApply: (plan: Extract<AskResult, { ok: true }>) => void;
  /** False when no speech key is configured, in which case the plan can be
   *  read but not heard. */
  canSpeak: boolean;
}

export function GraphAsk({ ws, onApply, canSpeak }: Props) {
  const [question, setQuestion] = useState('');
  /* The question that produced the result on screen, which is NOT the contents
     of the box -- someone can start typing the next one while looking at this
     answer. Speech names a question rather than carrying text, so sending the
     box instead of this would ask the server to read back a plan for something
     nobody has asked yet. */
  const [asked, setAsked] = useState('');
  const [result, setResult] = useState<AskResult | null>(null);
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  function ask(text: string) {
    const q = text.trim();
    if (!q) return;
    setQuestion(q);
    start(async () => {
      const answer = await askForView(ws, q);
      setResult(answer);
      setAsked(q);
      if (answer.ok) onApply(answer);
    });
  }

  return (
    <div className={s.section}>
      <div className={s.sectHead}>
        <p className={s.sectLabel}>Ask</p>
        {result?.ok && (
          <button type="button" className={s.clearKey} onClick={() => setResult(null)}>
            Clear
          </button>
        )}
      </div>

      <form
        className={s.askRow}
        onSubmit={(e) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input
          type="text"
          className={s.askField}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onFocus={() => setOpen(true)}
          placeholder="a question about this library"
          aria-label="Ask a question and redraw the graph"
          maxLength={300}
          disabled={pending}
        />
        <button
          type="submit"
          className={s.askBtn}
          disabled={pending || !question.trim()}
          aria-label="Ask"
        >
          <Icon name={pending ? 'auto_awesome' : 'search'} size={14} />
        </button>
      </form>

      {/* Shown once, until something has been asked. A box with no example in
          it leaves the reader guessing at the shape of question it takes, and
          the examples are the fastest way to find out that it takes one. */}
      {open && !result && !pending && (
        <ul className={s.askExamples}>
          {EXAMPLES.map((e) => (
            <li key={e}>
              <button type="button" onClick={() => ask(e)}>{e}</button>
            </li>
          ))}
        </ul>
      )}

      {pending && <p className={s.askNote}>Reading the question…</p>}

      {result && !result.ok && <p className={s.askError}>{result.error}</p>}

      {result?.ok && (
        <div className={s.askResult}>
          <p className={s.askTitle}>{result.plan.title}</p>

          <div className={s.askChips}>
            {Object.entries(result.plan.tags).flatMap(([axis, names]) =>
              names.map((name) => (
                <span key={`${axis}-${name}`} className={s.askChip}>
                  <span className={s.askAxis}>{axis}</span>{name}
                </span>
              )),
            )}
            {result.plan.q && (
              <span className={s.askChip}>
                <span className={s.askAxis}>name</span>{result.plan.q}
              </span>
            )}
            {!Object.keys(result.plan.tags).length && !result.plan.q && (
              <span className={s.askChip}>everything</span>
            )}
          </div>

          {/* Counted by the catalogue, and said to be. The drawing may show
              fewer -- the file graph caps at the most connected few thousand --
              so this is the size of the SELECTION, not a claim about dots. */}
          <p className={s.askCount}>
            {result.matches.toLocaleString()}{' '}
            {result.matches === 1 ? 'file matches' : 'files match'}
          </p>

          {result.plan.why && <p className={s.askWhy}>{result.plan.why}</p>}

          {result.plan.dropped.length > 0 && (
            <p className={s.askDropped}>
              <Icon name="warning" size={11} />
              Ignored {result.plan.dropped.map((d) => `“${d.name}”`).join(', ')} — no
              such tag here, so it was left out rather than guessed at.
            </p>
          )}

          {/* The one panel where listening earns its keep outright: the answer
              is a REDRAWING, so the person pressing this is about to be
              looking at the graph rather than at the words explaining it.
              Keyed on the question, so a new answer is never played with the
              recording of the previous one. */}
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
    </div>
  );
}
