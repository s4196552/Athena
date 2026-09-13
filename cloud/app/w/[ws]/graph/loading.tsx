import s from '@/components/shell/skeleton.module.css';

/* The graph page itself already streams behind a Suspense boundary, but that
 * only covers the client component mounting -- the server segment in front of
 * it (session, context, colour groups) had no feedback at all. */

export default function LoadingGraph() {
  return (
    <div aria-busy="true" aria-label="Building the graph">
      <div className={`${s.bar} ${s.canvas}`} />
    </div>
  );
}
