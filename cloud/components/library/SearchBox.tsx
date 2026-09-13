import { Icon } from '@/lib/icons';
import s from './search.module.css';

/* Name search for the library.
 *
 * `q` has been honoured by the query layer, the brief and the graph since the
 * filter codec was written -- there was simply no control that set it, so the
 * only ways to get one were to type a URL or to click a node in the graph.
 *
 * This is a plain GET form rather than a client component. The browser
 * serialises the fields itself, which means it works with JavaScript off (the
 * account picker is built the same way and for the same reason), costs nothing
 * in the client bundle, and keeps the filter where the rest of this app keeps
 * it: in the URL.
 *
 * The rest of the filter rides along as hidden inputs, because a GET form
 * submits ONLY its own fields -- without these, searching would silently clear
 * every facet the person had chosen. `cursor` is excluded on purpose: a new
 * search starts at the first page, not wherever the last one was being read.
 */

interface Props {
  ws: string;
  /** The current filter, already canonical, minus `q` and `cursor`. */
  preserve: [string, string][];
  q?: string;
}

export function SearchBox({ ws, preserve, q }: Props) {
  return (
    <form className={s.form} action={`/w/${ws}/library`} method="get" role="search">
      {preserve.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}

      <div className={s.field}>
        <Icon name="search" size={14} className={s.icon} />
        <input
          className={s.input}
          type="search"
          name="q"
          defaultValue={q ?? ''}
          placeholder="Search file names…"
          aria-label="Search file names"
        />
      </div>
      <button className={s.go} type="submit">Search</button>
    </form>
  );
}
