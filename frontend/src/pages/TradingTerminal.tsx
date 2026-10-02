import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Search,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Loader2,
  X,
} from 'lucide-react';
import { portfolioApi, tradingApi, marketApi } from '@/services/api';
import { createChart, ColorType, CandlestickSeries, type IChartApi, type ISeriesApi, type CandlestickData, type Time } from 'lightweight-charts';
import { TIMEFRAMES, timeframeSpec, isIntraday, aggregate, applyTick, type Timeframe, type ChartBar, type RawBar } from '@/lib/candles';
import { useLivePrice } from '@/hooks/useLivePrice';
import { useTradeUpdates } from '@/hooks/useTradeUpdates';
import OrderForm from '@/components/trading/OrderForm';
import PositionTable from '@/components/trading/PositionTable';
import OrderTable from '@/components/trading/OrderTable';
import TradeTable from '@/components/trading/TradeTable';
import { ExchangeBadge } from '@/components/trading/StatusBadge';

type Tab = 'positions' | 'orders' | 'trades';

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(v: any): number {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v) || 0 : Number(v);
}

interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  segment?: string;
}

const EXCHANGES = [
  { value: '', label: 'All Markets' },
  { value: 'NSE', label: 'NSE' },
  { value: 'BSE', label: 'BSE' },
  { value: 'MCX', label: 'MCX' },
  { value: 'CDS', label: 'Forex' },
] as const;

