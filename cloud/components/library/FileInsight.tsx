'use client';

import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { Icon } from '@/lib/icons';
import { explainFile, relatedFiles } from '@/app/w/[ws]/agent/actions';
import { ListenButton } from '@/components/speech/ListenButton';
import type { Explanation } from '@/lib/agent/explain';
import type { Relation } from '@/lib/agent/related';
import s from './detail.module.css';

/* The agent, on one file: what else is like it, and what it probably is.
 *
 * The two halves behave differently ON PURPOSE, and the difference is what
 * each one costs.
 *
 * "Related" runs on its own as soon as the panel opens. It is cosine
 * similarity over idf-weighted tag vectors -- arithmetic over an index already
 * in memory, no model, no key, no budget -- so putting it behind a button
 * would be charging a click for something that is free. Context you have to
 * ask for is context most people never see.
 *
 * "Explain" is a button, because it spends one of the day's model calls. The
 * rule this app keeps everywhere: anything that costs money is something a
 * person pressed.
 */

interface Props {
  ws: string;
  fileId: string;
  /** False when no model is configured; the Explain button is then absent
   *  rather than present and failing. */
  canExplain: boolean;
  /** False when no speech key is configured. Listening is offered only once
   *  there is an answer to listen to, so this gates a control that does not
   *  exist yet when the panel opens. */
  canSpeak: boolean;
}

const CONFIDENCE_LABEL: Record<Explanation['confidence'], string> = {
  high: 'The name and labels say so outright',
  medium: 'Consistent with the folder and its neighbours',
  low: 'A reading of a generic name',
};

export function FileInsight({ ws, fileId, canExplain, canSpeak }: Props) {
  const [related, setRelated] = useState<Relation[] | null>(null);
  const [relatedError, setRelatedError] = useState<string | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [thinking, start] = useTransition();

  /* Fetched in an effect rather than by the server component above, because
     the panel's file changes without a navigation -- FileDetail keeps its own
     copy of the file precisely so the server list can go stale under it. */
  useEffect(() => {
    let cancelled = false;
    relatedFiles(ws, fileId)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setRelated(result.related);
        else setRelatedError(result.error);
      })
      .catch(() => {
        if (!cancelled) setRelatedError('Related files could not be looked up.');
      });
    return () => { cancelled = true; };
  }, [ws, fileId]);

  function askWhatItIs() {
    setExplainError(null);
    start(async () => {
      const result = await explainFile(ws, fileId);
      if (result.ok) setExplanation(result.explanation);
      else setExplainError(result.error);
    });
  }

  return (
    <>
      <section className={s.section}>
        <h3 className={s.sectionLabel}>
          What this is
          {canExplain && !explanation && (
            <button
              type="button"
              className={s.textBtn}
              onClick={askWhatItIs}
              disabled={thinking}
            >
              <Icon name="auto_awesome" size={13} />
              {thinking ? 'Reading the name…' : 'Ask the agent'}
            </button>
          )}
        </h3>

        {explainError && <p className={s.insightError}>{explainError}</p>}

        {!explanation && !explainError && (
          <p className={s.none}>
            {canExplain
              ? 'The agent can describe this file from its name, folder and labels. '
                + 'It cannot open it — nothing in this catalogue holds file contents.'
              : 'No model is configured on this server, so files can be filtered but '
                + 'not described.'}
          </p>
        )}

        {explanation && (
          <div className={s.insight}>
            <p className={s.insightSummary}>{explanation.summary}</p>

            {explanation.reads.length > 0 && (
              <ul className={s.reads}>
                {explanation.reads.map((r) => (
                  <li key={r}>
                    <Icon name="check" size={12} /> {r}
                  </li>
                ))}
              </ul>
            )}

            {/* Printed as prominently as the summary. A description of a file
                nobody opened is only safe to read when its limits are on the
                same screen as its conclusions. */}
            <div className={s.unknowns}>
              <h4 className={s.unknownsLabel}>
                <Icon name="visibility_off" size={12} /> Would need the file itself
              </h4>
              <ul>
                {explanation.unknowns.map((u) => (
                  <li key={u}>{u}</li>
                ))}
              </ul>
            </div>

            <p className={s.insightBy}>
              {CONFIDENCE_LABEL[explanation.confidence]} · {explanation.model}
            </p>

            {/* Last, because here the answer comes first -- unlike the brief,
                where the control sits above a sheet of text that would push it
                off screen. The reading includes the caveats above it: speech
                that delivered a confident description of a file nobody opened
                and stopped before the part saying nobody opened it would be
                worse than the panel it is reading from.

                Keyed on the summary, so a re-asked explanation cannot be
                answered with the recording of the previous one. */}
            <ListenButton
              key={explanation.summary}
              ws={ws}
              subject={{ kind: 'explain', fileId }}
              ready={canSpeak}
              trailing
            />
          </div>
        )}
      </section>

      <section className={s.section}>
        <h3 className={s.sectionLabel}>Related files</h3>

        {relatedError && <p className={s.insightError}>{relatedError}</p>}

        {!related && !relatedError && <p className={s.none}>Looking…</p>}

        {related?.length === 0 && (
          <p className={s.none}>
            Nothing else in this workspace shares enough labels with it. That is
            itself a finding — this file sits on its own.
          </p>
        )}

        {related && related.length > 0 && (
          <>
            <ul className={s.related}>
              {related.map((r) => (
                <li key={r.fileId} className={s.relatedRow}>
                  <div className={s.relatedHead}>
                    <span className={s.relatedName} title={r.relPath}>{r.name}</span>
                    {/* A percentage, because the score is a cosine on 0..1 and
                        rounding it to two decimals would imply a precision the
                        measure does not carry. */}
                    <span className={s.relatedScore}>{Math.round(r.score * 100)}%</span>
                  </div>
                  <p className={s.relatedWhy}>
                    {r.sameFolder && (
                      <span className={s.sameFolder}>
                        <Icon name="folder" size={11} /> same folder
                      </span>
                    )}
                    shares {r.shared.map((t) => t.display).join(', ')}
                  </p>
                </li>
              ))}
            </ul>
            <p className={s.note}>
              Ranked by how RARE the shared labels are, not how many there are:
              two files both tagged 2025 have told you nothing, two both tagged
              Transcript almost certainly belong together.{' '}
              <Link href={`/w/${ws}/graph`}>The graph</Link> draws the same
              relation across the whole library.
            </p>
          </>
        )}
      </section>
    </>
  );
}
