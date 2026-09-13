import { NextResponse } from 'next/server';
import { getRepository } from '@/lib/data';
import { describeScope } from '@/lib/data/json/scope';
import type { UserId } from '@/lib/data/types';

/* The deploy smoke test.
 *
 * Plain GET answers "did the Next.js build actually deploy?" -- the question
 * that matters while the repo-root pyproject.toml could still confuse Vercel's
 * framework detection.
 *
 * `?deep=1` additionally reads the catalogue, which proves
 * outputFileTracingIncludes packaged data/seed into the lambda. That failure
 * mode is the nasty one: it works locally and 500s on Vercel.
 */
export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get('deep') === '1';

  /* `authSecret` reports PRESENCE ONLY, never the value. Without it, a
     deployment missing AUTH_SECRET builds cleanly, serves every public page
     correctly, and then fails only at sign-in with an opaque 500 digest --
     which is genuinely hard to diagnose from the outside. One boolean here
     turns that guessing game into a fact. */
  const base = {
    ok: true,
    app: 'athena-cloud',
    driver: process.env.ATHENA_DATA_DRIVER ?? 'json',
    runtime: process.version,
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'local',
    authSecret: process.env.AUTH_SECRET ? 'set' : 'MISSING — sign-in will fail',
  };

  if (!deep) return NextResponse.json(base);

  try {
    const repo = getRepository();
    const users = await repo.listUsers();
    const workspaces = await repo.listWorkspacesForUser('u_priya' as UserId);

    // Priya is in both Marketing and Finance. Reporting what each of her
    // workspaces sees of the SAME library is the tenancy model, asserted.
    const lenses = [];
    for (const ws of workspaces) {
      const ctx = await repo.buildContext('u_priya' as UserId, ws.slug);
      if (!ctx) continue;
      const summary = await repo.summary(ctx);
      lenses.push({
        workspace: ws.slug,
        role: ctx.role,
        files: summary.files,
        tags: summary.tags,
        libraries: ctx.grants.map((g) => ({
          libraryId: g.libraryId,
          access: g.access,
          scope: describeScope(g.scope),
        })),
      });
    }

    return NextResponse.json({
      ...base,
      users: users.length,
      catalogue: (await repo.listLibrariesOwnedBy('o_hades' as never)).map((l) => ({
        slug: l.slug, files: l.fileCount, tags: l.tagCount, mutations: l.mutations,
      })),
      lenses,
    });
  } catch (err) {
    return NextResponse.json(
      { ...base, ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
