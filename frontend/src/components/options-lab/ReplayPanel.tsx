import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, ColorType, CandlestickSeries, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { Loader2, Play, Pause, SkipForward, SkipBack, Timer, X } from 'lucide-react';
import { marketApi, optionsLabApi, type LabBar, type ReplayDay } from '@/services/api';
import { LAB_UNDERLYINGS, inr, tone, todayIst, shiftDays, orderCharges, useLabJob } from './lab-utils';
import JobProgress from './JobProgress';

const CANDLE = 300;                                    // 5-minute candles, seconds
const SPEEDS = [1, 5, 15, 30];                         // market minutes per real second
const field = 'mt-0.5 w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs bg-white focus:outline-none focus:border-indigo-400';
const label = 'text-[10px] font-semibold uppercase tracking-wide text-slate-500';

/** The price known at `clock`: a finished candle's close, or the open of the candle in progress. */
function priceAt(bars: LabBar[], clock: number): number | null {
  let p: number | null = null;
  for (const b of bars) {
    if (b[0] + CANDLE <= clock) p = b[4];
    else if (b[0] <= clock) { p = b[1]; break; }
    else break;
  }
  return p;
}

/** Finished candles at `clock`, combined into `minutes`-long candles from 09:15 (the last one may still be forming). */
function candlesAt(bars: LabBar[], clock: number, minutes: number): LabBar[] {
  const done = bars.filter((b) => b[0] + CANDLE <= clock);
  if (minutes === 5 || !done.length) return done;
  const start = bars[0][0], size = minutes * 60;
  const out: LabBar[] = [];
  for (const b of done) {
    const key = start + Math.floor((b[0] - start) / size) * size;
    const last = out[out.length - 1];
    if (last && last[0] === key) { last[2] = Math.max(last[2], b[2]); last[3] = Math.min(last[3], b[3]); last[4] = b[4]; last[5] += b[5]; }
    else out.push([key, b[1], b[2], b[3], b[4], b[5]]);
  }
  return out;
}

const hms = (t: number) => new Date((t + 19_800) * 1000).toISOString().slice(11, 19);
const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const lastWeekday = () => { let d = shiftDays(todayIst(), -1); while ([0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())) d = shiftDays(d, -1); return d; };

interface Position {
  id: number; strike: number; type: 'CE' | 'PE'; side: 'BUY' | 'SELL'; qty: number;
  entry: number; entryAt: number; entryCharges: number;
  exit?: number; exitAt?: number; exitCharges?: number;
}

