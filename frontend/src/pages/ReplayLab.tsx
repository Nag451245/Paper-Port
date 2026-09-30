import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  createChart, createSeriesMarkers, ColorType, CandlestickSeries,
  type IChartApi, type ISeriesApi, type IPriceLine, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import {
  History, Play, Pause, SkipForward, ChevronsRight, RotateCcw, Square, Loader2, AlertCircle, Save, CheckCircle, Info,
} from 'lucide-react';
import { replayApi } from '@/services/api';
import {
  barTime, barAsOf, barsBetween, checkExit, validateLevels, closePosition, equity, summarize, netPnl, tradeCharges,
  buildContractSymbol, strikeStep, grossPnl,
  type Bar, type Position, type ClosedTrade, type EquityPoint, type Side, type ContractKind,
} from '@/lib/replay-engine';

// ─── Setup ───────────────────────────────────────────────────────

type Mode = 'stock' | 'fno';
type Interval = '1day' | '30minute' | '5minute' | '1minute';

interface Setup {
  mode: Mode;
  symbol: string;
  interval: Interval;
  from: string;
  to: string;
  capital: number;
}

const INTERVALS: { value: Interval; label: string }[] = [
  { value: '1day', label: 'Daily' },
  { value: '30minute', label: '30 min' },
  { value: '5minute', label: '5 min' },
  { value: '1minute', label: '1 min' },
];

/** Candles shown before the start date, so the chart has context. */
const LOOKBACK_DAYS: Record<Interval, number> = { '1day': 120, '30minute': 10, '5minute': 4, '1minute': 2 };
/** The server's limit per request, less the lookback. */
const MAX_DAYS: Record<Interval, number> = { '1day': 3500, '30minute': 165, '5minute': 55, '1minute': 7 };
const SPEEDS = [1, 2, 5, 10, 20];

