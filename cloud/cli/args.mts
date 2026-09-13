import { TAG_AXES } from '../lib/taxonomy.js';

/* Argument parsing, written out rather than installed.
 *
 * The repo already refuses a dependency for jobs this size -- tests/verify.mjs
 * is a test runner in forty lines, lib/icons is sixty inlined paths instead of
 * a 3.7 MB font -- and a flag parser for eleven commands is squarely in that
 * category. It also means the CLI can be run straight from a clone with
 * nothing installed but what the app already needs.
 */

export interface Args {
  command: string;
  /** Everything that was not a flag, in order. */
  positional: string[];
  flags: Map<string, string | true>;
}

export function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      // Everything after -- is positional, so a file name that starts with a
      // dash can still be passed.
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags.set(arg.slice(2, eq), arg.slice(eq + 1));
      } else {
        const name = arg.slice(2);
        const next = argv[i + 1];
        // A flag takes the next token as its value unless that token is
        // itself a flag -- so `--json --ws ops` reads correctly.
        if (next !== undefined && !next.startsWith('-')) {
          flags.set(name, next);
          i++;
        } else {
          flags.set(name, true);
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const letter of arg.slice(1)) flags.set(letter, true);
    } else {
      positional.push(arg);
    }
  }

  return { command: positional.shift() ?? '', positional, flags };
}

export function flagValue(args: Args, name: string): string | undefined {
  const v = args.flags.get(name);
  return typeof v === 'string' ? v : undefined;
}

export function flagSet(args: Args, ...names: string[]): boolean {
  return names.some((n) => args.flags.has(n));
}

/* The filter flags, derived from TAG_AXES rather than listed.
 *
 * The axes are the desktop app's, ported once into lib/taxonomy.ts and checked
 * against the Python by `npm run check:taxonomy`. Deriving the CLI's flags
 * from that same list means a new axis reaches the terminal for free, and --
 * more to the point -- an axis that is REMOVED cannot leave a flag behind that
 * silently filters on nothing.
 */
export const FILTER_FLAGS = TAG_AXES.map((a) => a.kind);

export function filterQuery(args: Args): URLSearchParams {
  const sp = new URLSearchParams();

  for (const kind of FILTER_FLAGS) {
    const value = flagValue(args, kind);
    if (value) sp.set(kind, value);
  }

  const q = flagValue(args, 'q') ?? flagValue(args, 'search');
  if (q) sp.set('q', q);

  const type = flagValue(args, 'type');
  if (type) sp.set('type', type);

  const album = flagValue(args, 'album');
  if (album) sp.set('album', album);

  const lib = flagValue(args, 'lib');
  if (lib) sp.set('lib', lib);

  return sp;
}
