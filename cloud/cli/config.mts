import { homedir } from 'node:os';
import { join } from 'node:path';
import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';

/* Where the CLI remembers who you are.
 *
 * A file rather than an environment variable, because a session has to survive
 * closing the terminal, and a file rather than the system keychain because
 * there are three keychains and no portable way to reach them from Node
 * without a native dependency -- which this tool does not have and should not
 * acquire to store a demo cookie.
 *
 * The file holds a SESSION COOKIE, not a password: a signed, expiring claim
 * that names a fixture identity. It is still written 0600 and never printed,
 * including by `--json`, because "it is only a demo credential" is exactly the
 * reasoning that puts a real one in a world-readable file six months later.
 */

export interface StoredSession {
  /** Which deployment this cookie is for. A cookie minted by localhost is not
   *  valid against production and vice versa, so the base is stored WITH it
   *  rather than beside it -- switching --base must not silently send one
   *  server a cookie signed by another. */
  base: string;
  cookie: string;
  email: string;
  name: string;
  /** Epoch ms. Checked before each call so an expired session reports itself
   *  instead of turning into an unexplained 401 halfway through a script. */
  expiresAt: number;
  /** Remembered so `--ws` is only needed when changing workspace. */
  workspace?: string;
}

const DIR = join(homedir(), '.athena');
const FILE = join(DIR, 'cloud.json');

export function configPath(): string {
  return FILE;
}

export async function loadSession(): Promise<StoredSession | null> {
  try {
    const raw = await readFile(FILE, 'utf8');
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed?.cookie || !parsed?.base) return null;
    return parsed;
  } catch {
    // Absent or unreadable are the same situation to a caller: not signed in.
    return null;
  }
}

export async function saveSession(session: StoredSession): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  // Set explicitly as well as at create time: writeFile's mode applies only
  // when the file did not already exist, so a second login to a file created
  // before this line existed would keep the old permissions.
  try {
    await chmod(FILE, 0o600);
  } catch {
    // Windows has no POSIX mode. Not worth failing a login over.
  }
}

export async function clearSession(): Promise<void> {
  try {
    await unlink(FILE);
  } catch {
    // Already gone is the desired end state.
  }
}
