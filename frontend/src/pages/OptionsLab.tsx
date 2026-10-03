import { useState } from 'react';
import { FlaskConical, History } from 'lucide-react';
import BacktestPanel from '@/components/options-lab/BacktestPanel';
import ReplayPanel from '@/components/options-lab/ReplayPanel';

/** Options strategies on past prices: backtest a set of rules, or replay a day and trade it. */
export default function OptionsLab() {
  const [tab, setTab] = useState<'backtest' | 'replay'>('backtest');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Options Lab</h1>
          <p className="text-sm text-slate-500">NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY and SENSEX options on real past prices from ICICI. Every profit and loss is after charges.</p>
        </div>
        <div className="flex rounded-xl bg-slate-100 p-1 text-sm">
          {([['backtest', 'Backtest', FlaskConical], ['replay', 'Replay a day', History]] as const).map(([id, name, Icon]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`px-3 py-1.5 rounded-lg flex items-center gap-1.5 ${tab === id ? 'bg-white shadow-sm font-semibold text-slate-800' : 'text-slate-500'}`}>
              <Icon className="w-4 h-4" /> {name}
            </button>
          ))}
        </div>
      </div>
      {tab === 'backtest' ? <BacktestPanel /> : <ReplayPanel />}
    </div>
  );
}
