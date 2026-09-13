import Link from 'next/link';
import s from './home.module.css';
import { getGatewayStatus } from '@/lib/gateway';

const REPO_URL = 'https://github.com/s4196552/athena';

/* The landing page is a server component and the gateway health check happens
 * server-side, once a minute, shared across every visitor. The static page it
 * replaces did this from the browser, which is why the old CSP needed
 * `connect-src *`. Moving the fetch here is what lets that tighten to 'self'. */
export const revalidate = 60;

export default async function Home() {
  const gateway = await getGatewayStatus();

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
            Athena walks a folder, reads every file in it, and builds a searchable,
            tagged, cross-linked index — photographs, documents, audio, video, code.
            It is Google Photos for general data, except the data never leaves the
            shape you put it in.
          </p>
          <div className={s.cta}>
            <Link className={`${s.btn} ${s.primary}`} href="/login">
              Open the demo →
            </Link>
            <a className={`${s.btn} ${s.ghost}`} href={REPO_URL}>Get the source</a>
            <a className={`${s.btn} ${s.ghost}`} href="#run">Run it locally</a>
          </div>

          <div className={s.promise}>
            <h2>The guarantee</h2>
            <p>
              Athena opens every file read-only and re-hashes it afterwards. Not one
              byte, filename, timestamp or folder is modified — the entire index
              lives in a separate SQLite database under <code>%LOCALAPPDATA%\Athena</code>.
              Verified on every run: a 2,396-file library indexed end to end,{' '}
              <strong>0 integrity mutations</strong>.
            </p>
          </div>
        </div>
      </header>

      <section className={s.section}>
        <div className={s.wrap}>
          <h2 className={s.sect}>What it does</h2>
          <div className={s.grid}>
            <div className={s.card}>
              <h3>Parses everything</h3>
              <p>
                EXIF, ID3, PDF text, DOCX, PPTX, spreadsheets, OCR, video keyframes,
                perceptual hashes, duplicate detection by content.
              </p>
            </div>
            <div className={s.card}>
              <h3>Classifies itself</h3>
              <p>
                An agent reads what the parsers found and decides what each file{' '}
                <em>is</em> and what it is <em>about</em> — on two separate axes, so
                &ldquo;finance&rdquo; and &ldquo;presentation&rdquo; are not alternatives.
              </p>
            </div>
            <div className={s.card}>
              <h3>Answers questions</h3>
              <p>
                Filter to a selection, then ask what it adds up to. Every figure is
                arithmetic over extracted values — no model invents a number.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className={s.section}>
        <div className={s.wrap}>
          <h2 className={s.sect}>Shared libraries</h2>
          <p className={s.muted}>
            One catalogue, many teams. A library is owned by an organisation and
            reached through a grant, so HadesMedia Marketing and HadesMedia Finance
            read the <em>same</em> index — each scoped to what it needs, each with its
            own tags, saved views and graph colours. Nothing is copied, so a tag
            applied in one workspace is the same tag the other filters on.
          </p>
          <div className={s.cta}>
            <Link className={`${s.btn} ${s.ghost}`} href="/login">See it in the demo</Link>
          </div>
        </div>
      </section>

      <section className={s.section}>
        <div className={s.wrap}>
          <h2 className={s.sect}>The agent</h2>
          <p className={s.muted}>
            Deterministic rules run on every file in about three milliseconds, with no
            GPU, no key and no network. A language model is asked only about the files
            the rules could not settle — measured at roughly 11% of a real library.
            That is the whole cost argument: the other 89% never reach a model.
          </p>
          <div className={s.tablewrap}>
            <table className={s.table}>
              <thead>
                <tr><th>Axis</th><th>Example</th><th>Derived from</th></tr>
              </thead>
              <tbody>
                <tr><td><code>doctype</code></td><td>invoice, contract, log, CV, deck</td><td>structural patterns + lexicons</td></tr>
                <tr><td><code>topic</code></td><td>finance, legal, engineering, security</td><td>the same, on a separate axis</td></tr>
                <tr><td><code>author</code></td><td>Jane Doe</td><td>document properties → signature → byline → filename</td></tr>
                <tr><td><code>date</code></td><td>2024</td><td>the date <em>inside</em> the document</td></tr>
                <tr><td><code>pattern</code></td><td>monetary amounts, stack traces, possible secrets</td><td>~30 shape detectors</td></tr>
                <tr><td><code>custom</code></td><td>anything you type</td><td>you — attached to content, so duplicates share it</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className={s.section} id="run">
        <div className={s.wrap}>
          <h2 className={s.sect}>Run it</h2>
          <pre className={s.pre}><code>
            <span className={s.c}># Python 3.12+</span>{'\n'}
            {`git clone ${REPO_URL}\ncd athena\npython -m venv .venv && .venv\\Scripts\\activate\npip install -e .\n\nathena serve`}
          </code></pre>
          <p className={s.muted}>
            That is the whole install. The UI opens at <code>127.0.0.1:8731</code>,
            bound to loopback and refusing any non-loopback origin. Point it at a
            folder and it starts indexing.
          </p>

          <h3 style={{ marginTop: 30 }}>Optional: let a model read too</h3>
          <p className={s.muted}>
            Athena is complete without this — the rules tier needs no key and the
            library is fully searchable without one. A model adds captions for
            photographs and settles the files the rules were unsure about.
          </p>
          <pre className={s.pre}><code>
            <span className={s.c}># entirely local, nothing leaves the machine</span>{'\n'}
            {'set ATHENA_AI_PROVIDER=ollama\n\n'}
            <span className={s.c}># or a shared gateway, so you need no key of your own</span>{'\n'}
            {'set ATHENA_AI_PROVIDER=gateway\nset ATHENA_GATEWAY_URL=https://your-gateway.up.railway.app\nset ATHENA_GATEWAY_TOKEN=...'}
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
          <a href={`${REPO_URL}/blob/main/docs/ARCHITECTURE.md`}>Architecture</a>
        </div>
      </footer>
    </main>
  );
}
