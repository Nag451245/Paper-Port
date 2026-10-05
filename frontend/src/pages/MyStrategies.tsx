import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, RefreshCw } from 'lucide-react';
import { tradingApi, type StrategyCardData } from '@/services/api';
import { usePortfolioStore } from '@/stores/portfolio';
import StrategyCard from '@/components/strategies/StrategyCard';

/** Open option and futures strategies: payoff, Greeks, a plain reading, and changes to them. */
export default function MyStrategies() {
  const { activePortfolio, fetchPortfolios } = usePortfolioStore();
  const [cards, setCards] = useState<StrategyCardData[] | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'user' | 'algo'>('user');
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const { data } = await tradingApi.strategyBook();
      setCards(data);
      setError('');
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not load your strategies.');
    }
    busy.current = false;
    setLoading(false);
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const timer = setInterval(load, 20_000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [load]);

  useEffect(() => { if (!activePortfolio) fetchPortfolios(); }, [activePortfolio, fetchPortfolios]);

  const mine = (cards ?? []).filter((c) => c.owner === 'user');
  const algo = (cards ?? []).filter((c) => c.owner === 'algo');
  const shown = tab === 'user' ? mine : algo;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">My Strategies</h1>
          <p className="text-sm text-slate-500">Option and futures strategies that are open now. Prices refresh every 20 seconds; every profit and loss is after charges.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl bg-slate-100 p-1 text-sm">
            {([['user', `Yours (${mine.length})`], ['algo', `Algo (${algo.length})`]] as const).map(([id, name]) => (
              <button key={id} onClick={() => setTab(id)}
                className={`px-3 py-1.5 rounded-lg ${tab === id ? 'bg-white shadow-sm font-semibold text-slate-800' : 'text-slate-500'}`}>{name}</button>
            ))}
          </div>
          <button onClick={load} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {error && <p className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{error}</p>}

      {cards == null && !error ? (
        <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-slate-400" /></div>
      ) : shown.length === 0 ? (
        <div className="bg-white rounded-xl border border-slate-200 p-10 text-center text-sm text-slate-500">
          {tab === 'user'
            ? <>You have no option or futures strategy open. Build one in the <Link to="/strategy-builder" className="text-indigo-600 font-semibold">Strategy Builder</Link>.</>
            : 'The bots have no option or futures strategy open.'}
        </div>
      ) : (
        shown.map((c) => <StrategyCard key={c.strategyTag} card={c} portfolioId={activePortfolio?.id ?? null} onChanged={load} />)
      )}
    </div>
  );
}
