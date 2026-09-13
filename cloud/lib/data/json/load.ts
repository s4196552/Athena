import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  TenancySeed, FileRecord, TagRecord, Library, LibraryGraph, LibraryId,
} from '../types';

/* Reads the committed catalogue.
 *
 * Deliberately NOT under public/ and deliberately `server-only`: files.json for
 * the main library is 2.3 MB, and the one failure mode that would ruin this
 * design is that blob ending up in an RSC payload because a client component
 * imported the repository. The import guard makes that a build error rather
 * than a 2 MB page.
 *
 * Cached at module scope. On Vercel a warm lambda parses each file once and
 * every subsequent request is a map lookup.
 */

const SEED_DIR = join(process.cwd(), 'data', 'seed');

function read<T>(...parts: string[]): T {
  return JSON.parse(readFileSync(join(SEED_DIR, ...parts), 'utf8')) as T;
}

let tenancyCache: TenancySeed | null = null;

export function tenancy(): TenancySeed {
  if (!tenancyCache) tenancyCache = read<TenancySeed>('tenancy.json');
  return tenancyCache;
}

interface LibraryBundle {
  meta: Library;
  files: FileRecord[];
  tags: TagRecord[];
  byId: Map<string, FileRecord>;
  tagById: Map<number, TagRecord>;
}

const libraryCache = new Map<LibraryId, LibraryBundle>();
const graphCache = new Map<LibraryId, LibraryGraph>();

function slugFor(id: LibraryId): string {
  const lib = tenancy().libraries.find((l) => l.id === id);
  if (!lib) throw new Error(`unknown library ${id}`);
  return lib.slug;
}

export function library(id: LibraryId): LibraryBundle {
  let bundle = libraryCache.get(id);
  if (!bundle) {
    const slug = slugFor(id);
    const files = read<FileRecord[]>('libraries', slug, 'files.json');
    const tags = read<TagRecord[]>('libraries', slug, 'tags.json');
    bundle = {
      meta: read<Library>('libraries', slug, 'meta.json'),
      files,
      tags,
      byId: new Map(files.map((f) => [f.id, f])),
      tagById: new Map(tags.map((t) => [t.id, t])),
    };
    libraryCache.set(id, bundle);
  }
  return bundle;
}

export function libraryGraph(id: LibraryId): LibraryGraph {
  let g = graphCache.get(id);
  if (!g) {
    g = read<LibraryGraph>('libraries', slugFor(id), 'graph.json');
    graphCache.set(id, g);
  }
  return g;
}
