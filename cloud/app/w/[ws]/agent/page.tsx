import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireSession } from '@/lib/auth';
import { workspaceContext } from '@/lib/data/context';
import { getRepository } from '@/lib/data';
import { buildQueue } from '@/lib/agent/queue';
import { findRepeats } from '@/lib/agent/related';
import { geminiStatus } from '@/lib/ai/gemini';
import { PER_VIEWER_DAILY } from '@/lib/brief/budget';
import { formatBytes, formatNumber } from '@/lib/format';
import { Icon } from '@/lib/icons';
import { AgentClient } from './AgentClient';
import { AskBox } from './AskBox';
import s from './agent.module.css';

export const dynamic = 'force-dynamic';

/* THE ATHENA AGENT, on the web.
 *
 * The engine's agent (athena/agent/inspect.py) reads a file, scores it against
 * a lexicon, and escalates to a model when the rules come out unsure. Only the
 * middle step survives the trip to a browser: the seeded catalogue stores the
 * agent's conclusions, not its working, so there are no scores here to
 * re-derive and the TypeScript taxonomy carries names without the lexicon
 * behind them.
 *
 * What that leaves is still the useful half. `Verdict.unsure` is
 * `topic_score < ESCALATE_BELOW or doctype is None`, and the second clause is a
 * fact the catalogue still holds. So this page finds the files with no kind and
 * no topic, puts the worst first, and offers the same escalation the engine
 * offers -- one file at a time, with a person deciding.
 *
 * The page is careful to claim only that. It does not show a confidence score,
 * because it does not have one.
 */

const QUEUE_LIMIT = 60;