export default function TradingTerminal() {
  const [symbol, setSymbol] = useState('');
  const [selectedExchange, setSelectedExchange] = useState('NSE');
  const [searchExchangeFilter, setSearchExchangeFilter] = useState('');

  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const [portfolios, setPortfolios] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('positions');

  const TAB_PAGE_SIZE = 20;
  const [orderPage, setOrderPage] = useState(1);
  const [orderTotal, setOrderTotal] = useState(0);
  const [tradePage, setTradePage] = useState(1);
  const [tradeTotal, setTradeTotal] = useState(0);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const pickedQuery = useRef('');
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [quote, setQuote] = useState<any>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [posLtpMap, setPosLtpMap] = useState<Record<string, number>>({});

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>(() => {
    try { return (localStorage.getItem('terminal.timeframe') as Timeframe) || '1D'; } catch { return '1D'; }
  });
  const timeframeRef = useRef(timeframe);
  const lastBarRef = useRef<ChartBar | undefined>(undefined);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartEmpty, setChartEmpty] = useState(false);

  // Real-time live price via WebSocket
  const livePrice = useLivePrice(symbol || null);

  const lastFetchRef = useRef(0);
  const fetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchOrders = useCallback(async (page: number) => {
    try {
      const oRes = await tradingApi.listOrders({ page, limit: TAB_PAGE_SIZE });
      const oData = oRes.data;
      if (oData && typeof oData === 'object' && 'orders' in oData) {
        setOrders((oData as any).orders ?? []);
        setOrderTotal((oData as any).total ?? 0);
        setOrderPage((oData as any).page ?? page);
      } else {
        setOrders(Array.isArray(oData) ? oData : []);
      }
    } catch (e: any) {
      setError('Failed to load orders: ' + (e?.response?.data?.error ?? e.message));
    }
  }, []);

  const fetchTrades = useCallback(async (page: number) => {
    try {
      const tRes = await tradingApi.listTrades({ page, limit: TAB_PAGE_SIZE });
      const tData = tRes.data;
      if (tData && typeof tData === 'object' && 'trades' in tData) {
        setTrades((tData as any).trades ?? []);
        setTradeTotal((tData as any).total ?? 0);
        setTradePage((tData as any).page ?? page);
      } else {
        setTrades(Array.isArray(tData) ? tData : []);
      }
    } catch (e: any) {
      setError('Failed to load trades: ' + (e?.response?.data?.error ?? e.message));
    }
  }, []);

  const fetchAllImmediate = useCallback(async () => {
    setIsLoading(true);
    const errors: string[] = [];
    try {
      const [pRes, , posRes] = await Promise.all([
        portfolioApi.list().catch((e) => { errors.push('Portfolio: ' + (e?.response?.data?.error ?? e.message)); return { data: [] }; }),
        fetchOrders(1),
        tradingApi.positions().catch((e) => { errors.push('Positions: ' + (e?.response?.data?.error ?? e.message)); return { data: [] }; }),
        fetchTrades(1),
      ]);

      const pList = Array.isArray(pRes.data) ? pRes.data : [];
      setPortfolios(pList);
      if (pList.length > 0) setPortfolioId((prev) => prev ?? pList[0].id);
      setPositions(Array.isArray(posRes.data) ? posRes.data : []);

      if (errors.length > 0) setError('Some data failed to load: ' + errors.join('; '));
    } catch (e: any) {
      setError('Failed to load trading data: ' + (e?.message ?? 'Unknown error'));
    } finally {
      setIsLoading(false);
      lastFetchRef.current = Date.now();
    }
  }, [fetchOrders, fetchTrades]);

  const fetchAll = useCallback(() => {
    const now = Date.now();
    const elapsed = now - lastFetchRef.current;
    const MIN_INTERVAL = 2000;
    if (elapsed < MIN_INTERVAL) {
      if (!fetchTimerRef.current) {
        fetchTimerRef.current = setTimeout(() => {
          fetchTimerRef.current = null;
          fetchAllImmediate();
        }, MIN_INTERVAL - elapsed);
      }
      return;
    }
    fetchAllImmediate();
  }, [fetchAllImmediate]);

  useEffect(() => { fetchAll(); }, [fetchAll]);
  useEffect(() => () => { if (fetchTimerRef.current) clearTimeout(fetchTimerRef.current); }, []);

  // WebSocket-driven auto-refresh on order/position changes
  useTradeUpdates(fetchAll);

  // Auto-dismiss alerts
  useEffect(() => {
    if (!success && !error) return;
    const t = setTimeout(() => { setSuccess(null); setError(null); }, 5000);
    return () => clearTimeout(t);
  }, [success, error]);

  // Update quote from live WebSocket price
  useEffect(() => {
    if (livePrice && symbol) {
      setQuote((prev: any) => ({
        ...prev,
        ltp: livePrice.ltp,
        change: livePrice.change,
        change_pct: livePrice.changePercent,
        timestamp: livePrice.timestamp,
      }));
    }
  }, [livePrice, symbol]);

  // Update position LTPs via WebSocket live prices
  useEffect(() => {
    if (!livePrice) return;
    for (const pos of positions) {
      if (pos.symbol === symbol && livePrice.ltp > 0) {
        setPosLtpMap((prev) => ({ ...prev, [symbol]: livePrice.ltp }));
      }
    }
  }, [livePrice, positions, symbol]);

  // Fallback: poll position prices for symbols without active WebSocket subscription
  useEffect(() => {
    if (positions.length === 0) return;
    const posEntries = positions.map((p: any) => ({ sym: p.symbol as string, exch: (p.exchange ?? 'NSE') as string }));
    const unique = [...new Map(posEntries.map(e => [e.sym, e])).values()];
    const fetchPositionPrices = () => {
      unique.forEach(({ sym, exch }) => {
        if (posLtpMap[sym] && sym === symbol) return; // already getting via WebSocket
        marketApi.quote(sym, exch)
          .then(({ data }) => {
            const ltp = num((data as any)?.ltp ?? (data as any)?.last_price);
            if (ltp > 0) setPosLtpMap((prev) => ({ ...prev, [sym]: ltp }));
          })
          .catch(() => {});
      });
    };
    fetchPositionPrices();
    const interval = setInterval(fetchPositionPrices, 30_000);
    return () => clearInterval(interval);
  }, [positions, symbol, posLtpMap]);

  // Fallback: poll quote if no WebSocket data for 15s
  useEffect(() => {
    if (!symbol) return;
    if (livePrice) return; // WebSocket is providing data, skip polling
    const poll = () => {
      marketApi.quote(symbol, selectedExchange)
        .then(({ data }) => setQuote(data))
        .catch(() => {});
    };
    const interval = setInterval(poll, 10_000);
    return () => clearInterval(interval);
  }, [symbol, selectedExchange, livePrice]);

  // Symbol search with debounce
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (searchQuery.length < 1) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }
    if (searchQuery === pickedQuery.current) return;   // filled in by picking a result
    searchTimeout.current = setTimeout(async () => {
      try {
        const { data } = await marketApi.search(searchQuery, searchExchangeFilter || undefined);
        const results = Array.isArray(data) ? data : [];
        setSearchResults(results.slice(0, 15));
        setShowDropdown(results.length > 0);
      } catch { setSearchResults([]); }
    }, 300);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [searchQuery, searchExchangeFilter]);

  /** Load candles for the chosen timeframe; quiet reloads keep the user's zoom. */
  const loadChart = useCallback(async (sym: string, exch: string, quiet = false) => {
    const tf = timeframeRef.current;
    const spec = timeframeSpec(tf);
    const istToday = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() + 330 * 60_000 - spec.days * 86_400_000).toISOString().slice(0, 10);
    if (!quiet) setChartLoading(true);
    try {
      const { data } = await marketApi.historical(sym, spec.interval, fromDate, istToday, exch);
      if (timeframeRef.current !== tf) return;          // the user switched while this loaded
      const raw: RawBar[] = (Array.isArray(data) ? data : [])
        .filter((c: any) => c.date ?? c.datetime ?? c.timestamp)
        .map((c: any) => ({
          timestamp: String(c.timestamp ?? c.datetime ?? c.date),
          open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close), volume: num(c.volume),
        }));
      const bars = aggregate(raw, tf, exch);
      lastBarRef.current = bars[bars.length - 1];
      setChartEmpty(bars.length === 0);
      if (seriesRef.current) {
        seriesRef.current.setData(bars as unknown as CandlestickData<Time>[]);
        if (!quiet) chartRef.current?.timeScale().fitContent();
      }
    } catch {
      if (!quiet) setChartEmpty(true);
    } finally {
      if (!quiet) setChartLoading(false);
    }
  }, []);

  const selectSymbol = useCallback(async (sym: string, exchange?: string) => {
    const exch = exchange || selectedExchange || 'NSE';
    setSymbol(sym);
    setSelectedExchange(exch);
    pickedQuery.current = sym;
    setSearchQuery(sym);
    setShowDropdown(false);
    setQuoteLoading(true);
    try {
      const { data } = await marketApi.quote(sym, exch);
      setQuote(data);
    } catch { setQuote(null); } finally { setQuoteLoading(false); }

    void loadChart(sym, exch);
  }, [selectedExchange, loadChart]);

  // Opened from a link such as Market Movers: /terminal?symbol=TCS&exchange=BSE
  const [params, setParams] = useSearchParams();
  const linkedSymbol = useRef(false);
  useEffect(() => {
    const sym = params.get('symbol')?.toUpperCase();
    if (linkedSymbol.current || !sym || !/^[A-Z0-9&_-]{1,30}$/.test(sym)) return;
    linkedSymbol.current = true;
    void selectSymbol(sym, params.get('exchange')?.toUpperCase() || 'NSE');
    setParams({}, { replace: true });
  }, [params, setParams, selectSymbol]);

  // Initialize chart
  useEffect(() => {
    if (!chartContainerRef.current) return;
    const chart = createChart(chartContainerRef.current, {
      layout: { background: { type: ColorType.Solid, color: '#ffffff' }, textColor: '#64748b', fontSize: 11 },
      grid: { vertLines: { color: '#f1f5f9' }, horzLines: { color: '#f1f5f9' } },
      crosshair: {
        vertLine: { color: '#94a3b8', width: 1, style: 3, labelBackgroundColor: '#4f46e5' },
        horzLine: { color: '#94a3b8', width: 1, style: 3, labelBackgroundColor: '#4f46e5' },
      },
      rightPriceScale: { borderColor: '#e2e8f0' },
      timeScale: { borderColor: '#e2e8f0', timeVisible: false },
      width: chartContainerRef.current.clientWidth,
      height: 360,
      // Up/down swipes over the chart scroll the page on phones; sideways ones pan the chart.
      handleScroll: { vertTouchDrag: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e', downColor: '#ef4444', borderUpColor: '#16a34a', borderDownColor: '#dc2626', wickUpColor: '#16a34a', wickDownColor: '#dc2626',
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const handleResize = () => { if (chartContainerRef.current) chart.applyOptions({ width: chartContainerRef.current.clientWidth }); };
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  // Timeframe switch: show times on the axis for intraday, then reload.
  useEffect(() => {
    timeframeRef.current = timeframe;
    try { localStorage.setItem('terminal.timeframe', timeframe); } catch { /* private mode */ }
    chartRef.current?.applyOptions({ timeScale: { timeVisible: isIntraday(timeframe), secondsVisible: false } });
    if (symbol) void loadChart(symbol, selectedExchange || 'NSE');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on timeframe change only; symbol changes load via selectSymbol
  }, [timeframe]);

  // Intraday charts re-sync with the server every minute, so new candles appear without a refresh.
  useEffect(() => {
    if (!symbol || !isIntraday(timeframe)) return;
    const id = setInterval(() => void loadChart(symbol, selectedExchange || 'NSE', true), 60_000);
    return () => clearInterval(id);
  }, [symbol, selectedExchange, timeframe, loadChart]);

  // Between re-syncs, every live price moves the last candle.
  useEffect(() => {
    const ltpNow = num(quote?.ltp ?? quote?.last_price);
    const next = applyTick(lastBarRef.current, ltpNow, Date.now(), timeframeRef.current, selectedExchange || 'NSE');
    if (next && seriesRef.current) {
      seriesRef.current.update(next as unknown as CandlestickData<Time>);
      lastBarRef.current = next;
    }
  }, [quote?.ltp, quote?.last_price, selectedExchange]);

  const handleCancelOrder = async (orderId: string) => {
    try {
      await tradingApi.cancelOrder(orderId);
      setSuccess('Order cancelled');
      await fetchAll();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || 'Cancel failed');
    }
  };

  const pendingOrders = orders.filter((o) => o.status === 'PENDING' || o.status === 'OPEN' || o.status === 'SUBMITTED');
  const ltp = num(quote?.ltp ?? quote?.last_price);
  const change = num(quote?.change);
  const changePct = num(quote?.change_pct ?? quote?.changePercent);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'positions', label: 'Positions', count: positions.length },
    { key: 'orders', label: 'Orders', count: orderTotal },
    { key: 'trades', label: 'Trades', count: tradeTotal },
  ];

  return (
    <div className="space-y-4">
      {/* Alerts */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-600">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span className="flex-1">{success}</span>
          <button onClick={() => setSuccess(null)}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Exchange filter + Symbol search */}
      <div className="space-y-2">
        <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg p-1 shadow-sm">
          {EXCHANGES.map((ex) => (
            <button
              key={ex.value}
              onClick={() => {
                setSearchExchangeFilter(ex.value);
                if (ex.value) setSelectedExchange(ex.value);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
                searchExchangeFilter === ex.value
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
              }`}
            >
              {ex.label}
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder={
              searchExchangeFilter === 'MCX' ? 'Search commodity (e.g. GOLD, SILVER, CRUDEOIL)...' :
              searchExchangeFilter === 'CDS' ? 'Search currency pair (e.g. USDINR, EURINR)...' :
              'Search symbol (e.g. RELIANCE, TCS, GOLD, USDINR)...'
            }
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value.toUpperCase());
              if (e.target.value.length < 1) setShowDropdown(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && searchQuery.trim()) {
                setShowDropdown(false);
                selectSymbol(searchQuery.trim());
              }
            }}
            onFocus={() => { if (searchResults.length > 0) setShowDropdown(true); }}
            className="w-full pl-10 pr-4 py-2.5 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/60 shadow-sm"
          />
          {showDropdown && searchResults.length > 0 && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl z-50 max-h-[320px] overflow-y-auto">
              {searchResults.map((r) => (
                <button
                  key={`${r.symbol}-${r.exchange}`}
                  onClick={() => selectSymbol(r.symbol, r.exchange)}
                  className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-indigo-50 transition text-left"
                >
                  <div>
                    <span className="font-semibold text-sm text-slate-800">{r.symbol}</span>
                    <span className="ml-2 text-xs text-slate-400">{r.name}</span>
                  </div>
                  <ExchangeBadge exchange={r.exchange} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Chart area */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-2 px-4 py-3 border-b border-slate-200">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
              <h2 className="font-semibold text-slate-900">{symbol || 'Select a Symbol'}</h2>
              {symbol && <ExchangeBadge exchange={selectedExchange} />}
              {symbol && ltp > 0 && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 md:ml-3">
                  <span className="text-lg font-bold font-mono text-slate-900">₹{ltp.toFixed(2)}</span>
                  <span className={`text-sm font-mono ${change >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {change >= 0 ? '+' : ''}{change.toFixed(2)} ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
                  </span>
                  {livePrice && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 font-medium">LIVE</span>
                  )}
                  {quote?.timestamp && (
                    <span className="text-[10px] text-slate-400 ml-1">
                      {new Date(quote.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                  )}
                </div>
              )}
              {quoteLoading && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
            </div>
            {/* On phones the timeframes get their own swipeable row below the price. */}
            <div className="order-last basis-full md:order-none md:basis-auto flex items-center gap-1 md:ml-auto md:mr-2 overflow-x-auto touch-pan-x" role="group" aria-label="Chart timeframe">
              {TIMEFRAMES.map((t) => (
                <button key={t.value} onClick={() => setTimeframe(t.value)}
                  className={`shrink-0 px-2.5 py-1.5 md:px-2 md:py-1 rounded-md text-[11px] font-semibold transition-colors ${
                    timeframe === t.value ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-100'
                  }`}>
                  {t.label}
                </button>
              ))}
              {chartLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 ml-1" />}
            </div>
            <button onClick={fetchAll} className="ml-auto md:ml-0 p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors" title="Refresh data">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="relative" style={{ minHeight: 360 }}>
            <div ref={chartContainerRef} className="w-full" style={{ height: 360 }} />
            {symbol && chartEmpty && !chartLoading && (
              <div className="absolute inset-x-0 top-1/3 text-center text-xs text-slate-400 z-10 px-6">
                No {timeframeSpec(timeframe).label} candles for {symbol}.
                {isIntraday(timeframe) && ' Intraday history comes from your broker (Settings → Broker); without one connected, only recent days are available.'}
              </div>
            )}
            {!symbol && (
              <div className="absolute inset-0 flex items-center justify-center bg-white text-slate-400 z-10">
                <div className="text-center">
                  <Search className="w-10 h-10 mx-auto mb-3 text-slate-300" />
                  <p className="text-sm">Search for a symbol above to view the chart</p>
                  <p className="text-xs text-slate-300 mt-1">Search for equities, commodities, or currency pairs</p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Order form (extracted component) */}
        <OrderForm
          symbol={symbol}
          exchange={selectedExchange}
          ltp={ltp}
          portfolioId={portfolioId}
          portfolios={portfolios}
          pendingOrders={pendingOrders}
          onPortfolioChange={setPortfolioId}
          onSuccess={setSuccess}
          onError={setError}
          onRefresh={fetchAll}
        />
      </div>

      {/* Tabbed data panel */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        <div className="flex border-b border-slate-200">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                activeTab === tab.key
                  ? 'text-indigo-600 border-b-2 border-indigo-600 bg-indigo-50/50'
                  : 'text-slate-400 hover:text-slate-600 hover:bg-slate-50'
              }`}
            >
              {tab.label}
              {tab.count > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 text-[10px] font-bold bg-slate-200 text-slate-600 rounded-full">{tab.count}</span>
              )}
            </button>
          ))}
        </div>

        <div className="p-4 min-h-[200px]">
          {isLoading && positions.length === 0 && orders.length === 0 && trades.length === 0 ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
          ) : (
            <>
              {activeTab === 'positions' && (
                <PositionTable positions={positions} posLtpMap={posLtpMap} onSuccess={setSuccess} onError={setError} onRefresh={fetchAll} />
              )}
              {activeTab === 'orders' && (
                <OrderTable
                  orders={orders}
                  onCancelOrder={handleCancelOrder}
                  total={orderTotal}
                  page={orderPage}
                  pageSize={TAB_PAGE_SIZE}
                  onPageChange={(p) => fetchOrders(p)}
                />
              )}
              {activeTab === 'trades' && (
                <TradeTable
                  trades={trades}
                  total={tradeTotal}
                  page={tradePage}
                  pageSize={TAB_PAGE_SIZE}
                  onPageChange={(p) => fetchTrades(p)}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
