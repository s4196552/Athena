import s from '@/components/shell/skeleton.module.css';

export default function LoadingWorkspace() {
  return (
    <div className={s.wrap} aria-busy="true" aria-label="Loading the workspace">
      <div className={`${s.bar} ${s.title}`} />
      <div className={`${s.bar} ${s.sub}`} />
      <div className={s.stats}>
        {[0, 1, 2, 3].map((i) => <div key={i} className={`${s.bar} ${s.stat}`} />)}
      </div>
      <div className={s.section}><div className={`${s.bar} ${s.panel}`} /></div>
      <div className={s.section}><div className={`${s.bar} ${s.panel}`} /></div>
    </div>
  );
}
