/* End-to-end checks against a running server.
 *
 *   Terminal 1:  npm run build && npm start
 *   Terminal 2:  npm run verify
 *
 * No test framework and no dependencies: plain Node, so it runs on a fresh
 * clone with nothing installed beyond what the app already needs.
 *
 * Sessions are minted with the SAME HMAC scheme lib/auth/cookie.ts uses, which
 * means these exercise the real verify() in proxy.ts rather than bypassing
 * authentication to get at the pages behind it.
 */
import { webcrypto as crypto } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.ATHENA_TEST_BASE ?? 'http://localhost:3000';
const here = dirname(fileURLToPath(import.meta.url));

/** The server signs with AUTH_SECRET; to forge a valid cookie we need the same
 *  value it is running with. Prefer the environment, fall back to .env.local. */
function authSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  try {
    const env = readFileSync(join(here, '..', '.env.local'), 'utf8');
    const match = env.match(/^AUTH_SECRET=(.*)$/m);
    if (match) return match[1].trim();
  } catch { /* fall through */ }
  return 'athena-demo-fallback-not-a-security-boundary'; // DEMO_FALLBACK_KEY in cookie.ts
}

const SECRET = authSecret();
const enc = new TextEncoder();
const b64u = (b) => Buffer.from(b).toString('base64url');

async function mint(uid, wid, oid, { badSig = false, expired = false } = {}) {
  const claims = {
    uid, oid, wid,
    exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 7 * 24 * 3600),
    v: 1,
  };
  const payload = b64u(enc.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64u(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload))));
  return `athena_session=${payload}.${badSig ? sig.slice(0, -3) + 'aaa' : sig}`;
}

let failures = 0;
let checks = 0;
function check(label, pass, detail = '') {
  checks++;
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
}
function section(name) { console.log(`\n--- ${name} ---`); }

async function get(path, cookie) {
  const res = await fetch(BASE + path, {
    headers: cookie ? { cookie } : {},
    redirect: 'manual',
  });
  const text = res.status === 200 ? await res.text() : '';
  return { status: res.status, location: res.headers.get('location'), body: text };
}

async function json(path, cookie) {
  const res = await fetch(BASE + path, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, bytes: Buffer.byteLength(text), data: res.ok ? JSON.parse(text) : null };
}

// Fail fast with a useful message rather than 40 confusing connection errors.
try {
  const health = await fetch(`${BASE}/api/health`);
  if (!health.ok) throw new Error(`health returned ${health.status}`);
} catch (err) {
  console.error(`\nCannot reach ${BASE} — start the server first:\n`);
  console.error('    npm run build && npm start\n');
  console.error(`(${err.message})\n`);
  process.exit(2);
}

const priya = await mint('u_priya', 'w_mkt', 'o_hades');  // Marketing AND Finance
const tomas = await mint('u_tomas', 'w_fin', 'o_hades');  // Finance only
const iris = await mint('u_iris', 'w_ops', 'o_hades');    // Studio Ops, unscoped

// ===========================================================================
section('catalogue loaded');
// ===========================================================================
{
  const r = await json('/api/health?deep=1');
  check('deep health reads the seed', r.status === 200 && r.data?.ok, `status ${r.status}`);
  const main = r.data?.catalogue?.find((l) => l.slug === 'hadesmedia-main');
  check('main library has its files', main?.files === 6120, `${main?.files} files`);
  check('read-only guarantee carried through', main?.mutations === 0);
  // Sign-in must work whether or not AUTH_SECRET is configured: with fixture
  // accounts the fallback key is intended, and a demo that needs an env var to
  // open its own front door is a demo nobody sees.
  check('session signing is possible', typeof r.data?.authSecret === 'string'
    && !String(r.data.authSecret).startsWith('MISSING'), String(r.data?.authSecret));
}

// ===========================================================================
section('signed out');
// ===========================================================================
{
  const r = await get('/w/hadesmedia-marketing');
  check('protected route redirects to /login', r.status === 307 && (r.location ?? '').includes('/login'),
    `status ${r.status}`);
  check('redirect preserves the requested path',
    (r.location ?? '').includes('next=%2Fw%2Fhadesmedia-marketing'));
  const api = await json('/api/w/hadesmedia-ops/graph?mode=files');
  check('API answers 401, not an HTML redirect', api.status === 401, `status ${api.status}`);
}
{
  const r = await get('/login');
  check('login page renders', r.status === 200 && r.body.includes('Choose an account'));
  check('offers demo accounts', r.body.includes('Priya Raman'));
  check('says plainly there is no sign-up or password',
    /no sign-up and no passwords/i.test(r.body));
  check('no password field is presented', !/type="password"/i.test(r.body));
  check('sign-up route is gone', (await get('/signup')).status === 404);
}

// ===========================================================================
section('forged and expired cookies');
// ===========================================================================
{
  const bad = await mint('u_priya', 'w_mkt', 'o_hades', { badSig: true });
  check('tampered signature rejected', (await get('/w/hadesmedia-marketing', bad)).status === 307);
  const old = await mint('u_priya', 'w_mkt', 'o_hades', { expired: true });
  check('expired cookie rejected', (await get('/w/hadesmedia-marketing', old)).status === 307);
}

