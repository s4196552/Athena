#!/usr/bin/env -S npx tsx
import { CliError, DEFAULT_BASE, login, makeClient, type Client } from './client.mts';
import { clearSession, configPath, loadSession, saveSession } from './config.mts';
import { filterQuery, flagSet, flagValue, parse, type Args } from './args.mts';
import * as r from './render.mts';
import type {
  AccountsResponse,
  AskResponse,
  BriefResponse,
  ExplainResponse,
  FacetsResponse,
  FileDetailResponse,
  FilesResponse,
  MeResponse,
} from '../lib/api/types.js';

/* athena-cloud -- the terminal client for Athena Cloud.
 *
 * It talks to /api/v1 over HTTP and holds a session cookie in ~/.athena. It
 * has no access to the catalogue and no copy of it: every number it prints was
 * counted by the server, which is the same promise the web UI makes and the
 * reason both can be believed.
 *
 * `--json` on any command prints the server's answer verbatim, because the
 * useful thing about a CLI over a web page is that its output can be piped
 * into something else. The human rendering is a convenience over that, never
 * the only way to get at an answer.
 */

const HELP = `athena-cloud — Athena Cloud from a terminal

  Sessions
    login [email]            sign in; lists the demo accounts if no email given
    logout                   forget the stored session
    whoami                   who the stored session belongs to
    workspaces               the workspaces it can reach, and what each sees

  The catalogue
    ls [filters]             list files
    tags [filters]           facet counts for a selection
    show <fileId>            one file, its tags and its nearest neighbours

  The agent
    brief [filters]          summarise a selection
    ask "<question>"         turn a question into a filter and a graph
    explain <fileId>         describe a file from its name, folder and labels

  Filters
    --doctype --topic --author --date --pattern --entity --custom --keyword
    --q <text>               match against file names
    --type <mediaType>       image | video | audio | document | other
    --limit <n>              page size, max 500      --cursor <n>  offset

  Anywhere
    --ws <slug>              which workspace (remembered after login)
    --base <url>             which deployment (default ${DEFAULT_BASE})
    --json                   print the server's answer verbatim
    --no-color               plain text
    -h, --help               this

  Commands that spend a model call: ask, explain, and brief unless --no-model.
`;

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2));

  if (!args.command || flagSet(args, 'h', 'help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const base = flagValue(args, 'base');

  switch (args.command) {
    case 'login': return cmdLogin(args, base);
    case 'logout': return cmdLogout();
    case 'whoami': return cmdWhoami(args, base);
    case 'workspaces': case 'ws': return cmdWorkspaces(args, base);
    case 'ls': case 'files': return cmdLs(args, base);
    case 'tags': case 'facets': return cmdTags(args, base);
    case 'show': case 'file': return cmdShow(args, base);
    case 'brief': case 'summarise': case 'summarize': return cmdBrief(args, base);
    case 'ask': return cmdAsk(args, base);
    case 'explain': return cmdExplain(args, base);
    default:
      process.stderr.write(`${r.red('Unknown command')} "${args.command}".\n\n${HELP}`);
      return 2;
  }
}

// ---------------------------------------------------------------------------
//  Which workspace
// ---------------------------------------------------------------------------

/* Resolved in one place, because "which workspace" is the question every
 * catalogue command has to answer and getting it wrong is quiet: a command
 * that guesses would print a real table about the wrong library. */
async function workspaceOf(args: Args, client: Client): Promise<string> {
  const asked = flagValue(args, 'ws') ?? process.env.ATHENA_CLOUD_WS;
  if (asked) return asked;

  const remembered = client.session?.workspace;
  if (remembered) return remembered;

  throw new CliError(
    'Which workspace?',
    'Pass --ws <slug>, or run `athena-cloud workspaces` to see them. '
      + 'It is remembered when you belong to exactly one.',
  );
}

function out(text: string) {
  process.stdout.write(`${text}\n`);
}

function json(data: unknown) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
//  Sessions
// ---------------------------------------------------------------------------

async function cmdLogin(args: Args, baseFlag?: string): Promise<number> {
  const base = baseFlag ?? (await loadSession())?.base ?? DEFAULT_BASE;
  const email = args.positional[0] ?? flagValue(args, 'email');

  if (!email) {
    /* ASKED FOR, never hardcoded. The first draft of this listed five
       addresses at `@hadesmedia.test` when the fixtures are `@hadesmedia
       .example`, so every one of them failed to sign in -- a list copied into
       a client is a list that drifts. The server publishes the same accounts
       /login already shows, and only while it runs on fixtures. */
    const anon = await makeClient(base);
    let accounts: AccountsResponse;
    try {
      accounts = await anon.call<AccountsResponse>({ path: '/accounts', anonymous: true });
    } catch (err) {
      if (err instanceof CliError && err.status === 404) {
        throw new CliError(
          'This deployment does not publish a list of accounts.',
          'Pass your email: athena-cloud login you@example.com --password ...',
        );
      }
      throw err;
    }

    out(`Sign in to ${r.bold(base)} with one of these accounts:\n`);
    out(r.table(
      [{ header: 'EMAIL' }, { header: 'NAME' }, { header: 'WORKSPACES' }],
      accounts.accounts.map((a) => [a.email, a.name, a.workspaces.join(', ') || '—']),
    ));
    const first = accounts.accounts[0]?.email;
    if (first) out(`\n${r.dim(`athena-cloud login ${first}`)}`);
    return 1;
  }

  const password = flagValue(args, 'password') ?? process.env.ATHENA_CLOUD_PASSWORD;
  const session = await login(base, email, password);
  await saveSession(session);

  out(`${r.green('Signed in')} as ${r.bold(session.name || session.email)} at ${base}`);
  out(r.dim(`Session stored in ${configPath()} (not the password — there isn't one on this deployment).`));
  if (session.workspace) out(`Workspace: ${r.bold(session.workspace)}`);
  else out(r.dim('You belong to more than one workspace — pass --ws, or see `athena-cloud workspaces`.'));
  return 0;
}

async function cmdLogout(): Promise<number> {
  const session = await loadSession();
  if (session) {
    // Best effort: clearing the local file is what actually signs this machine
    // out, and a server that cannot be reached must not prevent that.
    try {
      const client = await makeClient(session.base);
      await client.call({ method: 'POST', path: '/logout' });
    } catch { /* the local file is the part that matters */ }
  }
  await clearSession();
  out(`${r.green('Signed out.')} ${r.dim(configPath())} removed.`);
  return 0;
}

async function cmdWhoami(args: Args, base?: string): Promise<number> {
  const client = await makeClient(base);
  const me = await client.call<MeResponse>({ path: '/me' });

  if (flagSet(args, 'json')) { json(me); return 0; }

  out(`${r.bold(me.user.name)} <${me.user.email}>`);
  out(r.dim(`at ${client.base}, session valid until ${r.date(me.expiresAt)}`));
  return 0;
}

async function cmdWorkspaces(args: Args, base?: string): Promise<number> {
  const client = await makeClient(base);
  const me = await client.call<MeResponse>({ path: '/me' });

  if (flagSet(args, 'json')) { json(me.workspaces); return 0; }

  const current = client.session?.workspace;
  out(r.table(
    [{ header: '' }, { header: 'SLUG' }, { header: 'NAME' }, { header: 'ROLE' },
      { header: 'FILES', right: true }, { header: 'TAGS', right: true }],
    me.workspaces.map((w) => [
      w.slug === current ? '*' : '',
      w.slug,
      w.name,
      w.role,
      r.count(w.files),
      r.count(w.tags),
    ]),
  ));
  /* The counts differ per workspace ON PURPOSE and that is the whole tenancy
     model, so the CLI says so rather than letting it read as an oddity. */
  out(`\n${r.dim('Counts are what each workspace can see — same catalogue, different grants.')}`);
  return 0;
}

// ---------------------------------------------------------------------------
//  The catalogue
// ---------------------------------------------------------------------------

function describeFilter(filter: Record<string, string>): string {
  const parts = Object.entries(filter).map(([k, v]) => `${k}=${v}`);
  return parts.length ? parts.join(' ') : 'no filter';
}

async function cmdLs(args: Args, base?: string): Promise<number> {
  const client = await makeClient(base);
  const ws = await workspaceOf(args, client);

  const query = filterQuery(args);
  const limit = flagValue(args, 'limit');
  if (limit) query.set('limit', limit);
  const cursor = flagValue(args, 'cursor');
  if (cursor) query.set('cursor', cursor);

  const page = await client.call<FilesResponse>({ path: `/w/${ws}/files`, query });

  if (flagSet(args, 'json')) { json(page); return 0; }

  if (page.files.length === 0) {
    out(`Nothing matches ${r.bold(describeFilter(page.filter))} in ${ws}.`);
    out(r.dim('`athena-cloud tags` lists the values this workspace actually has.'));
    return 0;
  }

  out(r.table(
    [{ header: 'ID', max: 12 }, { header: 'NAME', max: 44 }, { header: 'KIND', max: 10 },
      { header: 'SIZE', right: true }, { header: 'MODIFIED' }, { header: 'FOLDER', max: 34 }],
    page.files.map((f) => [
      f.id,
      f.name,
      f.tags.find((t) => t.kind === 'doctype')?.display ?? f.mediaType,
      r.bytes(f.sizeBytes),
      r.date(f.mtime),
      f.parentRel.replace(/\/$/, '') || '.',
    ]),
  ));

  const shown = page.offset + page.files.length;
  out(`\n${r.bold(`${r.count(page.offset + 1)}–${r.count(shown)}`)} of `
    + `${r.count(page.total)} — ${describeFilter(page.filter)}`);
  if (page.nextCursor) {
    out(r.dim(`Next page: --cursor ${page.nextCursor}`));
  }
  return 0;
}

async function cmdTags(args: Args, base?: string): Promise<number> {
  const client = await makeClient(base);
  const ws = await workspaceOf(args, client);

  const facets = await client.call<FacetsResponse>({
    path: `/w/${ws}/facets`,
    query: filterQuery(args),
  });

  if (flagSet(args, 'json')) { json(facets); return 0; }

  for (const axis of facets.axes) {
    if (!axis.values.length) continue;
    out(r.bold(axis.label.toUpperCase()));
    out(r.table(
      [{ header: '', max: 28 }, { header: '', right: true }],
      axis.values.slice(0, 12).map((v) => [`  ${v.display}`, r.count(v.count)]),
    ).split('\n').slice(1).join('\n'));
    if (axis.values.length > 12) {
      out(r.dim(`  … and ${axis.values.length - 12} more`));
    }
    out('');
  }
  out(r.dim('Counts are relative to the current filter — pass one to narrow them.'));
  return 0;
}

async function cmdShow(args: Args, base?: string): Promise<number> {
  const id = args.positional[0];
  if (!id) throw new CliError('Which file?', 'Pass a file id from `athena-cloud ls`.');

  const client = await makeClient(base);
  const ws = await workspaceOf(args, client);
  const detail = await client.call<FileDetailResponse>({ path: `/w/${ws}/files/${id}` });

  if (flagSet(args, 'json')) { json(detail); return 0; }

  const f = detail.file;
  out(r.bold(f.name));
  out(r.dim(f.relPath));
  out('');
  out(`${r.dim('Size    ')} ${r.bytes(f.sizeBytes)}`);
  out(`${r.dim('Modified')} ${r.date(f.mtime)}`);
  out(`${r.dim('Type    ')} ${f.mediaType}${f.ext ? ` (.${f.ext})` : ''}`);

  out(`\n${r.bold('TAGS')}`);
  if (!f.tags.length) out(r.dim('  none — nothing in it matched the classifier'));
  for (const t of f.tags) {
    out(`  ${r.dim(t.kind.padEnd(9))} ${t.display}${t.user ? r.blue('  (this workspace)') : ''}`);
  }

  if (detail.removed.length) {
    out(`\n${r.bold('NOT COUNTED HERE')}`);
    for (const t of detail.removed) out(`  ${r.dim(t.kind.padEnd(9))} ${t.display}`);
    out(r.dim('  The catalogue still holds these; this workspace chose not to count them.'));
  }

  if (detail.related.length) {
    out(`\n${r.bold('RELATED')}`);
    out(r.table(
      [{ header: '' }, { header: '', max: 40 }, { header: '' }],
      detail.related.map((rel) => [
        `  ${Math.round(rel.score * 100)}%`,
        rel.name,
        `${rel.sameFolder ? 'same folder · ' : ''}shares ${rel.shared.map((t) => t.display).join(', ')}`,
      ]),
    ).split('\n').slice(1).join('\n'));
    out(r.dim('  Ranked by how rare the shared tags are, not how many. No model involved.'));
  }
  return 0;
}

// ---------------------------------------------------------------------------
//  The agent
// ---------------------------------------------------------------------------

async function cmdBrief(args: Args, base?: string): Promise<number> {
  const client = await makeClient(base);
  const ws = await workspaceOf(args, client);

  const query = filterQuery(args);
  if (flagSet(args, 'no-model')) query.set('model', 'off');

  const brief = await client.call<BriefResponse>({ path: `/w/${ws}/brief`, query });

  if (flagSet(args, 'json')) { json(brief); return 0; }

  out(r.bold(brief.title));
  out('');
  if (brief.intro) { out(r.wrap(brief.intro)); out(''); }
  if (brief.themes?.length) out(`${r.dim('Themes ')} ${brief.themes.join(', ')}`);
  if (brief.about?.length) out(`${r.dim('About  ')} ${brief.about.join(', ')}`);
  if (brief.themes?.length || brief.about?.length) out('');

  out(r.markdown(brief.body));

  if (brief.note) out(`\n${r.yellow(r.wrap(brief.note))}`);
  out(`\n${r.dim(brief.producedBy === 'counted'
    ? 'Counted from the catalogue. No model was used.'
    : `Counts from the catalogue; the opening paragraph written by ${brief.producedBy}.`)}`);
  return 0;
}

async function cmdAsk(args: Args, base?: string): Promise<number> {
  const question = args.positional.join(' ').trim();
  if (!question) {
    throw new CliError(
      'Ask what?',
      'For example: athena-cloud ask "how do finance and legal overlap"',
    );
  }

  const client = await makeClient(base);
  const ws = await workspaceOf(args, client);
  const plan = await client.call<AskResponse>({
    method: 'POST',
    path: `/w/${ws}/ask`,
    body: { question },
  });

  if (flagSet(args, 'json')) { json(plan); return 0; }

  out(r.bold(plan.title));
  out('');

  const chips = Object.entries(plan.tags).flatMap(([axis, names]) =>
    names.map((n) => `${r.dim(axis)}=${n}`));
  if (plan.q) chips.push(`${r.dim('name contains')}=${plan.q}`);
  out(chips.length ? `  ${chips.join('  ')}` : r.dim('  everything in this workspace'));

  out(`\n  ${r.bold(r.count(plan.matches))} ${plan.matches === 1 ? 'file matches' : 'files match'}`
    + `${r.dim(', counted from the catalogue')}`);
  out(`  ${r.dim(`drawn as the ${plan.mode} graph`)}`);

  if (plan.why) out(`\n${r.wrap(`“${plan.why}”`, '  ')}\n  ${r.dim(`— ${plan.model}`)}`);

  /* Dropped names are printed loudly. A question that was half understood must
     not look like one that was understood, which is the same rule the web
     card follows. */
  if (plan.dropped.length) {
    out(`\n${r.yellow('  Ignored:')} ${plan.dropped.map((d) => `“${d.name}”`).join(', ')}`);
    out(r.dim('  No such tag in this library, so it was left out rather than guessed at.'));
  }

  out(`\n  ${r.blue(`${client.base}${plan.graphPath}`)}`);
  out(`  ${r.dim(`${client.base}${plan.libraryPath}`)}`);
  return 0;
}

async function cmdExplain(args: Args, base?: string): Promise<number> {
  const id = args.positional[0];
  if (!id) throw new CliError('Explain which file?', 'Pass a file id from `athena-cloud ls`.');

  const client = await makeClient(base);
  const ws = await workspaceOf(args, client);
  const result = await client.call<ExplainResponse>({
    method: 'POST',
    path: `/w/${ws}/files/${id}/explain`,
  });

  if (flagSet(args, 'json')) { json(result); return 0; }

  out(r.wrap(result.summary));

  if (result.reads.length) {
    out(`\n${r.bold('READ FROM')}`);
    for (const line of result.reads) out(`  ${r.green('·')} ${line}`);
  }

  /* Printed every time, at the same weight as the summary. The catalogue holds
     no file contents, so a description produced from a name is only safe to
     read beside its limits. */
  out(`\n${r.bold('WOULD NEED THE FILE ITSELF')}`);
  for (const line of result.unknowns) out(`  ${r.yellow('·')} ${line}`);

  out(`\n${r.dim(`${result.confidence} confidence — ${result.model}. `
    + 'Nothing here was read from the file; the catalogue holds no contents.')}`);
  return 0;
}

// ---------------------------------------------------------------------------

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof CliError) {
    process.stderr.write(`${r.red('Error')} ${err.message}\n`);
    if (err.hint) process.stderr.write(`${r.dim(err.hint)}\n`);
    process.exitCode = err.status === 429 ? 4 : 1;
  } else {
    process.stderr.write(`${r.red('Error')} ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