const IST_MS = 330 * 60_000;
const chartTime = (ts: string) => ((barTime(ts) + IST_MS) / 1000) as UTCTimestamp;
const ymd = (ts: string) => ts.slice(0, 10);
const shiftDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const inr = (n: number) => `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const signed = (n: number) => (n >= 0 ? 'text-emerald-600' : 'text-red-600');
const apiError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

// ─── State ───────────────────────────────────────────────────────

interface ReplayState {
  setup: Setup | null;
  series: Record<string, Bar[]>;
  cursor: number;
  start: number;
  open: Position[];
  closed: ClosedTrade[];
  curve: EquityPoint[];
  ended: boolean;
}

type Action =
  | { type: 'LOAD'; setup: Setup; bars: Bar[]; start: number }
  | { type: 'STEP' }
  | { type: 'NEXT_DAY' }
  | { type: 'ADD_SERIES'; symbol: string; bars: Bar[] }
  | { type: 'OPEN'; position: Position }
  | { type: 'CLOSE'; id: string }
  | { type: 'EXIT_CHARGES'; ids: string[]; charges: number[] }
  | { type: 'END' }
  | { type: 'RESET' };

const EMPTY: ReplayState = { setup: null, series: {}, cursor: 0, start: 0, open: [], closed: [], curve: [], ended: false };

function baseBars(s: ReplayState): Bar[] {
  return s.setup ? s.series[s.setup.symbol] ?? [] : [];
}

function nowTime(s: ReplayState): number {
  const bars = baseBars(s);
  return bars.length ? barTime(bars[s.cursor].timestamp) : 0;
}

function priceAt(s: ReplayState, symbol: string, t: number): number | null {
  const bar = barAsOf(s.series[symbol] ?? [], t);
  return bar ? bar.close : null;
}

function markEquity(s: ReplayState): number {
  const t = nowTime(s);
  return equity(s.setup?.capital ?? 0, s.closed, s.open, (p) => priceAt(s, p.symbol, t));
}

/** Move the clock one candle, closing any position whose stop or target printed on the way. */
function stepOnce(s: ReplayState): ReplayState {
  const bars = baseBars(s);
  if (s.ended || s.cursor >= bars.length - 1) return s;
  const prevT = barTime(bars[s.cursor].timestamp);
  const nextT = barTime(bars[s.cursor + 1].timestamp);
  const open: Position[] = [];
  const closed = [...s.closed];
  for (const pos of s.open) {
    let exit: ClosedTrade | null = null;
    for (const bar of barsBetween(s.series[pos.symbol] ?? [], prevT, nextT)) {
      const hit = checkExit(pos, bar);
      if (hit) { exit = closePosition(pos, hit.price, bar.timestamp, hit.reason); break; }
    }
    if (exit) closed.push(exit); else open.push(pos);
  }
  const next = { ...s, cursor: s.cursor + 1, open, closed };
  return { ...next, curve: [...s.curve, { time: bars[s.cursor + 1].timestamp, value: markEquity(next) }] };
}

function reducer(s: ReplayState, a: Action): ReplayState {
  switch (a.type) {
    case 'LOAD': {
      const loaded = { ...EMPTY, setup: a.setup, series: { [a.setup.symbol]: a.bars }, cursor: a.start, start: a.start };
      return { ...loaded, curve: [{ time: a.bars[a.start].timestamp, value: a.setup.capital }] };
    }
    case 'STEP':
      return stepOnce(s);
    case 'NEXT_DAY': {
      const bars = baseBars(s);
      const day = ymd(bars[s.cursor]?.timestamp ?? '');
      let next = s;
      while (!next.ended && next.cursor < bars.length - 1 && ymd(bars[next.cursor].timestamp) === day) next = stepOnce(next);
      return next;
    }
    case 'ADD_SERIES':
      return { ...s, series: { ...s.series, [a.symbol]: a.bars } };
    case 'OPEN':
      return { ...s, open: [...s.open, a.position] };
    case 'CLOSE': {
      const pos = s.open.find((p) => p.id === a.id);
      const t = nowTime(s);
      const px = pos ? priceAt(s, pos.symbol, t) : null;
      if (!pos || px === null) return s;
      const time = baseBars(s)[s.cursor].timestamp;
      return { ...s, open: s.open.filter((p) => p.id !== a.id), closed: [...s.closed, closePosition(pos, px, time, 'MANUAL')] };
    }
    case 'EXIT_CHARGES': {
      const byId = new Map(a.ids.map((id, i) => [id, a.charges[i]]));
      return { ...s, closed: s.closed.map((t) => (byId.has(t.id) ? { ...t, exitCharges: byId.get(t.id) } : t)) };
    }
    case 'END': {
      const t = nowTime(s);
      const time = baseBars(s)[s.cursor]?.timestamp ?? '';
      const closed = [...s.closed];
      for (const p of s.open) {
        const px = priceAt(s, p.symbol, t);
        if (px !== null) closed.push(closePosition(p, px, time, 'END'));
      }
      const next = { ...s, open: [], closed, ended: true };
      return { ...next, curve: [...s.curve, { time, value: markEquity(next) }] };
    }
    case 'RESET':
      return EMPTY;
  }
}

let idSeq = 0;
const newId = () => `${Date.now().toString(36)}-${(idSeq++).toString(36)}`;

// ─── Chart ───────────────────────────────────────────────────────

interface Level { price: number; color: string; title: string }

function ReplayChart({ bars, daily, markers, levels }: {
  bars: Bar[]; daily: boolean; markers: SeriesMarker<Time>[]; levels: Level[];
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markerApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const shown = useRef<{ length: number; first: string }>({ length: 0, first: '' });

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#64748b', fontSize: 11 },
      grid: { vertLines: { color: '#f1f5f9' }, horzLines: { color: '#f1f5f9' } },
      rightPriceScale: { borderColor: '#e2e8f0' },
      timeScale: { borderColor: '#e2e8f0', timeVisible: !daily, secondsVisible: false, rightOffset: 6 },
      autoSize: true,
    });
    const s = c.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#16a34a', borderDownColor: '#dc2626',
      wickUpColor: '#16a34a', wickDownColor: '#dc2626',
    });
    chart.current = c;
    series.current = s;
    markerApi.current = createSeriesMarkers(s, []);
    shown.current = { length: 0, first: '' };
    return () => { c.remove(); chart.current = null; series.current = null; markerApi.current = null; lines.current = []; };
  }, [daily]);

  useEffect(() => {
    const s = series.current;
    if (!s || bars.length === 0) return;
    const toPoint = (b: Bar) => ({ time: chartTime(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close });
    const prev = shown.current;
    // One new candle: append it, so the view does not jump while playing.
    if (prev.first === bars[0].timestamp && bars.length === prev.length + 1) s.update(toPoint(bars[bars.length - 1]));
    else s.setData(bars.map(toPoint));
    shown.current = { length: bars.length, first: bars[0].timestamp };
  }, [bars]);

  useEffect(() => { markerApi.current?.setMarkers(markers); }, [markers]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = levels.map((l) => s.createPriceLine({ price: l.price, color: l.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.title }));
  }, [levels]);

  // Inline height: the chart library sizes itself to this box, so it must never depend on a class being generated.
  return <div ref={el} className="w-full" style={{ height: 'clamp(300px, 55vh, 440px)' }} />;
}

// ─── Page ────────────────────────────────────────────────────────

const inputCls = 'w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-800 outline-none focus:border-indigo-500';
const chip = (active: boolean) =>
  `px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`;

export default function ReplayLab() {
  const [state, dispatch] = useReducer(reducer, EMPTY);
  const [form, setForm] = useState<Setup>({ mode: 'stock', symbol: 'RELIANCE', interval: '5minute', from: '2025-02-03', to: '2025-02-07', capital: 1_000_000 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);

  const setup = state.setup;
  const bars = useMemo(() => (setup ? state.series[setup.symbol] ?? [] : []), [setup, state.series]);
  const now = bars[state.cursor];
  const t = now ? barTime(now.timestamp) : 0;
  const atEnd = !!setup && state.cursor >= bars.length - 1;

  // ── load ──
  const load = async () => {
    setError(null); setNotice(null); setSavedId(null); setPlaying(false);
    const symbol = form.symbol.trim().toUpperCase();
    if (!symbol) return setError('Pick a symbol.');
    if (dayDiff(form.from, form.to) < 0) return setError('The start date is after the end date.');
    if (dayDiff(form.from, form.to) > MAX_DAYS[form.interval]) {
      return setError(`${INTERVALS.find((i) => i.value === form.interval)?.label} candles can be replayed ${MAX_DAYS[form.interval]} days at a time.`);
    }
    setLoading(true);
    try {
      const { data } = await replayApi.candles(symbol, form.interval, shiftDays(form.from, -LOOKBACK_DAYS[form.interval]), form.to);
      const start = data.bars.findIndex((b) => ymd(b.timestamp) >= form.from);
      if (data.bars.length === 0 || start < 0) {
        setError(`No ${symbol} candles for that period. ${form.interval !== '1day' ? 'Intraday history needs ICICI Breeze connected (without it only about the last 60 days of 5-minute data exist).' : ''}`);
        return;
      }
      dispatch({ type: 'LOAD', setup: { ...form, symbol }, bars: data.bars, start });
    } catch (err) {
      setError(apiError(err, 'Could not load candles.'));
    } finally {
      setLoading(false);
    }
  };

  // ── playback ──
  useEffect(() => {
    if (!playing) return;
    if (atEnd || state.ended) { setPlaying(false); return; }
    const id = window.setTimeout(() => dispatch({ type: 'STEP' }), 1000 / speed);
    return () => window.clearTimeout(id);
  }, [playing, speed, state.cursor, atEnd, state.ended]);

  const togglePlay = useCallback(() => setPlaying((p) => !p), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (!setup || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.code === 'ArrowRight') { e.preventDefault(); setPlaying(false); dispatch({ type: 'STEP' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setup, togglePlay]);

  // ── exit charges, priced by the server in the background ──
  const pricing = useRef(new Set<string>());
  useEffect(() => {
    const todo = state.closed.filter((c) => c.exitCharges === undefined && !pricing.current.has(c.id));
    if (!todo.length) return;
    todo.forEach((c) => pricing.current.add(c.id));
    replayApi.charges(todo.map((c) => ({ symbol: c.symbol, qty: c.qty, price: c.exitPrice || 0.05, side: c.side === 'LONG' ? 'SELL' : 'BUY' })))
      .then(({ data }) => dispatch({ type: 'EXIT_CHARGES', ids: todo.map((c) => c.id), charges: data.charges }))
      .catch(() => {
        dispatch({ type: 'EXIT_CHARGES', ids: todo.map((c) => c.id), charges: todo.map(() => 0) });
        setNotice('Charges could not be priced for some exits; they are counted as zero.');
      });
  }, [state.closed]);

  // ── orders ──
  const openPosition: OnOrder = async (symbol, label, side, qty, stopLoss, target, fillPrice) => {
    setError(null);
    // A leg loaded a moment ago is not in `state` yet, so its ticket passes the price.
    const price = fillPrice ?? priceAt(state, symbol, t);
    const bad = validateLevels(side, price ?? 0, stopLoss, target);
    if (bad) return setError(bad);
    let entryCharges = 0;
    try {
      const { data } = await replayApi.charges([{ symbol, qty, price: price!, side: side === 'LONG' ? 'BUY' : 'SELL' }]);
      entryCharges = data.charges[0];
    } catch {
      setNotice('Charges could not be priced for that entry; counted as zero.');
    }
    dispatch({
      type: 'OPEN',
      position: { id: newId(), symbol, label, side, qty, entryPrice: price!, entryTime: now.timestamp, entryCharges, stopLoss, target },
    });
  };

  // ── derived ──
  const visible = useMemo(() => bars.slice(0, state.cursor + 1), [bars, state.cursor]);
  const summary = useMemo(
    () => summarize(state.closed, state.curve, setup?.capital ?? 0),
    [state.closed, state.curve, setup?.capital],
  );
  const eq = setup ? markEquity(state) : 0;
  const unrealized = state.open.reduce((sum, p) => {
    const px = priceAt(state, p.symbol, t);
    return px === null ? sum : sum + grossPnl(p.side, p.qty, p.entryPrice, px);
  }, 0);

  const markers = useMemo<SeriesMarker<Time>[]>(() => {
    if (!setup || setup.mode !== 'stock') return [];
    const out: SeriesMarker<Time>[] = [];
    const add = (ts: string, text: string, long: boolean, entry: boolean) => {
      if (barTime(ts) > t) return;
      out.push({
        time: chartTime(ts), text,
        position: long === entry ? 'belowBar' : 'aboveBar',
        shape: long === entry ? 'arrowUp' : 'arrowDown',
        color: entry ? (long ? '#16a34a' : '#dc2626') : '#475569',
      });
    };
    for (const p of [...state.closed, ...state.open]) add(p.entryTime, p.side === 'LONG' ? 'B' : 'S', p.side === 'LONG', true);
    for (const c of state.closed) add(c.exitTime, c.reason === 'STOP' ? 'SL' : c.reason === 'TARGET' ? 'TP' : 'X', c.side === 'LONG', false);
    return out.sort((a, b) => (a.time as number) - (b.time as number));
  }, [setup, state.closed, state.open, t]);

  const levels = useMemo<Level[]>(() => {
    if (!setup || setup.mode !== 'stock') return [];
    return state.open.flatMap((p) => [
      { price: p.entryPrice, color: '#6366f1', title: p.side === 'LONG' ? 'Buy' : 'Sell' },
      ...(p.stopLoss !== undefined ? [{ price: p.stopLoss, color: '#dc2626', title: 'SL' }] : []),
      ...(p.target !== undefined ? [{ price: p.target, color: '#16a34a', title: 'TP' }] : []),
    ]);
  }, [setup, state.open]);

  // ── save ──
  const save = async () => {
    if (!setup) return;
    setSaving(true); setError(null);
    try {
      const { data } = await replayApi.saveSession({
        mode: setup.mode, symbol: setup.symbol, interval: setup.interval, from: setup.from, to: setup.to,
        initialCapital: setup.capital,
        trades: state.closed.map((c) => ({
          symbol: c.symbol, side: c.side, qty: c.qty, entryTime: c.entryTime, exitTime: c.exitTime,
          entryPrice: c.entryPrice, exitPrice: c.exitPrice, charges: tradeCharges(c), netPnl: netPnl(c), reason: c.reason,
        })),
        equityCurve: state.curve.map((p) => ({ time: p.time, value: p.value })),
      });
      setSavedId((data as { id?: string }).id ?? 'saved');
    } catch (err) {
      setError(apiError(err, 'Could not save the session.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 px-0 sm:px-1">
      <div>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2"><History className="w-5 h-5 text-indigo-600" /> Replay Lab</h1>
        <p className="text-sm text-slate-500 mt-0.5">Trade the past by hand: step through old candles, place orders on what you can see, and keep score.</p>
      </div>

      {/* Setup */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-1.5 mb-3">
          <button className={chip(form.mode === 'stock')} onClick={() => setForm((f) => ({ ...f, mode: 'stock', symbol: f.mode === 'stock' ? f.symbol : 'RELIANCE' }))}>Stocks</button>
          <button className={chip(form.mode === 'fno')} onClick={() => setForm((f) => ({ ...f, mode: 'fno', symbol: f.mode === 'fno' ? f.symbol : 'NIFTY', interval: f.interval === '1day' ? '5minute' : f.interval }))}>F&amp;O</button>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3 items-end">
          <label className="col-span-2 md:col-span-1 text-[10px] text-slate-400">
            {form.mode === 'fno' ? 'Underlying' : 'Symbol'}
            <input value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value.toUpperCase() })} className={`${inputCls} mt-0.5`} />
          </label>
          <label className="text-[10px] text-slate-400">From
            <input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} className={`${inputCls} mt-0.5`} />
          </label>
          <label className="text-[10px] text-slate-400">To
            <input type="date" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} className={`${inputCls} mt-0.5`} />
          </label>
          <label className="text-[10px] text-slate-400">Candles
            <select value={form.interval} onChange={(e) => setForm({ ...form, interval: e.target.value as Interval })} className={`${inputCls} mt-0.5`}>
              {INTERVALS.filter((i) => form.mode === 'stock' || i.value !== '1day').map((i) => <option key={i.value} value={i.value}>{i.label}</option>)}
            </select>
          </label>
          <label className="text-[10px] text-slate-400">Capital (₹)
            <input type="number" min={10000} step={10000} value={form.capital} onChange={(e) => setForm({ ...form, capital: Number(e.target.value) })} className={`${inputCls} mt-0.5`} />
          </label>
          <button onClick={load} disabled={loading}
            className="col-span-2 md:col-span-1 flex items-center justify-center gap-2 py-2 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-500 disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {setup ? 'Restart' : 'Start replay'}
          </button>
        </div>
        <p className="mt-2 text-[10px] text-slate-400 flex items-start gap-1">
          <Info className="w-3 h-3 mt-px shrink-0" />
          Orders fill at the close of the candle on screen. Stops and targets are checked on later candles; a gap fills at the open,
          and if one candle reaches both, the stop counts first. Charges use the same model as paper trading.
          {form.mode === 'fno' && ' Option and futures prices come from ICICI Breeze.'}
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-600">
          <AlertCircle className="h-4 w-4 shrink-0" /><span>{error}</span>
        </div>
      )}
      {notice && <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-2 text-xs text-amber-700">{notice}</div>}

      {setup && now && (
        <>
          {/* Scoreboard */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {[
              ['Now', <span className="font-mono">{setup.interval === '1day' ? ymd(now.timestamp) : now.timestamp.slice(0, 16)}</span>],
              ['Equity', inr(eq)],
              ['Open P&L', <span className={signed(unrealized)}>{inr(unrealized)}</span>],
              ['Closed P&L (net)', <span className={signed(summary.netPnl)}>{inr(summary.netPnl)}</span>],
              ['Trades · win rate', `${summary.trades} · ${summary.winRate.toFixed(0)}%`],
              ['Max drawdown', `${summary.maxDrawdownPct.toFixed(2)}%`],
            ].map(([label, value], i) => (
              <div key={i} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                <p className="text-[10px] text-slate-400">{label}</p>
                <p className="text-sm font-semibold text-slate-800 truncate">{value}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Chart + controls */}
            <div className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-slate-700">{setup.symbol} {setup.mode === 'fno' && <span className="text-slate-400 font-normal">(underlying)</span>}</p>
                <p className="text-xs font-mono text-slate-500">
                  O {now.open} · H {now.high} · L {now.low} · C <span className="font-semibold text-slate-800">{now.close}</span>
                </p>
              </div>
              <ReplayChart bars={visible} daily={setup.interval === '1day'} markers={markers} levels={levels} />
              <div className="flex flex-wrap items-center gap-2 mt-3">
                <button onClick={togglePlay} disabled={atEnd || state.ended} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold disabled:opacity-40">
                  {playing ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}{playing ? 'Pause' : 'Play'}
                </button>
                <button onClick={() => { setPlaying(false); dispatch({ type: 'STEP' }); }} disabled={atEnd || state.ended} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-xs font-medium disabled:opacity-40" title="Next candle (→)">
                  <SkipForward className="w-3.5 h-3.5" /> Next candle
                </button>
                {setup.interval !== '1day' && (
                  <button onClick={() => { setPlaying(false); dispatch({ type: 'NEXT_DAY' }); }} disabled={atEnd || state.ended} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-xs font-medium disabled:opacity-40">
                    <ChevronsRight className="w-3.5 h-3.5" /> Next day
                  </button>
                )}
                <label className="text-[10px] text-slate-400 flex items-center gap-1">Speed
                  <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-1 text-xs">
                    {SPEEDS.map((s) => <option key={s} value={s}>{s} candles/s</option>)}
                  </select>
                </label>
                <span className="text-[10px] text-slate-400 ml-auto">Candle {state.cursor - state.start + 1} of {bars.length - state.start} · Space = play, → = step</span>
              </div>
            </div>

            {/* Ticket */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              {state.ended ? (
                <p className="text-xs text-slate-500">Session ended. Review the results below, then save or restart.</p>
              ) : setup.mode === 'stock' ? (
                <StockTicket symbol={setup.symbol} price={now.close} equity={eq} onOrder={openPosition} />
              ) : (
                <FnoTicket
                  underlying={setup.symbol} spot={now.close} now={now.timestamp} interval={setup.interval} sessionTo={setup.to}
                  series={state.series} onSeries={(symbol, b) => dispatch({ type: 'ADD_SERIES', symbol, bars: b })}
                  onOrder={openPosition} onError={setError}
                />
              )}
            </div>
          </div>

          {/* Positions */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-slate-700">Open positions</p>
              {!state.ended && (
                <button onClick={() => { setPlaying(false); dispatch({ type: 'END' }); }} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-800 text-white text-xs font-semibold">
                  <Square className="w-3 h-3" /> End session
                </button>
              )}
            </div>
            {state.open.length === 0 ? <p className="text-xs text-slate-400">None.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead><tr className="text-slate-400 text-left">
                    <th className="py-1 pr-3">Instrument</th><th className="pr-3">Side</th><th className="pr-3 text-right">Qty</th>
                    <th className="pr-3 text-right">Entry</th><th className="pr-3 text-right">Now</th><th className="pr-3 text-right">SL / TP</th>
                    <th className="pr-3 text-right">P&amp;L</th><th />
                  </tr></thead>
                  <tbody>
                    {state.open.map((p) => {
                      const px = priceAt(state, p.symbol, t);
                      const pnl = px === null ? 0 : grossPnl(p.side, p.qty, p.entryPrice, px);
                      return (
                        <tr key={p.id} className="border-t border-slate-100">
                          <td className="py-1.5 pr-3 font-medium text-slate-700">{p.label}</td>
                          <td className={`pr-3 ${p.side === 'LONG' ? 'text-emerald-600' : 'text-red-600'}`}>{p.side === 'LONG' ? 'Buy' : 'Sell'}</td>
                          <td className="pr-3 text-right font-mono">{p.qty}</td>
                          <td className="pr-3 text-right font-mono">{p.entryPrice}</td>
                          <td className="pr-3 text-right font-mono">{px ?? '—'}</td>
                          <td className="pr-3 text-right font-mono text-slate-500">{p.stopLoss ?? '—'} / {p.target ?? '—'}</td>
                          <td className={`pr-3 text-right font-mono ${signed(pnl)}`}>{inr(pnl)}</td>
                          <td className="text-right">
                            <button onClick={() => dispatch({ type: 'CLOSE', id: p.id })} className="px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium">Exit</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Trade log + results */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
              <p className="text-xs font-semibold text-slate-700">Closed trades</p>
              <div className="flex items-center gap-2">
                {savedId && <span className="flex items-center gap-1 text-xs text-emerald-600"><CheckCircle className="w-3.5 h-3.5" /> Saved to your backtest results</span>}
                <button onClick={() => { setPlaying(false); dispatch({ type: 'LOAD', setup, bars, start: state.start }); setSavedId(null); }}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-xs font-medium">
                  <RotateCcw className="w-3.5 h-3.5" /> Replay again
                </button>
                <button onClick={save} disabled={saving || !state.ended || state.closed.length === 0 || !!savedId}
                  title={state.ended ? '' : 'End the session first'}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold disabled:opacity-40">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Save session
                </button>
              </div>
            </div>
            {state.closed.length === 0 ? <p className="text-xs text-slate-400">No trades yet.</p> : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 mb-3 text-xs">
                  {[
                    ['Net P&L', <span className={signed(summary.netPnl)}>{inr(summary.netPnl)}</span>],
                    ['Gross P&L', inr(summary.grossPnl)],
                    ['Charges', inr(summary.charges)],
                    ['Win rate', `${summary.winRate.toFixed(1)}% (${summary.wins}/${summary.trades})`],
                    ['Avg win / loss', `${inr(summary.avgWin)} / ${inr(summary.avgLoss)}`],
                    ['Profit factor', summary.profitFactor === null ? '∞' : summary.profitFactor.toFixed(2)],
                    ['Max drawdown', `${inr(summary.maxDrawdown)} (${summary.maxDrawdownPct.toFixed(2)}%)`],
                  ].map(([label, value], i) => (
                    <div key={i} className="rounded-lg bg-slate-50 px-2.5 py-1.5">
                      <p className="text-[10px] text-slate-400">{label}</p><p className="font-semibold text-slate-800">{value}</p>
                    </div>
                  ))}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="text-slate-400 text-left">
                      <th className="py-1 pr-3">In</th><th className="pr-3">Out</th><th className="pr-3">Instrument</th><th className="pr-3">Side</th>
                      <th className="pr-3 text-right">Qty</th><th className="pr-3 text-right">Entry</th><th className="pr-3 text-right">Exit</th>
                      <th className="pr-3">Why</th><th className="pr-3 text-right">Charges</th><th className="text-right">Net P&amp;L</th>
                    </tr></thead>
                    <tbody>
                      {[...state.closed].reverse().map((c) => (
                        <tr key={c.id} className="border-t border-slate-100">
                          <td className="py-1.5 pr-3 font-mono text-slate-500">{c.entryTime.slice(5, 16)}</td>
                          <td className="pr-3 font-mono text-slate-500">{c.exitTime.slice(5, 16)}</td>
                          <td className="pr-3 font-medium text-slate-700">{c.label}</td>
                          <td className={`pr-3 ${c.side === 'LONG' ? 'text-emerald-600' : 'text-red-600'}`}>{c.side === 'LONG' ? 'Buy' : 'Sell'}</td>
                          <td className="pr-3 text-right font-mono">{c.qty}</td>
                          <td className="pr-3 text-right font-mono">{c.entryPrice}</td>
                          <td className="pr-3 text-right font-mono">{c.exitPrice}</td>
                          <td className="pr-3 text-slate-500">{{ MANUAL: 'Exit', STOP: 'Stop-loss', TARGET: 'Target', END: 'Session end' }[c.reason]}</td>
                          <td className="pr-3 text-right font-mono text-slate-500">{c.exitCharges === undefined ? '…' : inr(tradeCharges(c))}</td>
                          <td className={`text-right font-mono ${signed(netPnl(c))}`}>{inr(netPnl(c))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Order tickets ───────────────────────────────────────────────

type OnOrder = (
  symbol: string, label: string, side: Side, qty: number, stopLoss?: number, target?: number, fillPrice?: number,
) => Promise<void>;
const optionalNumber = (v: string) => (v.trim() === '' ? undefined : Number(v));

function StockTicket({ symbol, price, equity: eq, onOrder }: { symbol: string; price: number; equity: number; onOrder: OnOrder }) {
  const [qty, setQty] = useState('10');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [busy, setBusy] = useState(false);
  const n = Math.floor(Number(qty));
  const notional = n * price;

  const place = async (side: Side) => {
    setBusy(true);
    try { await onOrder(symbol, symbol, side, n, optionalNumber(sl), optionalNumber(tp)); setSl(''); setTp(''); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-700">Order · {symbol} @ <span className="font-mono">{price}</span></p>
      <label className="block text-[10px] text-slate-400">Quantity
        <input type="number" min={1} step={1} value={qty} onChange={(e) => setQty(e.target.value)} className={`${inputCls} mt-0.5`} />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px] text-slate-400">Stop-loss (optional)
          <input type="number" step="0.05" value={sl} onChange={(e) => setSl(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
        <label className="text-[10px] text-slate-400">Target (optional)
          <input type="number" step="0.05" value={tp} onChange={(e) => setTp(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
      </div>
      <p className={`text-[10px] ${notional > eq ? 'text-amber-600' : 'text-slate-400'}`}>
        Value {inr(notional)}{notional > eq ? ' — more than your equity (no margin model here)' : ''}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button disabled={busy || !(n > 0)} onClick={() => place('LONG')} className="py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-40">Buy</button>
        <button disabled={busy || !(n > 0)} onClick={() => place('SHORT')} className="py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold disabled:opacity-40">Sell</button>
      </div>
    </div>
  );
}

function FnoTicket({ underlying, spot, now, interval, sessionTo, series, onSeries, onOrder, onError }: {
  underlying: string; spot: number; now: string; interval: Interval; sessionTo: string;
  series: Record<string, Bar[]>; onSeries: (symbol: string, bars: Bar[]) => void; onOrder: OnOrder; onError: (e: string | null) => void;
}) {
  const step = strikeStep(underlying);
  const atm = step ? Math.round(spot / step) * step : null;
  const [kind, setKind] = useState<ContractKind>('CE');
  const [expiry, setExpiry] = useState('');
  const [strike, setStrike] = useState(atm ? String(atm) : '');
  const [lots, setLots] = useState('1');
  const [lotSize, setLotSize] = useState('');
  const [lotSource, setLotSource] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    replayApi.lotSize(underlying)
      .then(({ data }) => { if (data.lotSize) setLotSize(String(data.lotSize)); setLotSource(data.source); })
      .catch(() => setLotSource('unknown'));
  }, [underlying]);

  const symbol = buildContractSymbol(underlying, kind, expiry, strike);
  const qty = Math.floor(Number(lots)) * Math.floor(Number(lotSize));
  const today = ymd(now);

  const place = async (side: Side) => {
    if (!symbol) return;
    onError(null);
    if (expiry < today) return onError('That contract had already expired at this point in the replay.');
    setBusy(true);
    try {
      let legBars = series[symbol];
      if (!legBars) {
        const to = expiry < sessionTo ? expiry : sessionTo;
        const maxTo = shiftDays(today, MAX_DAYS[interval]);
        const { data } = await replayApi.candles(symbol, interval, today, to < maxTo ? to : maxTo);
        legBars = data.bars;
        onSeries(symbol, legBars);
      }
      const entry = barAsOf(legBars, barTime(now));
      if (!entry || ymd(entry.timestamp) !== today) {
        onError(`No trade in ${symbol} yet at ${now.slice(0, 16)}. Breeze has no candle for it (check the expiry and strike, and that Breeze is connected).`);
        return;
      }
      const label = `${underlying} ${expiry.slice(5)} ${kind === 'FUT' ? 'FUT' : `${strike} ${kind}`}`;
      await onOrder(symbol, label, side, qty, optionalNumber(sl), optionalNumber(tp), entry.close);
      setSl(''); setTp('');
    } catch (err) {
      onError(apiError(err, `Could not load ${symbol}.`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold text-slate-700">
        Add a leg · {underlying} spot <span className="font-mono">{spot}</span>
        {atm !== null && <span className="text-slate-400 font-normal"> · ATM ≈ {atm}</span>}
      </p>
      <div className="flex gap-1.5">
        {(['CE', 'PE', 'FUT'] as ContractKind[]).map((k) => (
          <button key={k} onClick={() => setKind(k)} className={chip(kind === k)}>{k === 'CE' ? 'Call' : k === 'PE' ? 'Put' : 'Future'}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px] text-slate-400">Expiry
          <input type="date" value={expiry} min={today} onChange={(e) => setExpiry(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
        {kind !== 'FUT' && (
          <label className="text-[10px] text-slate-400">Strike
            <input type="number" step={step ?? 1} value={strike} onChange={(e) => setStrike(e.target.value)} className={`${inputCls} mt-0.5`} />
          </label>
        )}
        <label className="text-[10px] text-slate-400">Lots
          <input type="number" min={1} step={1} value={lots} onChange={(e) => setLots(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
        <label className="text-[10px] text-slate-400" title={lotSource}>Lot size
          <input type="number" min={1} step={1} value={lotSize} onChange={(e) => setLotSize(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
        <label className="text-[10px] text-slate-400">Stop-loss (premium)
          <input type="number" step="0.05" value={sl} onChange={(e) => setSl(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
        <label className="text-[10px] text-slate-400">Target (premium)
          <input type="number" step="0.05" value={tp} onChange={(e) => setTp(e.target.value)} className={`${inputCls} mt-0.5`} />
        </label>
      </div>
      <p className="text-[10px] text-slate-400 leading-relaxed">
        {symbol ? <>Contract <span className="font-mono text-slate-600">{symbol}</span>, quantity {qty > 0 ? qty : '—'}.</> : 'Pick an expiry and a whole-number strike.'}
        {' '}Lot size: {lotSource.startsWith('default') ? "today's size; it may have been different on this date — edit it if so." : lotSource || '…'}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <button disabled={busy || !symbol || !(qty > 0)} onClick={() => place('LONG')} className="py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold disabled:opacity-40">
          {busy ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Buy'}
        </button>
        <button disabled={busy || !symbol || !(qty > 0)} onClick={() => place('SHORT')} className="py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-xs font-bold disabled:opacity-40">
          {busy ? <Loader2 className="w-4 h-4 animate-spin inline" /> : 'Sell'}
        </button>
      </div>
    </div>
  );
}