// ===========================================================================
section('THE SHARED-DATABASE CLAIM');
// ===========================================================================
/* One person, one cookie, two workspaces, one underlying library. If these
   pass, "Marketing and Finance share a catalogue" is a fact rather than a
   diagram. */
{
  const countOf = (body) => {
    const m = body.match(/statValue[^>]*>([\d,]+)<\/div><div class="[^"]*statLabel[^>]*>Files in scope/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  const mkt = await get('/w/hadesmedia-marketing', priya);
  const fin = await get('/w/hadesmedia-finance', priya);
  check('Marketing renders for Priya', mkt.status === 200);
  check('Finance renders for the same cookie', fin.status === 200);

  const m = countOf(mkt.body);
  const f = countOf(fin.body);
  check('the two workspaces report different counts', m !== null && f !== null && m !== f,
    `Marketing ${m?.toLocaleString()} vs Finance ${f?.toLocaleString()}`);

  const sharing = await get('/org/hadesmedia/libraries/hadesmedia-main', iris);
  check('sharing screen lists every grant', sharing.status === 200
    && ['Marketing', 'Finance', 'Studio Ops'].every((w) => sharing.body.includes(w)));
  check('sharing screen states it is not a copy', /nothing here is a copy/i.test(sharing.body));
}

// ===========================================================================
section('tenancy isolation');
// ===========================================================================
{
  check('non-member workspace 404s (not 403 — no existence leak)',
    (await get('/w/hadesmedia-ops', priya)).status === 404);
  check('Finance-only user cannot reach Marketing',
    (await get('/w/hadesmedia-marketing', tomas)).status === 404);
  check('non-member cannot reach the graph API',
    (await json('/api/w/hadesmedia-ops/graph?mode=files', priya)).status === 404);
}

// ===========================================================================
section('user tags are workspace-scoped');
// ===========================================================================
/* Machine tags are global facts about content; user tags are one team's
   opinion. Neither team may see the other's. */
{
  const m = await get('/w/hadesmedia-marketing/library', priya);
  const f = await get('/w/hadesmedia-finance/library', tomas);
  const MKT = /hero shot|press ready|q4 campaign|needs retouch/i;
  const FIN = /needs legal review|reconciled|fy24|disputed/i;
  check("Marketing shows Marketing's tags", MKT.test(m.body));
  check("Marketing does NOT show Finance's tags", !FIN.test(m.body));
  check("Finance shows Finance's tags", FIN.test(f.body));
  check("Finance does NOT show Marketing's tags", !MKT.test(f.body));
}

// ===========================================================================
section('library views');
// ===========================================================================
{
  const r = await get('/w/hadesmedia-ops/library', iris);
  check('library renders', r.status === 200);
  check('offers Auto / Grid / List', ['>Auto<', '>Grid<', '>List<'].every((x) => r.body.includes(x)));
  check('has an iCloud-style size slider', /type="range"/.test(r.body));
  // Auto splits on media type: a spreadsheet has no thumbnail worth 200px.
  check('auto mode separates media from documents',
    r.body.includes('Photos &') && r.body.includes('Documents &'));
  check('list carries the columns a document needs',
    ['>Kind<', '>Size<', '>Modified<', '>Folder<'].every((x) => r.body.includes(x)));
}

// ===========================================================================
section('file graph');
// ===========================================================================
{
  const r = await json('/api/w/hadesmedia-ops/graph?mode=files', iris);
  const g = r.data;
  check('responds', r.status === 200, `status ${r.status}`);
  // Bail rather than throw: a failed request here would otherwise crash the
  // run on the first property access and hide every check after it.
  if (!g) { check('payload present — remaining graph checks skipped', false); }
  else {
  check('caps at the node budget', g.ids.length === 2000, `${g.ids.length} nodes`);
  check('reports truncation honestly', g.truncated?.total === 6120, JSON.stringify(g.truncated));
  check('positions arrived precomputed', g.x.length === g.ids.length && g.x.some((v) => v !== 0));
  check('CSR tag matrix is consistent',
    g.tagOffsets.length === g.ids.length + 1 && g.tagOffsets.at(-1) === g.tagIndices.length);
  const avg = (g.edges.length / g.ids.length).toFixed(1);
  check('edge density is legible, not a hairball', avg > 1 && avg < 12, `avg degree ${avg}`);
  check('orphan rim is represented', g.degree.filter((d) => d === 0).length > 20,
    `${g.degree.filter((d) => d === 0).length} orphans`);
  check('payload stays small enough to ship', r.bytes < 500_000, `${(r.bytes / 1024).toFixed(0)} KB`);
  }
}

// ===========================================================================
section('tag graph (ported from athena/web/queries.py)');
// ===========================================================================
{
  const r = await json('/api/w/hadesmedia-ops/graph?mode=tags', iris);
  const g = r.data;
  if (!g) { check('tag graph payload present', false, `status ${r.status}`); }
  else {
  check('respects MAX_NODES = 60', g.nodes.length <= 60, `${g.nodes.length} nodes`);
  check('respects MIN_EDGE_WEIGHT = 2', g.edges.every((e) => e.weight >= 2));
  check('strength normalised to 0..1', g.edges.every((e) => e.strength > 0 && e.strength <= 1));
  const perKind = {};
  for (const n of g.nodes) perKind[n.kind] = (perKind[n.kind] ?? 0) + 1;
  check('respects MAX_PER_KIND = 12', Object.values(perKind).every((c) => c <= 12), JSON.stringify(perKind));
  check('picture stays mixed across kinds', Object.keys(perKind).length >= 4);

  // The reason `strength` exists: ranking by raw count makes every top edge
  // "2024 - something", which is a base rate rather than a relationship.
  const topLabel = g.nodes.find((n) => n.tid === g.edges[0]?.source)?.label ?? '';
  check('strongest edge is a relationship, not a base rate', !/^20\d\d$/.test(topLabel),
    `top edge starts at "${topLabel}"`);
  }
}

// ===========================================================================
section('pyramid graph');
// ===========================================================================
{
  const r = await json('/api/w/hadesmedia-ops/graph?mode=pyramid', iris);
  const t = await json('/api/w/hadesmedia-ops/graph?mode=tags', iris);
  const g = r.data;
  if (!g || !t.data) { check('pyramid payload present', false, `status ${r.status}`); }
  else {
  check('serves the same tags as the tag graph', g.nodes.length === t.data.nodes.length,
    `${g.nodes.length} vs ${t.data.nodes.length}`);
  // The one difference between the two modes, and the reason it exists: the
  // pyramid derives containment from this table, so a pair dropped by the edge
  // budget would silently flatten a level out of the hierarchy.
  check('ships the pair table untruncated', g.edges.length >= t.data.edges.length,
    `${g.edges.length} edges vs the tag graph's ${t.data.edges.length}`);
  check('every edge carries the count the layout divides by',
    g.edges.every((e) => Number.isInteger(e.weight) && e.weight >= 2));
  check('every endpoint is a node that was actually sent', (() => {
    const tids = new Set(g.nodes.map((n) => n.tid));
    return g.edges.every((e) => tids.has(e.source) && tids.has(e.target));
  })());
  check('no pair claims more files than the rarer tag has', (() => {
    const n = new Map(g.nodes.map((x) => [x.tid, x.n]));
    return g.edges.every((e) => e.weight <= Math.min(n.get(e.source), n.get(e.target)));
  })());
  check('there is a hierarchy in the seeded library to draw', (() => {
    const n = new Map(g.nodes.map((x) => [x.tid, x.n]));
    return g.edges.some((e) => {
      const smaller = Math.min(n.get(e.source), n.get(e.target));
      return e.weight / smaller >= 0.6 && n.get(e.source) !== n.get(e.target);
    });
  })(), 'at least one pair clears the default 60% containment');
  check('payload stays small enough to ship', r.bytes < 200_000, `${(r.bytes / 1024).toFixed(0)} KB`);
  }
}

{
  const filtered = await json('/api/w/hadesmedia-ops/graph?mode=pyramid&topic=finance', iris);
  check('a filter narrows the pyramid too', filtered.data?.files > 0
    && filtered.data.files < (await json('/api/w/hadesmedia-ops/graph?mode=pyramid', iris)).data.files);
  check('an unknown mode still falls back to files',
    (await json('/api/w/hadesmedia-ops/graph?mode=triangle', iris)).data?.mode === 'files');
}

// ===========================================================================
section('filtering');
// ===========================================================================
{
  const all = await json('/api/w/hadesmedia-ops/graph?mode=files', iris);
  const one = await json('/api/w/hadesmedia-ops/graph?mode=files&topic=finance', iris);
  check('a topic filter narrows the selection', one.data.files < all.data.files,
    `${all.data.files} -> ${one.data.files}`);
  check('the filtered graph still has structure', one.data.edges.length > 0,
    `${one.data.edges.length / 2} edges`);
}

// ===========================================================================
section('paging and search');
// ===========================================================================
{
  /* Before this existed, PAGE_SIZE was 120, the repository returned a correct
     nextCursor, and the UI printed "Showing the first 120 of 6,120" as plain
     text with nothing to click -- so files 121 onwards could not be reached by
     anyone using the app as intended. */
  const strip = (h) => h.replace(/<!--[\s\S]*?-->/g, '');
  const range = (h) => (strip(h).match(/pagerCount"[^>]*>([^<]*)</) ?? [, ''])[1];
  const lib = '/w/hadesmedia-ops/library';

  const first = await get(lib, iris);
  const second = await get(`${lib}?cursor=120`, iris);
  const last = await get(`${lib}?cursor=6000`, iris);

  check('the first page is numbered from one', range(first.body) === '1–120 of 6,120', range(first.body));
  check('a cursor advances the page', range(second.body) === '121–240 of 6,120', range(second.body));
  check('the last file is reachable', range(last.body) === '6,001–6,120 of 6,120', range(last.body));
  check('the last page offers no next', !/pagerBtn" href="[^"]*cursor=6120/.test(last.body));

  // A negative offset would count from the END of the array in Array.slice,
  // serving a page nobody asked for rather than failing.
  check('a negative cursor is ignored', range((await get(`${lib}?cursor=-5`, iris)).body) === '1–120 of 6,120');
  check('a non-numeric cursor is ignored', range((await get(`${lib}?cursor=abc`, iris)).body) === '1–120 of 6,120');

  const items = (h) => (strip(h).match(/>([\d,]+ items?[^<]*)</) ?? [, ''])[1];
  const found = await get(`${lib}?q=vortex`, iris);
  check('the library has a search control', /name="q"/.test(first.body));
  check('searching narrows the selection', items(found.body).includes('matching')
    && items(found.body) !== items(first.body), items(found.body));

  const both = await get(`${lib}?topic=design&q=vortex`, iris);
  check('searching keeps the facets already chosen', /topic=design/.test(both.body)
    && items(both.body) !== items(found.body), items(both.body));

  // Changing WHAT is selected has to return to page one, or the reader lands
  // on "241-360 of 118", which reads as "your filter found nothing".
  check('changing a facet returns to the first page',
    !/href="[^"]*cursor=\d+[^"]*"[^>]*class="[^"]*chip/.test(second.body)
    && !/chip[^"]*"[^>]*href="[^"]*cursor=/.test(second.body));
}

// ===========================================================================
section('appearance');
// ===========================================================================
{
  /* The choice is stamped on <html> by the SERVER, from a cookie. That is the
     whole design: anything the browser holds is unknown at render time, so the
     page would be emitted in one appearance and corrected in the other -- a
     flash on every navigation, and the same class of hydration mismatch that
     React #418 was (see lib/format.ts). */
  const html = (body) => (body.match(/<html[^>]*>/) ?? [''])[0];

  const none = await get('/login');
  check('no choice leaves the system to decide', !html(none.body).includes('data-theme'),
    'no data-theme attribute');

  const light = await get('/login', 'athena_theme=light');
  check('an explicit light choice is stamped server-side',
    html(light.body).includes('data-theme="light"'));

  const dark = await get('/login', 'athena_theme=dark');
  check('an explicit dark choice is stamped server-side',
    html(dark.body).includes('data-theme="dark"'));

  // The cookie is not httpOnly, so a viewer can put anything in it.
  const junk = await get('/login', 'athena_theme=neon');
  check('an unrecognised appearance falls back to the system',
    !html(junk.body).includes('data-theme'));

  check('the appearance control is offered', /aria-label="Appearance"/.test(
    (await get('/w/hadesmedia-ops', iris)).body));

  // next/font downloads at build time and serves from this origin, which is
  // what lets the CSP stay at `font-src 'self'`.
  const css = [...none.body.matchAll(/\/_next\/static\/chunks\/[\w.-]+\.css/g)].map((m) => m[0]);
  let faces = 0;
  let external = 0;
  for (const href of new Set(css)) {
    const sheet = await fetch(BASE + href).then((r) => r.text());
    faces += (sheet.match(/@font-face/g) ?? []).length;
    external += (sheet.match(/url\(https?:\/\//g) ?? []).length;
  }
  check('the typeface is served from this origin', faces > 0 && external === 0,
    `${faces} @font-face rules, ${external} external`);
}

// ===========================================================================
section('colour groups');
// ===========================================================================
{
  const firstColor = (b) => b.match(/type="color"[^>]*value="(#[0-9a-f]{6})"/i)?.[1];
  const m = await get('/w/hadesmedia-marketing/settings/colors', priya);
  const f = await get('/w/hadesmedia-finance/settings/colors', tomas);
  check('editor renders', m.status === 200);
  check('states the precedence rule', /first match wins/i.test(m.body));
  check('is honest about persistence', /read-only at runtime/i.test(m.body));
  check('each workspace colours the shared library its own way',
    firstColor(m.body) !== firstColor(f.body),
    `Marketing ${firstColor(m.body)} vs Finance ${firstColor(f.body)}`);
}

// ===========================================================================
section('tag icons');
// ===========================================================================
{
  // Material Symbols all share this viewBox, so counting it counts icons
  // without depending on any one glyph's path data.
  const page = await get('/w/hadesmedia-marketing/library', priya);
  const icons = (page.body.match(/viewBox="0 -960 960 960"/g) ?? []).length;
  check('facet chips and rows carry icons', icons > 60, `${icons} inline SVG icons`);
  check('icons are inline, not a webfont',
    !/fonts\.googleapis\.com|material-symbols-outlined/i.test(page.body),
    "no Google Fonts request, so font-src stays 'self'");
}

// ===========================================================================
section('tag corrections');
// ===========================================================================
{
  /* The overlay cookie is plain text by design (lib/overlay/codec.ts), so a
     correction can be asserted end to end without driving a browser through
     the server action that normally writes it. */
  const DESIGN = 14; // topic:design in the seeded vocabulary
  const countOf = (body) =>
    Number((body.match(/([\d,]+)\s+items?/)?.[1] ?? '0').replace(/,/g, ''));

  const before = await json('/api/w/hadesmedia-marketing/graph?mode=files&topic=design', priya);
  const victim = before.data.ids[0];
  const overlay = `athena_ov_w_mkt=1|r!${victim}-${DESIGN.toString(36)}`;

  const corrected = await json(
    '/api/w/hadesmedia-marketing/graph?mode=files&topic=design',
    `${priya}; ${overlay}`,
  );
  check('a removed tag drops the file from that filter',
    corrected.data.files === before.data.files - 1,
    `${before.data.files} -> ${corrected.data.files}`);

  const plain = await get('/w/hadesmedia-marketing/library?topic=design', priya);
  const fixed = await get('/w/hadesmedia-marketing/library?topic=design', `${priya}; ${overlay}`);
  check('the facet count follows the correction',
    countOf(fixed.body) === countOf(plain.body) - 1,
    `${countOf(plain.body)} -> ${countOf(fixed.body)}`);

  /* THE POINT OF AN OVERLAY RATHER THAN AN EDIT.
     Studio Ops holds an UNSCOPED grant on the same library, so the very file
     Marketing just corrected is in its selection too. If a removal were an edit
     to the catalogue, this count would move. It must not: the tag is still
     there, and Marketing has only stopped counting it.
     (Finance is the wrong workspace to ask -- its grant is scoped to
     Documents/ and _Archive/, so it never sees Marketing's files at all.) */
  const opsPlain = await get('/w/hadesmedia-ops/library?topic=design', iris);
  const opsWithOverlay = await get('/w/hadesmedia-ops/library?topic=design',
    `${iris}; ${overlay}`);
  check('the same file seen through another workspace is unaffected',
    countOf(opsPlain.body) === countOf(opsWithOverlay.body)
    && countOf(opsPlain.body) > countOf(plain.body),
    `Studio Ops still counts ${countOf(opsWithOverlay.body)}`);

  const wrongWs = await get('/w/hadesmedia-marketing/library?topic=design',
    `${priya}; athena_ov_w_fin=1|r!${victim}-${DESIGN.toString(36)}`);
  check('an overlay cookie naming another workspace is ignored',
    countOf(wrongWs.body) === countOf(plain.body));

  const nonsense = await get('/w/hadesmedia-marketing/library?topic=design',
    `${priya}; athena_ov_w_mkt=9|garbage!!~~`);
  check('an unknown overlay version is discarded, not guessed at',
    nonsense.status === 200 && countOf(nonsense.body) === countOf(plain.body));
}

// ===========================================================================
section('the agent');
// ===========================================================================
{
  const strip = (h) => h.replace(/<!--[\s\S]*?-->/g, '');
  const page = await get('/w/hadesmedia-ops/agent', iris);
  const body = strip(page.body);

  check('the agent page renders', page.status === 200);
  check('it counts the gap across the whole library, not just the queue',
    /Files with a gap/.test(body) && /No kind/.test(body) && /No topic/.test(body));

  const rows = (body.match(/__item"/g) ?? []).length;
  check('it queues files to review', rows > 0, `${rows} rows`);

  /* The claim the page makes about itself has to stay true: it does not have
     the engine's scores and must not imply that it does. */
  check('it says what the model is actually given',
    /cannot see the file/i.test(body) && /name_key/.test(body));
  check('it offers no confidence number it does not have',
    !/[^\d][01]\.\d\d[^\d]/.test(body));

  check('the agent is reachable from the workspace nav', /&gt;Agent&lt;|>Agent</.test(body));

  // A viewer may look but not accept. Same boundary as tag removal.
  const asViewer = await get('/w/hadesmedia-finance/agent', tomas);
  check('a read-only workspace still gets the queue', asViewer.status === 200);

  /* AN ACCEPTED SUGGESTION IS THE MIRROR OF A REMOVAL.
     The overlay cookie is plain text, so the effect can be asserted without
     driving the server action -- exactly as the removal test does. `t` is the
     additions section, added after `r` and `a` shipped without a version bump,
     which only works because the decoder ignores section kinds it does not
     know. */
  const DESIGN = 14;
  const countOf = (h) => Number((strip(h).match(/([\d,]+)\s+items?/)?.[1] ?? '0').replace(/,/g, ''));

  const plain = await get('/w/hadesmedia-ops/library?topic=design', iris);
  const all = await json('/api/w/hadesmedia-ops/graph?mode=files', iris);
  const design = await json('/api/w/hadesmedia-ops/graph?mode=files&topic=design', iris);
  const outsider = all.data.ids.find((id) => !design.data.ids.includes(id));

  const added = `athena_ov_w_ops=1|t!${outsider}-${DESIGN.toString(36)}`;
  const after = await get('/w/hadesmedia-ops/library?topic=design', `${iris}; ${added}`);
  check('an accepted tag adds the file to that filter',
    countOf(after.body) === countOf(plain.body) + 1,
    `${countOf(plain.body)} -> ${countOf(after.body)}`);

  // Same guarantee the removal has, pointed the other way: an addition is this
  // workspace's opinion and must not reach anyone else's view of the library.
  const mktPlain = await get('/w/hadesmedia-marketing/library?topic=design', priya);
  const mktWithOps = await get('/w/hadesmedia-marketing/library?topic=design', `${priya}; ${added}`);
  check('another workspace is unaffected by it',
    countOf(mktWithOps.body) === countOf(mktPlain.body),
    `Marketing stays at ${countOf(mktPlain.body)}`);

  // Both opinions at once: the removal used to win, which would make an accept
  // appear to work and do nothing. The action drops the removal; this asserts
  // the read-time behaviour it relies on.
  const both = `athena_ov_w_ops=1|r!${outsider}-${DESIGN.toString(36)}|t!${outsider}-${DESIGN.toString(36)}`;
  const conflicted = await get('/w/hadesmedia-ops/library?topic=design', `${iris}; ${both}`);
  check('a removal still wins over an addition of the same tag',
    countOf(conflicted.body) === countOf(plain.body),
    `${countOf(conflicted.body)} vs ${countOf(plain.body)} unfiltered`);

  const junk = await get('/w/hadesmedia-ops/library?topic=design', `${iris}; athena_ov_w_ops=1|t!nope-zz`);
  check('an addition naming no real file changes nothing',
    countOf(junk.body) === countOf(plain.body));
}

// ===========================================================================
section('albums');
// ===========================================================================
{
  const g = await json('/api/w/hadesmedia-marketing/graph?mode=files&topic=design', priya);
  const [a, b, c] = g.data.ids;
  const album = `athena_ov_w_mkt=1|a!alb1~Brand%20refresh~${a}.${b}.${c}`;

  const page = await get('/w/hadesmedia-marketing/library?album=alb1', `${priya}; ${album}`);
  check('an album narrows the library to its members', /\b3 items\b/.test(page.body), '3 items');
  check('the album name is shown as an active filter', page.body.includes('Brand refresh'));
  check('the album appears in the rail', /Albums/.test(page.body));

  // Album membership and the tag algebra compose rather than override.
  const crossed = await get('/w/hadesmedia-marketing/library?album=alb1&topic=finance',
    `${priya}; ${album}`);
  check('an album intersects a tag filter rather than replacing it',
    !/\b3 items\b/.test(crossed.body));

  const missing = await get('/w/hadesmedia-marketing/library?album=nope', `${priya}; ${album}`);
  check('an unknown album shows nothing rather than everything',
    /\b0 items\b/.test(missing.body), 'a deleted album must not widen the selection');

  const forbidden = await get('/w/hadesmedia-finance/library?album=alb1', `${tomas}; ${album}`);
  check('albums are workspace-scoped like corrections', /\b0 items\b/.test(forbidden.body));

  /* Iris is a VIEWER in Marketing while Priya is an editor, on the same
     library with the same grant -- so this is the role half of
     can('tag') = min(role, grant access), asserted on the markup that is
     actually served rather than on the function in isolation. */
  const editor = await get('/w/hadesmedia-marketing/library', priya);
  const viewer = await get('/w/hadesmedia-marketing/library', iris);
  check('an editor is offered the album form', editor.body.includes('New album name'));
  check('a viewer is not', !viewer.body.includes('New album name'),
    'same workspace, same grant, lesser role');
}

// ===========================================================================
section('briefs');
// ===========================================================================
{
  const health = await json('/api/health');
  check('health reports whether a model key is configured',
    typeof health.data.ai?.configured === 'boolean',
    `ai.configured = ${health.data.ai?.configured}, model ${health.data.ai?.model}`);

  /* The key must never appear in a response, and `configured` is the only
     field that may depend on it. A status endpoint that echoes a secret is a
     classic way to leak one.
     Two shapes, because Google issues both: `AIza...` from AI Studio and
     `AQ.Ab8...` from the OAuth-backed flow. Matching only the first is how a
     leak check passes while the key it was written to catch walks past it. */
  const body = JSON.stringify(health.data);
  check('the key itself is never reported',
    !/AIza[0-9A-Za-z_-]{10}|AQ\.[A-Za-z0-9_-]{20}|GEMINI_API_KEY=\S/.test(body));

  /* And never in the HTML either. lib/ai/gemini.ts imports `server-only`, so
     a client import fails the build -- this is the belt to that braces. */
  const lib = await get('/w/hadesmedia-ops/library', iris);
  check('the key never reaches the browser bundle',
    !/AIza[0-9A-Za-z_-]{10}|AQ\.[A-Za-z0-9_-]{20}/.test(lib.body));

  const page = await get('/w/hadesmedia-ops/library?topic=finance&doctype=invoice', iris);
  check('the library offers a summary of the selection',
    page.body.includes('Summarise'));
}

// ===========================================================================
section('reading a brief aloud');
// ===========================================================================
{
  const health = await json('/api/health');

  check('health reports whether a speech key is configured',
    typeof health.data.speech?.configured === 'boolean',
    `speech.configured = ${health.data.speech?.configured}, `
    + `model ${health.data.speech?.model}`);

  /* Same rule as the model key: presence may be reported, the value may not.
     Both ElevenLabs shapes are matched -- the current `sk_` keys and the bare
     32-character hex of older ones -- because matching only the current format
     is how a leak check passes while the key it was written to catch walks
     straight past it. */
  const KEY_SHAPE = /sk_[0-9a-f]{24}|ELEVENLABS_API_KEY=\S|xi-api-key/;
  check('the speech key itself is never reported',
    !KEY_SHAPE.test(JSON.stringify(health.data)));

  /* lib/ai/elevenlabs.ts imports `server-only`, so a client import fails the
     build. This is the belt to that braces -- the same pair the Gemini key
     gets, because a second key is a second chance to ship one. */
  const lib = await get('/w/hadesmedia-ops/library?topic=finance', iris);
  check('the speech key never reaches the browser bundle', !KEY_SHAPE.test(lib.body));

  /* blob: audio is blocked with NO VISIBLE ERROR when media-src falls back to
     default-src, so the header is asserted rather than trusted. */
  const csp = (await fetch(`${BASE}/api/health`)).headers.get('content-security-policy') ?? '';
  check('the CSP allows blob audio', /media-src[^;]*blob:/.test(csp),
    csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('media-src')) ?? 'no media-src');

  const speak = (ws, cookie, body) => fetch(`${BASE}/api/w/${ws}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });

  const anon = await speak('hadesmedia-ops', null, { query: '' });
  check('speech refuses a signed-out caller', anon.status === 401, `status ${anon.status}`);

  /* Priya, not Iris: Iris is a viewer in Marketing, so she is a MEMBER there
     and would legitimately get past this. Priya is in Marketing, Finance and
     Publishing and in no sense in Ops, which is the pair the tenancy section
     above uses for the same reason.

     404 rather than 403, and it must land BEFORE the missing-key 503 -- a
     non-member learning which optional services a workspace has configured is
     a small existence leak, and the cheapest time to get the order right is
     while writing it. */
  const wrongWs = await speak('hadesmedia-ops', priya, { query: '' });
  check('speech refuses a workspace the caller is not in',
    wrongWs.status === 404, `status ${wrongWs.status}`);

  /* THE ONE THAT MATTERS. The route takes a filter and rebuilds the brief from
     the catalogue; it must never speak text a caller supplied, or the endpoint
     is a free speech service billed to one key. Extra fields are sent and the
     answer must not depend on them. */
  const configured = health.data.speech?.configured === true;
  const injected = await speak('hadesmedia-ops', iris, {
    query: '',
    text: 'read this instead',
    input: 'or this',
  });

  if (configured) {
    const type = injected.headers.get('content-type') ?? '';
    check('speech answers with audio, never with the posted text',
      type.startsWith('audio/') || injected.status === 429,
      `status ${injected.status}, ${type}`);
  } else {
    const body = await injected.json().catch(() => ({}));
    check('speech says plainly that no key is configured',
      injected.status === 503 && /speech key/i.test(body.error ?? ''),
      `status ${injected.status}`);
    check('no key means no Listen control is drawn',
      !lib.body.includes('>Listen<'),
      'a control that cannot work should not be shown');
  }

  const empty = await speak('hadesmedia-ops', iris, { query: 'q=zzzznothingmatchesthis' });
  check('speech refuses an empty selection rather than reading nothing',
    empty.status === 422 || empty.status === 503, `status ${empty.status}`);
}


// ===========================================================================
section("reading the agent's answers aloud");
// ===========================================================================
{
  const src = (...parts) => readFileSync(join(here, '..', ...parts), 'utf8');

  /* THE INVARIANT THIS FEATURE STANDS ON, asserted against the source because
     it cannot be observed from outside: listening never spends a model call.
     The brief is REBUILT, which is free; the agent's two answers can only be
     RECALLED, because they came out of a model and re-running one would bill
     for prose already on the screen and could read the person different words
     than the ones they are looking at. If this route ever imports the model,
     that promise is gone and nothing else here would notice. */
  const route = src('app', 'api', 'w', '[ws]', 'speak', 'route.ts');
  check('listening can recall an agent answer', route.includes('recallAnswer'));
  check('and can never generate one',
    !/from '@\/lib\/agent\/(explain|view)'/.test(route)
    && !/from '@\/lib\/ai\/gemini'/.test(route),
    'the speech route imports no model');
  check('the brief is still rebuilt rather than recalled',
    route.includes("model: 'cached-only'"),
    'arithmetic is free to repeat; a model call is not');

  /* No variant of the subject type carries text. This is the client half of
     "the caller does not supply the text" -- the route strips unknown fields
     anyway, but a type with no text-shaped field in it is the version a future
     edit cannot quietly undo. */
  const button = src('components', 'speech', 'ListenButton.tsx');
  for (const shape of ["kind: 'brief'; query: string", "kind: 'explain'; fileId: string",
    "kind: 'plan'; question: string"]) {
    check(`the speech subject can name the ${shape.split("'")[1]} kind`, button.includes(shape));
  }
  check('and no variant of it carries text to be spoken',
    !/kind: '[a-z]+'; (text|body|speech|content):/.test(button));

  /* An answer is remembered where it is produced, which is also what makes
     asking the same thing twice cost once. Both verbs, because only one of
     them having it would be the harder bug to find. */
  const actions = src('app', 'w', '[ws]', 'agent', 'actions.ts');
  check('an explanation is remembered when it is produced',
    /rememberAnswer\(key, \{ kind: 'explain'/.test(actions));
  check('and a view plan is too',
    /rememberAnswer\(key, \{ kind: 'plan'/.test(actions));

  const recallAt = actions.indexOf('recallAnswer(key)');
  check('a remembered explanation is returned before any budget is spent',
    recallAt > 0 && recallAt < actions.indexOf('await checkBudget()', recallAt),
    'a remembered answer costs nothing, so a budget must not refuse it');

  /* The count is recounted even on a remembered plan: the filter is what was
     remembered, the number is not, and a tag corrected since would change it.
     Reading a listener a count the screen no longer shows is the exact failure
     the whole model/arithmetic split exists to prevent. */
  check('a remembered plan is recounted before it is shown or spoken',
    actions.indexOf('const matches = page.files.length')
      > actions.indexOf('plan = remembered.plan'),
    'the filter is remembered; the number is recomputed');

  /* One lens implementation, because the recall key is built from it in two
     places -- the action that writes the answer and the route that reads it
     back. Two hand-written copies differing by a dedupe would simply never
     find each other, and the symptom would be a Listen button that always
     says "ask again". */
  check('both halves of the recall key use one lens',
    actions.includes("from '@/lib/data/lens'") && route.includes("from '@/lib/data/lens'"));

  const speakAgent = (ws, cookie, body) => fetch(`${BASE}/api/w/${ws}/speak`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
    redirect: 'manual',
  });

  const health = await json('/api/health');
  const configured = health.data.speech?.configured === true;

  if (configured) {
    const unknown = await speakAgent('hadesmedia-ops', iris, { kind: 'sing' });
    check('an unknown kind is refused', unknown.status === 400, `status ${unknown.status}`);

    const noFile = await speakAgent('hadesmedia-ops', iris, { kind: 'explain' });
    check('explaining nothing is refused', noFile.status === 400, `status ${noFile.status}`);

    const noQuestion = await speakAgent('hadesmedia-ops', iris, { kind: 'plan', question: '  ' });
    check('a blank question is refused', noQuestion.status === 400, `status ${noQuestion.status}`);

    /* Nothing has been asked on this server, so nothing is remembered -- and
       the answer must be "ask again", never a fresh model call. 409 rather
       than 500: the words are not missing so much as no longer current here,
       which is an ordinary Tuesday on a platform that starts lambdas freely. */
    const cold = await speakAgent('hadesmedia-ops', iris, {
      kind: 'plan', question: 'nobody has asked this on this server',
    });
    const coldBody = await cold.json().catch(() => ({}));
    check('an answer this server never heard is refused, not regenerated',
      cold.status === 409, `status ${cold.status}`);
    check('and the refusal says asking again is the fix',
      /ask again/i.test(coldBody.error ?? ''), (coldBody.error ?? '').slice(0, 80));
    check('and says listening never re-runs the model on its own',
      /never re-runs the model/i.test(coldBody.error ?? ''));

    // A file id the caller cannot see resolves to nothing here exactly as it
    // does on every other read, and before anything is remembered or spoken.
    const foreign = await speakAgent('hadesmedia-ops', iris, {
      kind: 'explain', fileId: 'file_does_not_exist',
    });
    check('an unknown file is not found rather than described',
      foreign.status === 404, `status ${foreign.status}`);
  } else {
    /* Not skipped quietly. The key-dependent half of this feature is
       unexercised on a server with no key, and saying so is the difference
       between a suite that passed and a suite that checked. */
    check('no speech key, so the agent-speech requests are not exercised', true,
      'set ELEVENLABS_API_KEY and re-run to cover kind and recall handling');
  }

  /* The control appears only next to an answer, in all three places. When no
     key is configured it is absent rather than present and failing, which is
     the same shape every other optional-service control takes here. */
  const agentPage = await get('/w/hadesmedia-ops/agent', iris);
  check('the agent page draws no Listen control before anything is asked',
    !agentPage.body.includes('>Read it out<'),
    'audio is never the only copy of an answer, so it needs an answer first');
}


// ===========================================================================
section('the agent: ask, explain, relate');
// ===========================================================================
{
  const page = await get('/w/hadesmedia-ops/agent', iris);

  check('the agent page offers to turn a question into a view',
    page.body.includes('Ask for a view'));
  check('and says plainly that it does not produce the number',
    page.body.includes('the catalogue does the counting'));

  /* The repeats section is computed on every render and costs nothing, so it
     is either there or the finder is broken. The seed has 50 groups in the
     main library; Studio Ops sees a scoped slice of it. */
  const hasRepeats = page.body.includes('The same name, filed in several places');
  check('the agent page reports names filed in several places', hasRepeats);
  if (hasRepeats) {
    check('and says they are not duplicates', page.body.includes('different content hash'),
      'every assetId in the seed is distinct, so claiming duplication would be false');
  }

  /* THE FILTER ROUND TRIP. planView returns tag names in the catalogue's own
     casing -- "SolarVanguard", not "solarvanguard" -- and that string goes
     into a URL, back through parseFilterParams, and into the repository. If
     any step lowercased it the view would come back empty while looking like
     a considered answer, which is the exact failure the validator exists to
     prevent. Asserted end to end rather than trusted. */
  const entity = await get('/w/hadesmedia-ops/library?entity=SolarVanguard', iris);
  const count = entity.body.match(/([\d,]+)\s+items?/);
  check('a mixed-case tag name survives the URL round trip',
    entity.status === 200 && !!count && Number(count[1].replace(/,/g, '')) > 0,
    count ? `${count[1]} items` : 'no count line found');

  /* And the mode a plan picks has to survive the link, or a question about
     overlap would open the file graph and quietly answer something else. */
  const graph = await get('/w/hadesmedia-ops/graph?topic=finance&mode=tags', iris);
  check('the graph accepts a mode from the URL', graph.status === 200);
  const api = await json('/api/w/hadesmedia-ops/graph?mode=tags&topic=finance', iris);
  check('and the tag graph it asks for has nodes',
    api.status === 200 && (api.data?.nodes?.length ?? 0) > 0,
    `${api.data?.nodes?.length ?? 0} nodes`);

  /* Every verb that spends a model call must refuse a non-member BEFORE it
     spends anything. Server actions are not reachable by a plain fetch, so
     this asserts the page they live on is gated, which is the same boundary. */
  const outsider = await get('/w/hadesmedia-ops/agent', priya);
  check('a non-member cannot reach the agent at all', outsider.status === 404,
    `status ${outsider.status}`);
}


// ===========================================================================
section('the v1 API, which the CLI talks to');
// ===========================================================================
{
  const api = (path, cookie, init = {}) => fetch(`${BASE}/api/v1${path}`, {
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    redirect: 'manual',
    ...init,
  });

  const apiJson = async (path, cookie, init) => {
    const res = await api(path, cookie, init);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* asserted below */ }
    return { status: res.status, data, res };
  };

  /* Every route answers JSON, including its failures. A CLI that gets an HTML
     login page where it expected an object cannot report anything useful, and
     the page equivalents DO redirect -- which is right for a browser and the
     reason these routes exist separately. */
  const anon = await apiJson('/me');
  check('the API refuses a signed-out caller with JSON',
    anon.status === 401 && typeof anon.data?.error === 'string',
    `status ${anon.status}`);
  check('and does not redirect to the login page',
    !anon.res.headers.get('location'),
    'a 307 would be parsed as an answer by anything following redirects');
  check('the refusal says what to do about it', typeof anon.data?.hint === 'string');

  /* The account list is published only while the deployment runs on fixtures.
     The CLI reads it instead of hardcoding one -- the first draft hardcoded
     five addresses on the wrong domain and every one failed to sign in. */
  const accounts = await apiJson('/accounts');
  check('the demo accounts are published for a client with no screen',
    accounts.status === 200 && Array.isArray(accounts.data?.accounts)
      && accounts.data.accounts.length > 0,
    `${accounts.data?.accounts?.length ?? 0} accounts`);
  check('each account says which workspaces it reaches',
    (accounts.data?.accounts ?? []).every((a) => Array.isArray(a.workspaces)),
    'a list of addresses with no distinction makes everyone pick the first');
  /* Asserted on the SHAPE rather than by grepping for the word "password":
     the reply legitimately carries a `passwordRequired` flag, so a keyword
     scan fails on its own field name while a stray hash in an account object
     would slip past a sloppier pattern. */
  check('an account carries only what a picker needs',
    (accounts.data?.accounts ?? []).every((a) =>
      Object.keys(a).sort().join(',') === 'email,name,workspaces'),
    Object.keys(accounts.data?.accounts?.[0] ?? {}).join(','));
  check('and the reply says whether a password is needed',
    accounts.data?.passwordRequired === false);

  /* THE LOGIN ROUND TRIP. The whole CLI rests on this one exchange: post an
     email, get a cookie back, and have that cookie work on the next call. */
  const first = accounts.data.accounts[0];
  const loginRes = await api('/login', null, {
    method: 'POST',
    body: JSON.stringify({ email: first.email }),
  });
  check('login accepts a fixture email', loginRes.status === 200, `status ${loginRes.status}`);

  const setCookie = (loginRes.headers.getSetCookie?.() ?? [])
    .find((c) => c.startsWith('athena_session='));
  check('login issues a session cookie', Boolean(setCookie));
  check('the session cookie is HttpOnly', /httponly/i.test(setCookie ?? ''),
    'a CLI does not need script access to it and a browser must not have it');

  if (setCookie) {
    const minted = setCookie.split(';')[0];
    const me = await apiJson('/me', minted);
    check('and that cookie works on the next call',
      me.status === 200 && me.data?.user?.email === first.email,
      `${me.status}, ${me.data?.user?.email ?? 'no user'}`);
    check('me reports the workspaces it can reach',
      Array.isArray(me.data?.workspaces) && me.data.workspaces.length > 0);
  }

  const bad = await apiJson('/login', null, {
    method: 'POST',
    body: JSON.stringify({ email: 'nobody@nowhere.example' }),
  });
  check('login refuses an unknown email', bad.status === 401, `status ${bad.status}`);

  // --- the catalogue, through the API ---------------------------------------

  const outside = await apiJson('/w/hadesmedia-ops/files', priya);
  check('the API hides a workspace the caller is not in',
    outside.status === 404, `status ${outside.status}`);

  /* THE NUMBERS MUST MATCH THE PAGE. The API and the library page are two
     renderings of one repository call, and a client that reported a different
     total from the browser would be worse than no client. */
  const apiFiles = await apiJson('/w/hadesmedia-ops/files?doctype=invoice', iris);
  const pageFiles = await get('/w/hadesmedia-ops/library?doctype=invoice', iris);
  const pageCount = pageFiles.body.match(/([\d,]+)\s+items?/);
  check('the API total matches what the page prints',
    apiFiles.status === 200 && !!pageCount
      && apiFiles.data.total === Number(pageCount[1].replace(/,/g, '')),
    `api ${apiFiles.data?.total}, page ${pageCount?.[1]}`);

  check('the filter is echoed back as the server understood it',
    apiFiles.data?.filter?.doctype === 'invoice',
    'a mistyped axis is ignored by the parser and otherwise looks like a match');

  /* An unbounded limit turns one request into the whole catalogue. 6,120
     records here; worse on a real library. */
  const greedy = await apiJson('/w/hadesmedia-ops/files?limit=999999', iris);
  check('limit is capped rather than honoured',
    greedy.status === 200 && greedy.data.files.length <= 500,
    `asked for everything, got ${greedy.data?.files?.length}`);

  // Tenancy, asserted through the API rather than only through the pages.
  const mkt = await apiJson('/w/hadesmedia-marketing/files', iris);
  check('two workspaces see different amounts of one catalogue',
    mkt.status === 200 && apiFiles.status === 200
      && mkt.data.total !== greedy.data.total,
    `marketing ${mkt.data?.total}, ops ${greedy.data?.total}`);

  const facets = await apiJson('/w/hadesmedia-ops/facets?doctype=invoice', iris);
  check('facets come back for a filtered selection',
    facets.status === 200 && (facets.data?.axes?.length ?? 0) > 0,
    `${facets.data?.axes?.length ?? 0} axes`);
  check('facet values carry no tag ids',
    !/\btagId\b/.test(JSON.stringify(facets.data ?? {})),
    'ids are a driver detail and are not stable across a reseed');

  const one = apiFiles.data?.files?.[0];
  if (one) {
    const detail = await apiJson(`/w/hadesmedia-ops/files/${one.id}`, iris);
    check('a file comes back with its tags and neighbours',
      detail.status === 200 && detail.data?.file?.id === one.id
        && Array.isArray(detail.data?.related));
    check('related files are scored between 0 and 1',
      (detail.data?.related ?? []).every((r) => r.score > 0 && r.score <= 1.0001),
      `top ${detail.data?.related?.[0]?.score?.toFixed(3) ?? 'none'}`);
    check('and every one names what it shares',
      (detail.data?.related ?? []).every((r) => Array.isArray(r.shared) && r.shared.length));
  }

  const missing = await apiJson('/w/hadesmedia-ops/files/f_does_not_exist', iris);
  check('an unknown file id is a 404, not an empty object',
    missing.status === 404, `status ${missing.status}`);

  /* The counted brief costs nothing with model=off, so it is safe to assert on
     every run. The model-backed half is exercised by hand, not here -- a test
     suite that spends the day's budget is a test suite people stop running. */
  const brief = await apiJson('/w/hadesmedia-ops/brief?doctype=invoice&model=off', iris);
  check('a brief can be produced without spending a model call',
    brief.status === 200 && brief.data?.producedBy === 'counted'
      && brief.data.files > 0,
    `${brief.data?.files} files, by ${brief.data?.producedBy}`);
  check('the brief body carries the counts',
    typeof brief.data?.body === 'string' && brief.data.body.includes('###'));

  /* The two spending verbs are POST, deliberately: a model call behind a GET
     is a URL that costs money when a crawler or a link preview touches it. */
  const askViaGet = await api('/w/hadesmedia-ops/ask?question=hello', iris);
  check('the spending endpoints refuse GET',
    askViaGet.status === 405, `status ${askViaGet.status}`);
}


// ===========================================================================
section('the landing page, as onboarding');
// ===========================================================================
{
  const home = await get('/');
  check('the landing page renders for a signed-out visitor', home.status === 200,
    `status ${home.status}`);

  /* THE NUMBERS ARE READ, NOT TYPED. The page's whole claim is that its
     figures are arithmetic over the catalogue rather than assertions, and the
     least defensible place to break that is the page making the claim. This
     reads the same seed the page reads and insists they agree, so a reseed
     that changes the catalogue fails here rather than quietly leaving a stale
     number on the front page. */
  const seed = JSON.parse(
    readFileSync(join(here, '..', 'data', 'seed', 'tenancy.json'), 'utf8'),
  );
  const files = seed.libraries.reduce((n, l) => n + l.fileCount, 0);
  const tags = seed.libraries.reduce((n, l) => n + l.tagCount, 0);
  const main = seed.libraries.find((l) => l.slug === 'hadesmedia-main')?.fileCount ?? 0;
  const pretty = (v) => v.toLocaleString('en-US');

  check('it quotes the real file total', home.body.includes(pretty(files)),
    `expected ${pretty(files)}`);
  check('it quotes the real tag total', home.body.includes(pretty(tags)),
    `expected ${pretty(tags)}`);
  check('the tenancy example quotes the real library size',
    home.body.includes(pretty(main)), `expected ${pretty(main)}`);
  check('it claims zero mutations, which is what the seed records',
    seed.libraries.every((l) => l.mutations === 0));

  /* It must say the demo is not the reader's own data. Leading a hosted demo
     with "Athena reads your folder" is the one claim this page cannot back up,
     and the sentence below is what stops it being implied. */
  check('it says plainly that nothing of the visitor is being read',
    /not uploading anything/i.test(home.body)
      && /nothing here reads your machine/i.test(home.body));

  /* Every route into the demo carries where it was going, or sign-in becomes a
     dead end that drops a cold visitor on a workspace picker with no idea why. */
  const deep = [...home.body.matchAll(/\/login\?next=([^"'&\s]+)/g)]
    .map((m) => decodeURIComponent(m[1].replace(/&amp;/g, '&')));
  check('the demo links carry their destination', deep.length > 0,
    `${deep.length} deep links`);
  check('and every destination is a real area of the app',
    deep.every((d) => d.startsWith('/w/') || d.startsWith('/app')),
    [...new Set(deep)].slice(0, 4).join(' '));

  const target = [...new Set(deep)].find((d) => d.startsWith('/w/'));
  if (target) {
    const picker = await get(`/login?next=${encodeURIComponent(target)}`);
    check('sign-in keeps that destination', picker.body.includes(`value="${target}"`),
      target);
    // And the destination is somewhere a signed-in demo account can reach.
    const landed = await get(target.split('?')[0], iris);
    check('and a signed-in account actually lands there', landed.status === 200,
      `${target} → ${landed.status}`);
  }

  /* The onboarding sections themselves. Asserted by heading rather than by
     class name, because the headings are the contract with the reader. */
  for (const heading of [
    'Start here',
    'How it works',
    'What it will not do',
    'Three ways to look at it',
    'What the agent can do',
    'Run it on your own files',
  ]) {
    check(`it has a "${heading}" section`, home.body.includes(heading));
  }

  check('the agent table marks which verbs need no model',
    home.body.includes('related') && home.body.includes('repeats'),
    'two of the five are arithmetic and the page says so');
}

// ===========================================================================
section('asking from inside the graph');
// ===========================================================================
{
  const graph = await get('/w/hadesmedia-ops/graph', iris);
  check('the graph offers the ask control', graph.status === 200
    && /Ask a question and redraw the graph/.test(graph.body),
    'the agent, put where the answer lands');

  /* Applying a plan sets the filter and the mode and nothing else. Both halves
     have to survive the URL, which is what this asserts end to end -- the mode
     seeded from the query string, and the filter parsed by the same codec the
     facet rail uses. */
  const applied = await get('/w/hadesmedia-ops/graph?topic=finance&mode=tags', iris);
  check('a plan applied as a URL still renders', applied.status === 200);
  const api = await json('/api/w/hadesmedia-ops/graph?mode=tags&topic=finance', iris);
  check('and the drawing it asks for has something in it',
    api.status === 200 && (api.data?.nodes?.length ?? 0) > 0,
    `${api.data?.nodes?.length ?? 0} nodes`);
}


// ===========================================================================
section('selecting a file in the graph');
// ===========================================================================
{
  /* Clicking a dot opens the library's own panel over the drawing. It used to
     navigate to the library filtered by the file's NAME, which answered a
     question nobody asked: you clicked one thing and were shown a list, on
     another page, having lost the cloud you were reading. */
  const src = (...parts) => readFileSync(join(here, '..', ...parts), 'utf8');
  const client = src('app', 'w', '[ws]', 'graph', 'GraphClient.tsx');

  check('the graph opens the same panel the library opens',
    client.includes("from '@/components/library/FileDetail'"),
    'one panel, not a second copy of it');
  check('and fetches the file it was given', /openFile\(ws, id\)/.test(client));
  check('and no longer navigates away from the drawing',
    !/library\?q=\$\{encodeURIComponent\(payload\.labels/.test(client));
  /* A tag node still adds itself to the filter. Not an inconsistency: a tag is
     a way of narrowing what is drawn, not a thing to inspect. */
  check('while a tag node still narrows the filter',
    /qs\.set\(node\.kind/.test(client));

  /* THE PANEL NEEDS AN ID, and the file graph is the only payload that carries
     one. If `ids` were ever dropped -- it is the one field the drawing itself
     does not use -- every dot would stop opening, and nothing else here would
     notice. */
  const files = await json('/api/w/hadesmedia-ops/graph?mode=files', iris);
  const ids = files.data?.ids ?? [];
  check('the file graph ships an id per node', Array.isArray(ids) && ids.length > 0,
    `${ids.length} ids`);
  check('and one per label, so the panel opens the dot that was clicked',
    ids.length === (files.data?.labels?.length ?? -1),
    `${ids.length} ids / ${files.data?.labels?.length} labels`);

  /* And that id resolves, through the repository, for this member -- the same
     boundary the panel's own read goes through. */
  const one = await json(`/api/v1/w/hadesmedia-ops/files/${ids[0]}`, iris);
  check('and an id from the drawing resolves to a real file',
    one.status === 200 && typeof one.data?.file?.name === 'string',
    one.data?.file?.name ?? `status ${one.status}`);

  /* One mapper behind both panels. Two would be how the library and the graph
     start disagreeing about what a file is -- one resolving the doctype, the
     other showing a tag the workspace had already corrected away. */
  const actions = src('app', 'w', '[ws]', 'actions.ts');
  const libPage = src('app', 'w', '[ws]', 'library', 'page.tsx');
  check('both panels are filled by one mapper',
    actions.includes('toFileView') && libPage.includes('toFileView'),
    'lib/data/view.ts');
}


// ===========================================================================
section('the palette and the typeface');
// ===========================================================================
{
  const css = readFileSync(join(here, '..', 'app', 'globals.css'), 'utf8');
  const token = (name) => (css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`)) ?? [])[1];

  /* The requested colours, asserted to still BE the requested colours. Six of
     the seven are used verbatim; the seventh, the brand red, is verbatim as a
     mark and has two derived siblings for the jobs it cannot do. A later
     "tidy-up" that nudges one of these hexes is exactly what this catches. */
  const asked = {
    'dark-label': '#FAF9F5',
    'dark-label-3': '#9C9A92',
    'dark-bg-base': '#141413',
    'dark-bg-raised': '#1f1e1d',
    'light-bg-base': '#F2F2F2',
    'light-bg-sunk': '#f0f0ef',
    'light-bg-raised': '#FAF9F5',
    'light-label': '#1f1e1d',
    'light-label-4': '#9C9A92',
    'dark-accent': '#fe2231',
    'light-accent': '#fe2231',
  };
  for (const [name, want] of Object.entries(asked)) {
    check(`--${name} is the requested ${want}`,
      (token(name) ?? '').toLowerCase() === want.toLowerCase(),
      token(name) ?? 'missing');
  }

  /* The brand red cannot carry text in either appearance -- 4.35 on dark,
     3.63 on light -- so nothing may set `color` to it. The two derived roles
     exist precisely so the brand colour is never asked to. `border-color` and
     `accent-color` are graphical and answer to 3:1, which it clears. */
  const sheets = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.css')) sheets.push(p);
    }
  };
  walk(join(here, '..', 'app'));
  walk(join(here, '..', 'components'));

  const bare = /(?<![-\w])color:\s*var\(--accent\)/;
  const offenders = sheets.filter((f) => bare.test(readFileSync(f, 'utf8')));
  check('nothing sets text colour to the brand red', offenders.length === 0,
    offenders.length
      ? offenders.map((f) => f.split(/[\\/]/).pop()).join(', ')
      : 'links use --accent-text');

  /* ONE accent on the controls.

     Each workspace carries its own colour in data/seed/tenancy.json, and the
     chrome used to be tinted with it through --ws-accent. Measured against the
     palette that exists now, those four pastels are 1.46 to 2.11 with
     --on-accent on top -- on a selected facet chip, the view toggle and the
     focus ring, which are controls and not decoration. A control tinted from
     seed data also cannot be checked by check:contrast, which reads the token
     file; the failure would have been invisible to every gate in this repo.

     So no stylesheet may reach for it. The workspace colour survives as the
     DOT beside its name in the switcher and the picker, where it labels rather
     than replaces the words. */
  // `var(--ws-accent` rather than the bare name, so the comment in globals.css
  // that explains why the variable was retired is not read as a use of it.
  const tinted = sheets.filter((f) => /var\(\s*--ws-accent/.test(readFileSync(f, 'utf8')));
  check('no stylesheet tints a control with the workspace colour',
    tinted.length === 0,
    tinted.length
      ? tinted.map((f) => f.split(/[\\/]/).pop()).join(', ')
      : 'controls take --accent, --accent-text and --accent-fill');

  const shell = readFileSync(join(here, '..', 'app', 'w', '[ws]', 'layout.tsx'), 'utf8');
  check('and the shell no longer sets it, so it is not a dead variable',
    !/\['--ws-accent'/.test(shell));

  // The display face has to reach the cascade, not merely be imported.
  check('the display face is applied by one element rule',
    /h1,\s*h2\s*\{[^}]*--font-display/.test(css),
    'so no component has to remember which family to ask for');
  check('and falls back to a named serif rather than the generic one',
    /--font-display:[^;]*Georgia/.test(css),
    'generic serif resolves to Times on Windows and reads as a bug');

  const home = await get('/');
  check('both typefaces are self-hosted, so font-src can stay self',
    !/fonts\.googleapis|fonts\.gstatic/.test(home.body),
    'next/font downloads them at build time');
}


console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} FAILED`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