export default function ReplayPanel() {
  const [underlying, setUnderlying] = useState('NIFTY');
  const [day, setDay] = useState(lastWeekday());
  const [each, setEach] = useState(8);
  const [data, setData] = useState<ReplayDay | null>(null);
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [tf, setTf] = useState(5);
  const [lots, setLots] = useState(1);
  const [lotSizes, setLotSizes] = useState<Record<string, number>>({});
  const [positions, setPositions] = useState<Position[]>([]);
  const { job, error, start, running } = useLabJob();
  const nextId = useRef(1);

  useEffect(() => { marketApi.lotSizes().then(({ data: d }) => setLotSizes(d.lotSizes ?? {})).catch(() => {}); }, []);
  const loaded = (result: unknown) => {
    const d = result as ReplayDay;
    setData(d); setPositions([]); setPlaying(false);
    setClock(d.spot[0]?.[0] ?? 0);
  };

  const open = data?.spot[0]?.[0] ?? 0;
  const close = data ? (data.spot[data.spot.length - 1]?.[0] ?? open) + CANDLE : 0;
  const clockRef = useRef(0);
  useEffect(() => { clockRef.current = clock; }, [clock]);
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      const next = Math.min(close, clockRef.current + speed * 60 * 0.2);
      setClock(next);
      if (next >= close) setPlaying(false);
    }, 200);
    return () => clearInterval(id);
  }, [playing, speed, close]);

  const lotSize = lotSizes[underlying] > 0 ? lotSizes[underlying] : 1;
  const spotNow = data ? priceAt(data.spot, clock) : null;
  const size = tf * 60;
  const bucketEnd = open + Math.ceil((clock - open + 1) / size) * size;
  // Rebuilt only when a 5-minute candle completes, not on every tick of the clock.
  const doneCount = data ? data.spot.filter((b) => b[0] + CANDLE <= clock).length : 0;
  const candles = useMemo(() => (data ? candlesAt(data.spot, (data.spot[doneCount - 1]?.[0] ?? 0) + CANDLE, tf) : []), [data, doneCount, tf]);

  const legPrice = (strike: number, type: 'CE' | 'PE') => {
    const row = data?.chain.find((s) => s.strike === strike);
    return row ? priceAt(type === 'CE' ? row.ce : row.pe, clock) : null;
  };
  const trade = (strike: number, type: 'CE' | 'PE', side: 'BUY' | 'SELL') => {
    const px = legPrice(strike, type);
    if (!data || px == null) return;
    const qty = lots * lotSize;
    setPositions((ps) => [...ps, { id: nextId.current++, strike, type, side, qty, entry: px, entryAt: clock, entryCharges: orderCharges(data.rates, side, px, qty) }]);
  };
  const closePos = (id: number) => setPositions((ps) => ps.map((p) => {
    if (p.id !== id || p.exit != null || !data) return p;
    const px = legPrice(p.strike, p.type) ?? p.entry;
    return { ...p, exit: px, exitAt: clock, exitCharges: orderCharges(data.rates, p.side === 'BUY' ? 'SELL' : 'BUY', px, p.qty) };
  }));

  const rows = positions.map((p) => {
    const now = p.exit ?? legPrice(p.strike, p.type) ?? p.entry;
    const sign = p.side === 'BUY' ? 1 : -1;
    const gross = sign * p.qty * (now - p.entry);
    const exitCharges = p.exitCharges ?? (data ? orderCharges(data.rates, p.side === 'BUY' ? 'SELL' : 'BUY', now, p.qty) : 0);
    return { p, now, gross, charges: p.entryCharges + exitCharges, net: gross - p.entryCharges - exitCharges };
  });
  const total = rows.reduce((a, r) => ({ gross: a.gross + r.gross, charges: a.charges + r.charges, net: a.net + r.net }), { gross: 0, charges: 0, net: 0 });

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-2xl border border-slate-200 p-4 grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
        <label className={label}>Index
          <select className={field} value={underlying} onChange={(e) => setUnderlying(e.target.value)}>
            {LAB_UNDERLYINGS.map((u) => <option key={u}>{u}</option>)}
          </select>
        </label>
        <label className={label}>Day
          <input type="date" className={field} value={day} max={todayIst()} onChange={(e) => setDay(e.target.value)} />
        </label>
        <label className={label}>Strikes each side
          <input type="number" min={3} max={12} className={field} value={each} onChange={(e) => setEach(Math.max(3, Math.min(12, Number(e.target.value) || 8)))} />
        </label>
        <button disabled={running} onClick={() => start(() => optionsLabApi.startReplay(underlying, day, each), loaded)}
          className="col-span-2 sm:col-span-2 py-2 rounded-xl text-sm font-bold bg-gradient-to-r from-sky-600 to-indigo-600 text-white disabled:opacity-50 flex items-center justify-center gap-2">
          {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Load day
        </button>
        <p className="col-span-2 sm:col-span-5 text-[10px] text-slate-400">
          Any past trading day your broker has prices for (ICICI Breeze for expired contracts). The first load of a day fetches every contract shown (about a second each); after that it opens at once.
        </p>
      </div>
      {job?.state === 'running' && <JobProgress job={job} />}
      {error && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      {data && (
        <>
          <div className="bg-white rounded-2xl border border-slate-200 p-3 flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1">
              <button className="p-1.5 rounded-lg hover:bg-slate-100" title="Back one candle" onClick={() => setClock((c) => Math.max(open, c - CANDLE))}><SkipBack className="w-4 h-4" /></button>
              <button className="p-1.5 rounded-lg bg-indigo-600 text-white" onClick={() => setPlaying((x) => !x)}>
                {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
              </button>
              <button className="p-1.5 rounded-lg hover:bg-slate-100" title="Forward one candle" onClick={() => setClock((c) => Math.min(close, c + CANDLE))}><SkipForward className="w-4 h-4" /></button>
            </div>
            <div className="flex items-center gap-1 text-[11px]">
              {SPEEDS.map((s) => (
                <button key={s} onClick={() => setSpeed(s)} className={`px-2 py-0.5 rounded-full ${speed === s ? 'bg-indigo-100 text-indigo-700 font-semibold' : 'text-slate-500 hover:bg-slate-100'}`}>
                  {s} min/s
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 text-[11px]">
              {[5, 15].map((m) => (
                <button key={m} onClick={() => setTf(m)} className={`px-2 py-0.5 rounded-full ${tf === m ? 'bg-sky-100 text-sky-700 font-semibold' : 'text-slate-500 hover:bg-slate-100'}`}>{m}m</button>
              ))}
            </div>
            <span className="font-mono text-sm font-bold text-slate-800">{hms(clock)}</span>
            <span className="flex items-center gap-1 text-[11px] text-slate-600" title="Time left in the current candle, in market time">
              <Timer className="w-3.5 h-3.5" /> {tf}m candle closes in <b className="font-mono">{mmss(Math.max(0, Math.min(bucketEnd, close) - clock))}</b>
            </span>
            <input type="range" min={open} max={close} step={60} value={clock} onChange={(e) => setClock(Number(e.target.value))} className="flex-1 min-w-[160px] accent-indigo-600" />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-3">
            <div className="xl:col-span-7 bg-white rounded-2xl border border-slate-200 p-3">
              <div className="flex items-center justify-between mb-1 text-xs">
                <span className="font-semibold text-slate-700">{data.underlying} {data.day} · expiry {data.expiry} ({data.daysToExpiry}d)</span>
                <span className="font-mono">{spotNow != null ? spotNow.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—'}</span>
              </div>
              <SpotChart candles={candles} key={`${data.day}-${tf}`} />
              {data.spotSource === 'parity' && (
                <p className="text-[10px] text-slate-400 mt-1">The broker had no index candles for this day, so the index is worked out from the {data.atm} call and put (strike + call − put).</p>
              )}
            </div>

            <div className="xl:col-span-5 bg-white rounded-2xl border border-slate-200 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-700">Option chain at {hms(clock).slice(0, 5)}</span>
                <label className="text-[10px] text-slate-500 flex items-center gap-1">Lots
                  <input type="number" min={1} max={50} value={lots} onChange={(e) => setLots(Math.max(1, Number(e.target.value) || 1))} className="w-12 px-1 py-0.5 border border-slate-200 rounded" />
                  × {lotSize}
                </label>
              </div>
              <table className="w-full text-[11px]">
                <thead><tr className="text-slate-400"><th className="text-left">Call</th><th className="text-right">LTP</th><th className="text-center">Strike</th><th className="text-left">LTP</th><th className="text-right">Put</th></tr></thead>
                <tbody>{data.chain.map((s) => {
                  const ce = priceAt(s.ce, clock), pe = priceAt(s.pe, clock);
                  const atm = spotNow != null && Math.abs(s.strike - spotNow) < data.step / 2;
                  const btn = 'px-1 rounded text-[9px] font-bold disabled:opacity-30';
                  return (
                    <tr key={s.strike} className={atm ? 'bg-amber-50' : ''}>
                      <td className="py-0.5 space-x-0.5">
                        <button disabled={ce == null} onClick={() => trade(s.strike, 'CE', 'BUY')} className={`${btn} bg-emerald-50 text-emerald-700`}>B</button>
                        <button disabled={ce == null} onClick={() => trade(s.strike, 'CE', 'SELL')} className={`${btn} bg-red-50 text-red-700`}>S</button>
                      </td>
                      <td className="text-right font-mono">{ce?.toFixed(2) ?? '—'}</td>
                      <td className="text-center font-semibold">{s.strike}</td>
                      <td className="font-mono">{pe?.toFixed(2) ?? '—'}</td>
                      <td className="text-right space-x-0.5">
                        <button disabled={pe == null} onClick={() => trade(s.strike, 'PE', 'BUY')} className={`${btn} bg-emerald-50 text-emerald-700`}>B</button>
                        <button disabled={pe == null} onClick={() => trade(s.strike, 'PE', 'SELL')} className={`${btn} bg-red-50 text-red-700`}>S</button>
                      </td>
                    </tr>
                  );
                })}</tbody>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 p-3 overflow-x-auto">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <span className="text-xs font-semibold text-slate-700">Replay positions</span>
              <span className="text-xs">
                Gross <b className={tone(total.gross)}>{inr(total.gross)}</b> · charges <b className="text-amber-700">{inr(total.charges)}</b> ·
                {' '}after charges <b className={tone(total.net)}>{inr(total.net)}</b>
              </span>
            </div>
            {rows.length === 0 ? <p className="text-[11px] text-slate-400">Press B or S in the chain to trade at the price at that moment. Charges use the rates of {data.day}; open positions include the cost of closing now.</p> : (
              <table className="w-full text-[11px] whitespace-nowrap">
                <thead><tr className="text-slate-400 border-b border-slate-100">
                  <th className="text-left py-1">Contract</th><th className="text-right">Qty</th><th className="text-right">Entry</th><th className="text-right">Now / exit</th>
                  <th className="text-right">Gross</th><th className="text-right">Charges</th><th className="text-right">Net</th><th />
                </tr></thead>
                <tbody>{rows.map(({ p, now, gross, charges, net }) => (
                  <tr key={p.id} className="border-b border-slate-50">
                    <td className="py-1"><span className={p.side === 'BUY' ? 'text-emerald-700' : 'text-red-700'}>{p.side}</span> {p.strike} {p.type} <span className="text-slate-400">@ {hms(p.entryAt).slice(0, 5)}</span></td>
                    <td className="text-right">{p.qty}</td>
                    <td className="text-right font-mono">{p.entry.toFixed(2)}</td>
                    <td className="text-right font-mono">{now.toFixed(2)}{p.exitAt != null && <span className="text-slate-400"> @ {hms(p.exitAt).slice(0, 5)}</span>}</td>
                    <td className={`text-right font-mono ${tone(gross)}`}>{inr(gross)}</td>
                    <td className="text-right font-mono text-amber-700">{inr(charges)}</td>
                    <td className={`text-right font-mono font-semibold ${tone(net)}`}>{inr(net)}</td>
                    <td className="text-right">{p.exit == null && <button onClick={() => closePos(p.id)} className="text-slate-400 hover:text-red-600" title="Close at the price now"><X className="w-3.5 h-3.5" /></button>}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function SpotChart({ candles }: { candles: LabBar[] }) {
  const el = useRef<HTMLDivElement>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const chart = useRef<IChartApi | null>(null);
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#64748b', fontSize: 11 },
      grid: { vertLines: { color: '#f1f5f9' }, horzLines: { color: '#f1f5f9' } },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 4 },
      autoSize: true,
      handleScroll: { vertTouchDrag: false },
    });
    series.current = c.addSeries(CandlestickSeries, { upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#16a34a', wickDownColor: '#dc2626', borderVisible: false });
    chart.current = c;
    return () => { c.remove(); series.current = null; chart.current = null; };
  }, []);
  useEffect(() => {
    // Shown in Indian time: the chart draws UTC, so shift by +5:30.
    series.current?.setData(candles.map((b) => ({ time: (b[0] + 19_800) as UTCTimestamp, open: b[1], high: b[2], low: b[3], close: b[4] })));
  }, [candles]);
  return <div ref={el} className="w-full" style={{ height: 'clamp(260px, 45vh, 380px)' }} />;
}
