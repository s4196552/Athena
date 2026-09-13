'use client';

import { useState, useTransition } from 'react';
import { Icon, TagIcon } from '@/lib/icons';
import { formatBytes, formatNumber } from '@/lib/format';
import { proposeTags, acceptTag } from './actions';
import type { Candidate } from '@/lib/agent/queue';
import type { Proposal } from '@/lib/agent/classify';
import s from './agent.module.css';

/* The review queue.
 *
 * State is per row rather than one "current proposal", because a reviewer works
 * down a list and it would be hostile to lose the suggestion for row 3 by
 * looking at row 4. Rows are small and there are at most sixty.
 *
 * Accepting is optimistic in one direction only: the chip is marked accepted
 * when the SERVER says so, never before. An accept that silently failed -- over
 * the cookie cap, or without contribute access -- would otherwise look
 * identical to one that worked, and the person would find out when the tag was
 * missing from the library later.
 */

type Suggestion = Proposal & { doctypeTagId?: number; topicTagId?: number };

interface RowState {
  proposal?: Suggestion;
  error?: string;
  accepted: number[];
}

interface Props {
  ws: string;
  queue: Candidate[];
  canAccept: boolean;
  modelReady: boolean;
  total: number;
}

const CONFIDENCE_LABEL: Record<Proposal['confidence'], string> = {
  high: 'The name says so outright',
  medium: 'The name and folder point this way',
  low: 'A guess from a generic name',
};

export function AgentClient({ ws, queue, canAccept, modelReady, total }: Props) {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  const update = (id: string, patch: Partial<RowState>) =>
    setRows((r) => {
      const prev: RowState = r[id] ?? { accepted: [] };
      return { ...r, [id]: { ...prev, ...patch } };
    });

  function propose(file: Candidate) {
    setBusy(file.fileId);
    start(async () => {
      const result = await proposeTags(ws, file.fileId);
      if (result.ok) update(file.fileId, { proposal: result.proposal, error: undefined });
      else update(file.fileId, { error: result.error, proposal: undefined });
      setBusy(null);
    });
  }

  function accept(file: Candidate, tagId: number) {
    setBusy(file.fileId);
    start(async () => {
      const result = await acceptTag(ws, file.fileId, tagId);
      if (result.ok) {
        setRows((r) => ({
          ...r,
          [file.fileId]: {
            ...r[file.fileId],
            accepted: [...(r[file.fileId]?.accepted ?? []), tagId],
            error: undefined,
          },
        }));
      } else {
        update(file.fileId, { error: result.error });
      }
      setBusy(null);
    });
  }

  return (
    <>
      <p className={s.queueHead}>
        The {formatNumber(queue.length)} worth looking at first
        {total > queue.length && <>, of {formatNumber(total)}</>}. Missing a kind
        counts for more than missing a topic, and a file with no tags at all
        sorts to the top.
      </p>

      <ul className={s.list}>
        {queue.map((file) => {
          const row = rows[file.fileId];
          const working = busy === file.fileId;

          return (
            <li key={file.fileId} className={s.item}>
              <div className={s.itemHead}>
                <Icon name={ICON[file.mediaType] ?? 'draft'} size={16} className={s.fileIcon} />
                <div className={s.names}>
                  <p className={s.name}>{file.name}</p>
                  <p className={s.path}>
                    {file.parentRel || 'the library root'} · {file.ext || 'no extension'} ·{' '}
                    {formatBytes(file.sizeBytes)}
                  </p>
                </div>

                <div className={s.gaps}>
                  {file.gaps.map((gap) => (
                    <span key={gap} className={s.gap}>
                      <Icon name="warning" size={11} />
                      no {gap === 'doctype' ? 'kind' : 'topic'}
                    </span>
                  ))}
                </div>

                <button
                  type="button"
                  className={s.ask}
                  onClick={() => propose(file)}
                  disabled={working || !modelReady}
                  title={modelReady
                    ? 'Send this file’s name and folder to the model'
                    : 'No model is configured on this server'}
                >
                  <Icon name="auto_awesome" size={14} />
                  {working ? 'Asking…' : row?.proposal ? 'Ask again' : 'Ask the agent'}
                </button>
              </div>

              {file.has.length > 0 && (
                <p className={s.hasRow}>
                  Already tagged:{' '}
                  {file.has.map((t) => (
                    <span key={`${t.kind}-${t.display}`} className={s.hasTag}>
                      {t.display}
                    </span>
                  ))}
                </p>
              )}

              {row?.error && <p className={s.error}>{row.error}</p>}

              {row?.proposal && (
                <div className={s.proposal}>
                  <div className={s.verdict}>
                    {(['doctype', 'topic'] as const).map((axis) => {
                      const name = row.proposal![axis];
                      const tagId = row.proposal![axis === 'doctype' ? 'doctypeTagId' : 'topicTagId'];
                      const done = tagId !== undefined && row.accepted.includes(tagId);

                      if (!name) {
                        return (
                          <span key={axis} className={s.declined}>
                            <Icon name="close" size={12} />
                            no {axis === 'doctype' ? 'kind' : 'topic'} it would commit to
                          </span>
                        );
                      }

                      return (
                        <span key={axis} className={s.pick}>
                          <TagIcon kind={axis} name={name} size={13} />
                          {name}
                          {done ? (
                            <span className={s.done}>
                              <Icon name="check" size={12} /> added
                            </span>
                          ) : canAccept && tagId !== undefined ? (
                            <button
                              type="button"
                              className={s.accept}
                              onClick={() => accept(file, tagId)}
                              disabled={working}
                            >
                              Accept
                            </button>
                          ) : (
                            <span className={s.readonly}>view only</span>
                          )}
                        </span>
                      );
                    })}

                    <span className={`${s.confidence} ${s[row.proposal.confidence]}`}>
                      {CONFIDENCE_LABEL[row.proposal.confidence]}
                    </span>
                  </div>

                  {row.proposal.reasoning && (
                    <p className={s.reasoning}>
                      &ldquo;{row.proposal.reasoning}&rdquo;
                      <span className={s.model}> — {row.proposal.model}</span>
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}

const ICON: Record<string, string> = {
  image: 'image', video: 'movie', audio: 'music_note', document: 'description',
};
