/* The brief's shape, in a module with no `server-only` on it.
 *
 * It lives apart from lib/brief/produce.ts so that BriefPanel and the Listen
 * button -- both client components -- can name the type without importing a
 * module that refuses to load in a browser. `import type` is erased, so this
 * would probably work either way; "probably" is not the right confidence level
 * for the guard that keeps an API key out of the bundle.
 */

export interface BriefResult {
  title: string;
  /** Markdown. Always present. */
  body: string;
  /** Model prose, when there was a model. */
  intro?: string;
  themes?: string[];
  about?: string[];
  producedBy: string;
  /** Why there is no prose, when there is none. Shown quietly, not as an error. */
  note?: string;
  files: number;
}
