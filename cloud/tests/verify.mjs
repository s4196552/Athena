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
import { readFileSync } from 'node:fs';
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
  return 'athena-dev-secret-not-for-production'; // the dev fallback in cookie.ts
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
  check('login page renders', r.status === 200 && r.body.includes('Sign in'));
  check('offers demo accounts', r.body.includes('Priya Raman'));
  check('is honest that auth is mocked', r.body.includes('any password is accepted'));
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
section('file graph');
// ===========================================================================
{
  const r = await json('/api/w/hadesmedia-ops/graph?mode=files', iris);
  const g = r.data;
  check('responds', r.status === 200);
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

// ===========================================================================
section('tag graph (ported from athena/web/queries.py)');
// ===========================================================================
{
  const r = await json('/api/w/hadesmedia-ops/graph?mode=tags', iris);
  const g = r.data;
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

console.log(
  `\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} FAILED`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
