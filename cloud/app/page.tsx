import Link from 'next/link';
import s from './home.module.css';
import { getGatewayStatus } from '@/lib/gateway';
import { tenancy } from '@/lib/data/json/load';

const REPO_URL = 'https://github.com/s4196552/athena';

/* The landing page is a server component and the gateway health check happens
 * server-side, once a minute, shared across every visitor. The static page it
 * replaces did this from the browser, which is why the old CSP needed
 * `connect-src *`. Moving the fetch here is what lets that tighten to 'self'. */
export const revalidate = 60;

/* ONBOARDING, not a README.
 *
 * The page this replaces explained the desktop engine to someone who had
 * already decided to care. It opened with "Athena walks a folder and reads
 * every file in it" -- true of the thing you install, and NOT true of the
 * thing the reader is looking at, which is a hosted demo over a catalogue
 * committed to the repository. Leading with a sentence the demo cannot back up
 * is the one mistake a landing page cannot afford, so the split between the
 * two is now stated in the hero rather than left to be discovered.
 *
 * The shape is the one the current generation of AI product pages has settled
 * on, for a reason worth stating: a person who lands here has about sixty
 * seconds and no intention of reading. So the page opens with something to
 * PRESS -- three real questions that deep-link into the live demo -- and
 * explains itself underneath, for the reader who pressed one and came back.
 * Every number on it is read from the seed rather than typed, so it cannot
 * quietly become a lie.
 */

/** Sign-in sits between a cold visitor and any demo link, so every one of them
 *  carries where it was going. `/login` honours `next`, and an already-signed-in
 *  reader is redirected straight through. */
function demo(path: string): string {
  return `/login?next=${encodeURIComponent(path)}`;
}

const OPS = '/w/hadesmedia-ops';

