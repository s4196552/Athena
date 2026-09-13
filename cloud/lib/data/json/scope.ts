import 'server-only';
import type { FileRecord, Scope, TagRecord, TagRef } from '../types';

/* Applies a grant's scope.
 *
 * This is the function that makes "shared database" safe. Two workspaces read
 * one library; what separates them is evaluated here, before any user filter
 * and before anything reaches a page. No component ever sees a file its
 * workspace was not granted, because no component ever receives one.
 *
 * The algebra matches the desktop app's (athena/web/queries.py): OR within a
 * field, AND across fields. A file must sit under one of the path prefixes AND
 * carry at least one of the included tags AND be one of the allowed media
 * types. Exclusions win over inclusions, which is the rule people expect and
 * the only one that makes a deny list trustworthy.
 *
 * An empty scope means the whole library.
 */

function tagKey(kind: string, name: string): string {
  return `${kind}:${name}`;
}

function refSet(refs: TagRef[] | undefined): Set<string> | null {
  if (!refs || refs.length === 0) return null;
  return new Set(refs.map((r) => tagKey(r.kind, r.name)));
}

export function isScopeEmpty(scope: Scope): boolean {
  return (
    !scope.pathPrefixes?.length &&
    !scope.includeTags?.length &&
    !scope.excludeTags?.length &&
    !scope.mediaTypes?.length
  );
}

export function applyScope(
  files: FileRecord[],
  scope: Scope,
  tagById: Map<number, TagRecord>,
): FileRecord[] {
  if (isScopeEmpty(scope)) return files;

  const prefixes = scope.pathPrefixes ?? [];
  const include = refSet(scope.includeTags);
  const exclude = refSet(scope.excludeTags);
  const media = scope.mediaTypes?.length ? new Set(scope.mediaTypes) : null;

  return files.filter((f) => {
    if (prefixes.length && !prefixes.some((p) => f.relPath.startsWith(p))) return false;
    if (media && !media.has(f.mediaType)) return false;

    if (include || exclude) {
      let hasIncluded = false;
      for (const id of f.tags) {
        const t = tagById.get(id);
        if (!t) continue;
        const key = tagKey(t.kind, t.name);
        if (exclude?.has(key)) return false;
        if (include?.has(key)) hasIncluded = true;
      }
      if (include && !hasIncluded) return false;
    }

    return true;
  });
}

/** A one-line human description of a scope, for the sharing screen. Being able
 *  to read a grant at a glance is most of what makes the model legible. */
export function describeScope(scope: Scope): string {
  if (isScopeEmpty(scope)) return 'the whole library';
  const parts: string[] = [];
  if (scope.pathPrefixes?.length) {
    parts.push(
      scope.pathPrefixes.length === 1
        ? `1 folder`
        : `${scope.pathPrefixes.length} folders`,
    );
  }
  if (scope.includeTags?.length) {
    parts.push(`${scope.includeTags.length} topics`);
  }
  if (scope.mediaTypes?.length) {
    parts.push(scope.mediaTypes.join('/'));
  }
  if (scope.excludeTags?.length) {
    parts.push(`excluding ${scope.excludeTags.length}`);
  }
  return parts.join(' + ');
}