export default async function AgentPage({
  params,
}: {
  params: Promise<{ ws: string }>;
}) {
  const { ws } = await params;
  const session = await requireSession(`/w/${ws}/agent`);
  const ctx = await workspaceContext(session.user.id, ws);
  if (!ctx) notFound();

  const repo = getRepository();
  const [page, tags] = await Promise.all([
    repo.listFiles(ctx, { limit: Number.MAX_SAFE_INTEGER }),
    repo.listTags(ctx),
  ]);

  const tagById = new Map(tags.map((t) => [t.id, t]));

  /* The same lens every other page reads through: a tag this workspace removed
     is gone here too, so correcting a wrong `doctype` puts the file back in the
     agent's queue -- which is the correct behaviour and falls out of using the
     repository rather than the raw records. */
  const visible = (f: (typeof page.files)[number]) => {
    const own = (f.userTags ?? [])
      .filter((u) => u.workspaceId === ctx.workspace.id)
      .map((u) => u.tagId);
    const added = [...(ctx.addedTags?.(f.id) ?? [])];
    return [...f.tags, ...own, ...added].filter((id) => !ctx.isRemoved(f.id, id));
  };

  const queue = buildQueue(page.files, visible, tagById, QUEUE_LIMIT);

  // The whole population, so the queue's length is not mistaken for the size of
  // the problem.
  let missingDoctype = 0;
  let missingTopic = 0;
  for (const f of page.files) {
    const kinds = new Set(visible(f).map((id) => tagById.get(id)?.kind));
    if (!kinds.has('doctype')) missingDoctype++;
    if (!kinds.has('topic')) missingTopic++;
  }

  const gaps = page.files.filter((f) => {
    const kinds = new Set(visible(f).map((id) => tagById.get(id)?.kind));
    return !kinds.has('doctype') || !kinds.has('topic');
  }).length;

  const model = geminiStatus();
  const accepted = ctx.overlay.additions.length;

  /* Costs nothing, so it is computed for every visit rather than put behind a
     button. Worth stating why it is not called "duplicates": every file in
     this catalogue has a distinct content hash, so there are none, and a
     duplicate finder here would render an empty box forever while implying the
     library was tidy. What these groups show is one name filed in several
     places, which is a different and more common problem. */
  const repeats = findRepeats(page.files, 8);

  return (
    <main className={s.page} id="main">
      <header className={s.head}>
        <div>
          <h1 className={s.h1}>Athena Agent</h1>
          <p className={s.sub}>
            The engine classifies a file by scoring its text against a lexicon,
            and asks a model only when the rules come out unsure. The catalogue
            keeps what it decided, not the scores it decided with — so this
            finds the files it left without a kind or a topic, and offers the
            same escalation one file at a time.
          </p>
        </div>
        <div className={s.status}>
          <span className={model.configured ? s.dotOk : s.dotOff} aria-hidden="true" />
          {model.configured
            ? <>Model ready — <code>{model.model}</code>, {PER_VIEWER_DAILY} calls a day</>
            : <>No model configured — the queue still works, suggestions do not</>}
        </div>
      </header>

      <div className={s.stats}>
        <div className={s.stat}>
          <div className={s.statValue}>{formatNumber(gaps)}</div>
          <div className={s.statLabel}>Files with a gap</div>
        </div>
        <div className={s.stat}>
          <div className={s.statValue}>{formatNumber(missingDoctype)}</div>
          <div className={s.statLabel}>No kind</div>
        </div>
        <div className={s.stat}>
          <div className={s.statValue}>{formatNumber(missingTopic)}</div>
          <div className={s.statLabel}>No topic</div>
        </div>
        <div className={s.stat}>
          <div className={s.statValue}>{formatNumber(accepted)}</div>
          <div className={s.statLabel}>Accepted here</div>
        </div>
      </div>

      <AskBox ws={ws} ready={model.configured} />

      <section className={s.note}>
        <p>
          <strong>What the agent is given.</strong> It cannot see the file. The
          seeded catalogue holds names, sizes, dates and tag ids and no content,
          so a suggestion is made from the file&rsquo;s name, its folder, its
          extension and its media type — the same evidence the engine calls{' '}
          <code>name_key</code>, and a strict subset of what the engine itself
          reads. Judge a suggestion on the reasoning it gives you.
        </p>
        <p>
          Accepting adds the tag <em>for this workspace only</em>. The catalogue
          is never written to, which is the same promise the removal of a wrong
          tag makes — see{' '}
          <Link href={`/w/${ws}/library`}>the library</Link> for where it lands.
        </p>
      </section>

      <h2 className={s.h2}>Files missing a label</h2>

      {queue.length === 0 ? (
        <p className={s.empty}>
          Every file this workspace can see has both a kind and a topic. There is
          nothing for the agent to decide.
        </p>
      ) : (
        <AgentClient
          ws={ws}
          queue={queue}
          canAccept={ctx.can('tag')}
          modelReady={model.configured}
          total={gaps}
        />
      )}

      {repeats.length > 0 && (
        <section className={s.repeats}>
          <h2 className={s.h2}>The same name, filed in several places</h2>
          <p className={s.queueHead}>
            Found by comparing names, not contents — version and copy markers are
            stripped, so <code>report_v2</code> and <code>report_final</code> count as
            one name. Every file below has a{' '}
            <strong>different content hash</strong>, so these are not duplicates:
            they are separate documents sharing a name across folders, which is the
            harder problem to notice.
          </p>

          <ul className={s.list}>
            {repeats.map((group) => (
              <li key={`${group.stem}.${group.ext}`} className={s.item}>
                <div className={s.itemHead}>
                  <Icon name="folder" size={16} className={s.fileIcon} />
                  <div className={s.names}>
                    <p className={s.name}>
                      {group.stem}
                      {group.ext ? `.${group.ext}` : ''}
                    </p>
                    <p className={s.path}>
                      {group.files.length} files across {group.folders} folders ·{' '}
                      {group.distinctContent === group.files.length
                        ? 'all different content'
                        : `${group.distinctContent} distinct contents`}
                    </p>
                  </div>
                  <Link
                    href={`/w/${ws}/library?q=${encodeURIComponent(group.stem)}`}
                    className={s.ask}
                  >
                    <Icon name="search" size={14} /> Show them
                  </Link>
                </div>

                <ul className={s.where}>
                  {group.files.slice(0, 5).map((f) => (
                    <li key={f.fileId}>
                      <span className={s.wherePath}>{f.parentRel || 'the library root'}</span>
                      <span className={s.whereMeta}>{formatBytes(f.sizeBytes)}</span>
                    </li>
                  ))}
                  {group.files.length > 5 && (
                    <li className={s.whereMore}>
                      and {group.files.length - 5} more
                    </li>
                  )}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
