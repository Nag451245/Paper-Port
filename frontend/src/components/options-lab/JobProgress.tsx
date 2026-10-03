import type { LabJob } from '@/services/api';

export default function JobProgress({ job }: { job: LabJob }) {
  const pct = job.progress.total ? Math.round((job.progress.done / job.progress.total) * 100) : null;
  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-3">
      <p className="text-xs text-indigo-800">{job.progress.message}</p>
      <div className="mt-2 h-1.5 rounded-full bg-indigo-100 overflow-hidden">
        <div className={`h-full bg-indigo-500 transition-all ${pct == null ? 'animate-pulse w-1/3' : ''}`} style={pct == null ? undefined : { width: `${pct}%` }} />
      </div>
      <p className="mt-1.5 text-[10px] text-indigo-500">
        The first run over a period fetches each contract from ICICI (about one a second); later runs use the saved prices.
      </p>
    </div>
  );
}