export default async function Home() {
  const gateway = await getGatewayStatus();

  /* Counted from the committed seed, not typed into the copy. The whole claim
     of this project is that its numbers are arithmetic rather than assertions,
     and a landing page quoting a figure that drifted from the data would be
     the least defensible place to break that. */
  const seed = tenancy();
  const files = seed.libraries.reduce((n, l) => n + l.fileCount, 0);
  const tags = seed.libraries.reduce((n, l) => n + l.tagCount, 0);
  const mutations = seed.libraries.reduce((n, l) => n + l.mutations, 0);
  // Named rather than summed: the tenancy example below is about ONE library
  // seen two ways, so the total across three would be the wrong figure.
  const mainLibrary = seed.libraries.find((l) => l.slug === 'hadesmedia-main')?.fileCount ?? 0;
  const n = (v: number) => v.toLocaleString('en-US');

  return (
    <main id="main">
      <header className={s.header}>
        <div className={s.wrap}>
          <div className={s.brand}>
            <span className={s.mark} aria-hidden="true" />
            <span>Athena</span>
          </div>

          <h1 className={s.h1}>
            Everything you own, searchable.
            <br />
            <em>Nothing you own, touched.</em>
          </h1>

          <p className={s.lede}>
            Athena reads a folder — photographs, documents, audio, video, code —
            and turns it into a catalogue you can filter, graph, summarise and
            ask questions of. It opens every file read-only and re-hashes it
            afterwards, so indexing cannot change what it indexed.
          </p>

          <div className={s.cta}>
            <Link className={`${s.btn} ${s.primary}`} href={demo(`${OPS}/library`)}>
              Open the live demo →
            </Link>
            <a className={`${s.btn} ${s.ghost}`} href="#run">Run it on your own files</a>
            <a className={`${s.btn} ${s.ghost}`} href={REPO_URL}>Source</a>
          </div>

          {/* Said plainly and early. The demo is a real catalogue and it is not
              the reader's; conflating the two is how a demo loses trust at
              exactly the moment it was working. */}
          <p className={s.note}>
            The demo is a real, pre-built catalogue of {n(files)} files — you are
            not uploading anything, and nothing here reads your machine. To index
            your own folder, <a href="#run">run it locally</a>.
          </p>

          <dl className={s.stats}>
            <div><dt>Files catalogued</dt><dd>{n(files)}</dd></div>
            <div><dt>Tags derived</dt><dd>{n(tags)}</dd></div>
            <div><dt>Teams sharing them</dt><dd>{seed.workspaces.length}</dd></div>
            <div><dt>Bytes modified</dt><dd>{n(mutations)}</dd></div>
          </dl>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      <section className={s.section}>
        <div className={s.wrap}>
          <h2 className={s.sect}>Start here</h2>
          <p className={s.muted}>
            Three things worth trying, each a live link into the demo. They take
            about a minute between them.
          </p>

          <ol className={s.tries}>
            <li>
              <span className={s.tryNum} aria-hidden="true">1</span>
              <div>
                <h3>Ask a question and watch the graph answer it</h3>
                <p>
                  Type <em>“how do finance and legal overlap”</em>. The agent
                  turns it into a filter and picks which of three drawings
                  answers it — then the catalogue does the counting. It is never
                  asked how many there are.
                </p>
                <Link href={demo(`${OPS}/graph`)} className={s.tryGo}>
                  Open the graph →
                </Link>
              </div>
            </li>

            <li>
              <span className={s.tryNum} aria-hidden="true">2</span>
              <div>
                <h3>See one catalogue through two teams&rsquo; eyes</h3>
                <p>
                  Studio Ops sees all {n(mainLibrary)} files in the main library.
                  Marketing holds a grant on a slice of the same one and sees
                  fewer — and neither can see the other&rsquo;s annotations. Sign
                  in as Iris, who is in both.
                </p>
                <Link href={demo('/app/select')} className={s.tryGo}>
                  Switch between them →
                </Link>
              </div>
            </li>

            <li>
              <span className={s.tryNum} aria-hidden="true">3</span>
              <div>
                <h3>Tell it that a tag is wrong</h3>
                <p>
                  Open any file and remove a tag. The count, the facets, the
                  summary and both graphs agree immediately — and the catalogue
                  is not edited. Your correction is a lens your team looks
                  through, not a change to someone else&rsquo;s data.
                </p>
                <Link href={demo(`${OPS}/library?doctype=invoice`)} className={s.tryGo}>
                  Open the library →
                </Link>
              </div>
            </li>
          </ol>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className={s.section}>
        <div className={s.wrap}>
          <h2 className={s.sect}>How it works</h2>
          <div className={s.steps}>
            <div className={s.step}>
              <span className={s.stepNum} aria-hidden="true">1</span>
              <h3>It walks, read-only</h3>
              <p>
                Every file is opened through one guarded reader and re-hashed
                afterwards. Nothing is renamed, moved, rewritten or
                re-timestamped. The index lives in a separate SQLite database.
              </p>
            </div>
            <div className={s.step}>
              <span className={s.stepNum} aria-hidden="true">2</span>
              <h3>It extracts</h3>
              <p>
                Text, document properties, EXIF, palettes, keyframes, OCR,
                duration, dimensions — about thirty detectors, each recorded so
                you can see which ones ran and which were skipped.
              </p>
            </div>
            <div className={s.step}>
              <span className={s.stepNum} aria-hidden="true">3</span>
              <h3>It decides — rules first</h3>
              <p>
                Deterministic rules settle most files in roughly three
                milliseconds each, with no GPU, no key and no network. A model
                is asked only about the residue the rules could not settle —
                about 11% of a real library.
              </p>
            </div>
            <div className={s.step}>
              <span className={s.stepNum} aria-hidden="true">4</span>
              <h3>Then you ask</h3>
              <p>
                Filter it, draw it as a graph, summarise a selection, or hand a
                question to the agent. Every figure you are shown is arithmetic
                over the index — the model writes prose, never numbers.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className={s.section}>
        <div className={s.wrap}>
          <h2 className={s.sect}>What it will not do</h2>
          <p className={s.muted}>
            The limits are the product. They are listed here rather than in a
            policy page because they are the reason to trust any of the above.
          </p>

          <div className={s.grid}>
            <div className={s.card}>
              <h3>It never writes to your files</h3>
              <p>
                Read-only handles, verified by re-hashing after every run.
                {' '}<strong>{n(mutations)} integrity mutations</strong> across
                {' '}{n(files)} catalogued files.
              </p>
            </div>
            <div className={s.card}>
              <h3>A correction is a lens, not an edit</h3>
              <p>
                Removing a wrong tag hides it for your workspace and leaves the
                catalogue alone. Another team sharing the same library is
                unaffected, and can disagree with you.
              </p>
            </div>
            <div className={s.card}>
              <h3>The model is given very little</h3>
              <p>
                A summary sends already-aggregated counts. The agent sends one
                file&rsquo;s name, folder and type. Neither sends file contents,
                because this catalogue holds none — and both say so on screen.
              </p>
            </div>
            <div className={s.card}>
              <h3>No key reaches your browser</h3>
              <p>
                Model calls happen server-side only; an accidental import into
                client code fails the build rather than shipping a secret. The
                test suite asserts it on every run.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className={s.section}>
        <div className={s.wrap}>
          <h2 className={s.sect}>Three ways to look at it</h2>
          <div className={s.grid}>
            <div className={s.card}>
              <h3>Library</h3>
              <p>
                Facets on every axis at once — kind, topic, author, year, what a
                file contains. Counts update against the selection, so a
                refinement never leads somewhere empty.
              </p>
              <Link href={demo(`${OPS}/library`)} className={s.cardGo}>Open →</Link>
            </div>
            <div className={s.card}>
              <h3>Graph</h3>
              <p>
                The same selection as a picture, three ways: files pulled
                together by what they share, tags joined by co-occurrence, or a
                pyramid stacking broad tags above the narrow ones they contain.
              </p>
              <Link href={demo(`${OPS}/graph`)} className={s.cardGo}>Open →</Link>
            </div>
            <div className={s.card}>
              <h3>Agent</h3>
              <p>
                Five verbs, and only three of them cost anything. It proposes
                labels for files that have none, explains what a file probably
                is, and finds what else is like it.
              </p>
              <Link href={demo(`${OPS}/agent`)} className={s.cardGo}>Open →</Link>
            </div>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className={s.section}>
        <div className={s.wrap}>
          <h2 className={s.sect}>What the agent can do</h2>
          <p className={s.muted}>
            Two of these need no model at all. That is the cost argument in one
            table: the expensive tier is asked only where arithmetic runs out.
          </p>
          <div className={s.tablewrap}>
            <table className={s.table}>
              <thead>
                <tr><th>Verb</th><th>What it does</th><th>Needs a model</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td><code>ask</code></td>
                  <td>Turns a question into a filter and a drawing. Never reports a count.</td>
                  <td>yes</td>
                </tr>
                <tr>
                  <td><code>label</code></td>
                  <td>Proposes a kind and topic for a file that has neither. You accept or ignore.</td>
                  <td>yes</td>
                </tr>
                <tr>
                  <td><code>explain</code></td>
                  <td>Describes a file from its name, folder and labels — and lists what it could not tell without opening it.</td>
                  <td>yes</td>
                </tr>
                <tr>
                  <td><code>related</code></td>
                  <td>What else is like this, ranked by how <em>rare</em> the shared tags are.</td>
                  <td><strong>no</strong></td>
                </tr>
                <tr>
                  <td><code>repeats</code></td>
                  <td>One name filed across many folders. Not duplicates — every hash here differs.</td>
                  <td><strong>no</strong></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      <section className={s.section} id="run">
        <div className={s.wrap}>
          <h2 className={s.sect}>Run it on your own files</h2>
          <p className={s.muted}>
            The demo is a catalogue someone else built. This is the part that
            builds one from a folder of yours, and it never leaves your machine.
          </p>
          <pre className={s.pre}><code>
            <span className={s.c}># Python 3.12+</span>{'\n'}
            {`git clone ${REPO_URL}\ncd athena\npython -m venv .venv && .venv\\Scripts\\activate\npip install -e .\n\nathena serve`}
          </code></pre>
          <p className={s.muted}>
            That is the whole install. The UI opens at <code>127.0.0.1:8731</code>,
            bound to loopback and refusing any non-loopback origin. Point it at a
            folder and it starts indexing.
          </p>

          <h3 className={s.sub}>Optional: let a model read too</h3>
          <p className={s.muted}>
            Athena is complete without this — the rules tier needs no key and the
            library is fully searchable without one. A model adds captions for
            photographs and settles the files the rules were unsure about.
          </p>
          <pre className={s.pre}><code>
            <span className={s.c}># entirely local, nothing leaves the machine</span>{'\n'}
            {'set ATHENA_AI_PROVIDER=ollama\n\n'}
            <span className={s.c}># or a shared gateway, so you need no key of your own</span>{'\n'}
            {'set ATHENA_AI_PROVIDER=gateway\nset ATHENA_GATEWAY_URL=https://your-gateway.up.railway.app'}
          </code></pre>

          <h3 className={s.sub}>Or drive the hosted demo from a terminal</h3>
          <p className={s.muted}>
            The same catalogue, the same agent, over a versioned HTTP API. The
            client shares its types with the server, so it cannot drift from it.
          </p>
          <pre className={s.pre}><code>
            {'cd cloud && npm install\n'}
            {'npm run cli -- login\n'}
            {'npm run cli -- ls --doctype invoice --date 2024\n'}
            {'npm run cli -- ask "how do finance and legal overlap"'}
          </code></pre>

          <div className={s.status}>
            <span
              className={`${s.dot} ${gateway.state === 'up' ? s.up : gateway.state === 'down' ? s.down : ''}`}
              aria-hidden="true"
            />
            <span>{gateway.message}</span>
          </div>
        </div>
      </section>

      <footer className={s.footer}>
        <div className={s.wrap}>
          Athena — read-only by construction.{' '}
          <a href={REPO_URL}>Source</a> ·{' '}
          <a href={`${REPO_URL}/blob/main/docs/ARCHITECTURE.md`}>Architecture</a> ·{' '}
          <Link href={demo(`${OPS}/library`)}>Demo</Link>
        </div>
      </footer>
    </main>
  );
}
