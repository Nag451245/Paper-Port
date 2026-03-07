const ORDER_STYLES: Record<string, string> = {
  FILLED: 'bg-emerald-50 text-emerald-600',
  PENDING: 'bg-amber-50 text-amber-600',
  SUBMITTED: 'bg-blue-50 text-blue-600',
  PARTIALLY_FILLED: 'bg-blue-50 text-blue-600',
  CANCELLED: 'bg-slate-100 text-slate-500',
  REJECTED: 'bg-red-50 text-red-600',
  EXPIRED: 'bg-slate-100 text-slate-400',
};

const SIDE_STYLES: Record<string, string> = {
  BUY: 'bg-emerald-50 text-emerald-600',
  SELL: 'bg-red-50 text-red-600',
  LONG: 'bg-emerald-50 text-emerald-600',
  SHORT: 'bg-red-50 text-red-600',
};

export function OrderStatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${ORDER_STYLES[status] ?? 'bg-slate-100 text-slate-500'}`}>
      {status}
    </span>
  );
}

export function SideBadge({ side }: { side: string }) {
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${SIDE_STYLES[side] ?? 'bg-slate-100 text-slate-500'}`}>
      {side}
    </span>
  );
}

export function ExchangeBadge({ exchange }: { exchange: string }) {
  const colors: Record<string, string> = {
    MCX: 'text-amber-700 bg-amber-50 border-amber-200',
    CDS: 'text-teal-700 bg-teal-50 border-teal-200',
    BSE: 'text-violet-700 bg-violet-50 border-violet-200',
    NSE: 'text-blue-700 bg-blue-50 border-blue-200',
    NFO: 'text-indigo-700 bg-indigo-50 border-indigo-200',
  };
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${colors[exchange] ?? colors.NSE}`}>
      {exchange === 'CDS' ? 'FOREX' : exchange}
    </span>
  );
}

export function StrategyBadge({ tag }: { tag: string | null | undefined }) {
  if (!tag) return <span className="text-slate-300">—</span>;
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-violet-50 text-violet-600 border border-violet-100">
      {tag.replace('STRAT:', '').replace('BOT:', '')}
    </span>
  );
}

export function RiskLevelBadge({ level }: { level: 'low' | 'medium' | 'high' | string }) {
  const styles: Record<string, string> = {
    low: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    medium: 'bg-amber-50 text-amber-700 border-amber-200',
    high: 'bg-red-50 text-red-700 border-red-200',
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${styles[level] ?? styles.medium}`}>
      {level.toUpperCase()}
    </span>
  );
}
