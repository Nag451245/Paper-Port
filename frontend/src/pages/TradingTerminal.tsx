import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search,
  ArrowUpCircle,
  ArrowDownCircle,
  ChevronDown,
  X,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import { portfolioApi, tradingApi, marketApi } from '@/services/api';
import { fireProfitConfetti } from '@/hooks/useTradeAnimation';
import { createChart, ColorType, CandlestickSeries, type IChartApi, type ISeriesApi, type CandlestickData, type Time } from 'lightweight-charts';

type OrderSide = 'BUY' | 'SELL';
type OrderType = 'MARKET' | 'LIMIT';
type Tab = 'positions' | 'orders' | 'trades';

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(v: any): number {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v) || 0 : Number(v);
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

interface SearchResult {
  symbol: string;
  name: string;
  exchange: string;
  segment?: string;
}

const EXCHANGES = [
  { value: '', label: 'All Markets' },
  { value: 'NSE', label: 'NSE', color: 'text-blue-600 bg-blue-50' },
  { value: 'BSE', label: 'BSE', color: 'text-violet-600 bg-violet-50' },
  { value: 'MCX', label: 'MCX', color: 'text-amber-600 bg-amber-50' },
  { value: 'CDS', label: 'Forex', color: 'text-teal-600 bg-teal-50' },
] as const;

function exchangeBadgeColor(exchange: string): string {
  switch (exchange) {
    case 'MCX': return 'text-amber-700 bg-amber-50 border-amber-200';
    case 'CDS': return 'text-teal-700 bg-teal-50 border-teal-200';
    case 'BSE': return 'text-violet-700 bg-violet-50 border-violet-200';
    default: return 'text-blue-700 bg-blue-50 border-blue-200';
  }
}

export default function TradingTerminal() {
  const [symbol, setSymbol] = useState('');
  const [selectedExchange, setSelectedExchange] = useState('NSE');
  const [searchExchangeFilter, setSearchExchangeFilter] = useState('');
  const [orderSide, setOrderSide] = useState<OrderSide>('BUY');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');

  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const [portfolios, setPortfolios] = useState<any[]>([]);
  const [orders, setOrders] = useState<any[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<Tab>('positions');

  const [isLoading, setIsLoading] = useState(true);
  const [isPlacing, setIsPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [quote, setQuote] = useState<any>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [posLtpMap, setPosLtpMap] = useState<Record<string, number>>({});

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    const errors: string[] = [];
    try {
      const [pRes, oRes, posRes, tRes] = await Promise.all([
        portfolioApi.list().catch((e) => { errors.push('Portfolio: ' + (e?.response?.data?.error ?? e.message)); return { data: [] }; }),
        tradingApi.listOrders().catch((e) => { errors.push('Orders: ' + (e?.response?.data?.error ?? e.message)); return { data: [] }; }),
        tradingApi.positions().catch((e) => { errors.push('Positions: ' + (e?.response?.data?.error ?? e.message)); return { data: [] }; }),
        tradingApi.listTrades().catch((e) => { errors.push('Trades: ' + (e?.response?.data?.error ?? e.message)); return { data: [] }; }),
      ]);

      const pList = Array.isArray(pRes.data) ? pRes.data : [];
      setPortfolios(pList);
      if (pList.length > 0) {
        setPortfolioId((prev) => prev ?? pList[0].id);
      }

      const oData = oRes.data;
      setOrders(Array.isArray(oData) ? oData : (oData as any)?.orders ?? []);
      setPositions(Array.isArray(posRes.data) ? posRes.data : []);
      const tData = tRes.data;
      setTrades(Array.isArray(tData) ? tData : (tData as any)?.trades ?? []);

      if (errors.length > 0) {
        setError('Some data failed to load: ' + errors.join('; '));
      }
    } catch (e: any) {
      setError('Failed to load trading data: ' + (e?.message ?? 'Unknown error'));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!success && !error) return;
    const t = setTimeout(() => { setSuccess(null); setError(null); }, 5000);
    return () => clearTimeout(t);
  }, [success, error]);

  useEffect(() => {
    if (positions.length === 0) return;
    const posEntries = positions.map((p: any) => ({ sym: p.symbol as string, exch: (p.exchange ?? 'NSE') as string }));
    const unique = [...new Map(posEntries.map(e => [e.sym, e])).values()];
    const fetchPositionPrices = () => {
      unique.forEach(({ sym, exch }) => {
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
  }, [positions]);

  useEffect(() => {
    if (!symbol) return;
    const poll = () => {
      marketApi.quote(symbol, selectedExchange)
        .then(({ data }) => setQuote(data))
        .catch(() => {});
    };
    const interval = setInterval(poll, 10_000);
    return () => clearInterval(interval);
  }, [symbol, selectedExchange]);

  // Symbol search with debounce
  useEffect(() => {
    if (searchTimeout.current) clearTimeout(searchTimeout.current);
    if (searchQuery.length < 1) {
      setSearchResults([]);
      setShowDropdown(false);
      return;
    }
    searchTimeout.current = setTimeout(async () => {
      try {
        const { data } = await marketApi.search(searchQuery, searchExchangeFilter || undefined);
        const results = Array.isArray(data) ? data : [];
        setSearchResults(results.slice(0, 10));
        setShowDropdown(results.length > 0);
      } catch {
        setSearchResults([]);
      }
    }, 300);
    return () => { if (searchTimeout.current) clearTimeout(searchTimeout.current); };
  }, [searchQuery, searchExchangeFilter]);

  const selectSymbol = useCallback(async (sym: string, exchange?: string) => {
    const exch = exchange || selectedExchange || 'NSE';
    setSymbol(sym);
    setSelectedExchange(exch);
    setSearchQuery(sym);
    setShowDropdown(false);
    setQuoteLoading(true);
    try {
      const { data } = await marketApi.quote(sym, exch);
      setQuote(data);
    } catch {
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }

    const to = new Date().toISOString().slice(0, 10);
    const fromDate = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    try {
      const { data } = await marketApi.historical(sym, '1d', fromDate, to, exch);
      const candles = Array.isArray(data) ? data : [];
      if (candles.length > 0 && seriesRef.current) {
        const chartData: CandlestickData<Time>[] = candles
          .filter((c: any) => (c.date ?? c.datetime ?? c.timestamp))
          .map((c: any) => ({
            time: (c.date ?? c.datetime ?? c.timestamp ?? '').slice(0, 10) as Time,
            open: num(c.open),
            high: num(c.high),
            low: num(c.low),
            close: num(c.close),
          }))
          .sort((a: CandlestickData<Time>, b: CandlestickData<Time>) => 
            (a.time as string).localeCompare(b.time as string)
          );
        seriesRef.current.setData(chartData);
        chartRef.current?.timeScale().fitContent();
      } else if (seriesRef.current) {
        seriesRef.current.setData([]);
      }
    } catch {
      // chart data unavailable
    }
  }, [selectedExchange]);

  // Initialize lightweight-charts
  useEffect(() => {
    if (!chartContainerRef.current) return;

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#64748b',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: '#f1f5f9' },
        horzLines: { color: '#f1f5f9' },
      },
      crosshair: {
        vertLine: { color: '#94a3b8', width: 1, style: 3, labelBackgroundColor: '#4f46e5' },
        horzLine: { color: '#94a3b8', width: 1, style: 3, labelBackgroundColor: '#4f46e5' },
      },
      rightPriceScale: { borderColor: '#e2e8f0' },
      timeScale: { borderColor: '#e2e8f0', timeVisible: false },
      width: chartContainerRef.current.clientWidth,
      height: 360,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#16a34a',
      borderDownColor: '#dc2626',
      wickUpColor: '#16a34a',
      wickDownColor: '#dc2626',
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!portfolioId) {
      setError('No portfolio found. Create one in Settings first.');
      return;
    }
    const sym = symbol.trim().toUpperCase();
    if (!sym) {
      setError('Enter a symbol');
      return;
    }
    const qty = parseInt(quantity, 10);
    if (!qty || qty <= 0) {
      setError('Enter a valid quantity');
      return;
    }
    if (orderType === 'LIMIT') {
      const p = parseFloat(price);
      if (!p || p <= 0) {
        setError('Enter a valid price for limit order');
        return;
      }
    }

    setIsPlacing(true);
    try {
      const result = await tradingApi.placeOrder({
        portfolio_id: portfolioId,
        symbol: sym,
        side: orderSide,
        order_type: orderType,
        qty,
        price: orderType === 'LIMIT' ? parseFloat(price) : undefined,
        instrument_token: `${sym}-${selectedExchange}`,
        exchange: selectedExchange,
      });
      if (result?._pendingReason || result?.status === 'PENDING') {
        setSuccess(`${orderSide} order queued as PENDING: ${qty} × ${sym}. Will execute when market opens and price matches.`);
      } else {
        setSuccess(`${orderSide} order placed: ${qty} × ${sym}`);
        if (orderSide === 'SELL') fireProfitConfetti();
      }
      setQuantity('');
      setPrice('');
      await fetchAll();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || err?.message || 'Failed to place order');
    } finally {
      setIsPlacing(false);
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    try {
      await tradingApi.cancelOrder(orderId);
      setSuccess('Order cancelled');
      await fetchAll();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || 'Cancel failed');
    }
  };

  const pendingOrders = orders.filter((o) => o.status === 'PENDING' || o.status === 'OPEN');
  const ltp = num(quote?.ltp ?? quote?.last_price);
  const change = num(quote?.change);
  const changePct = num(quote?.change_pct ?? quote?.changePercent);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'positions', label: 'Positions', count: positions.length },
    { key: 'orders', label: 'Orders', count: orders.length },
    { key: 'trades', label: 'Trades', count: trades.length },
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
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${exchangeBadgeColor(r.exchange)}`}>
                    {r.exchange === 'CDS' ? 'FOREX' : r.exchange}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Chart area */}
        <div className="lg:col-span-2 bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold text-slate-900">{symbol || 'Select a Symbol'}</h2>
              {symbol && (
                <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${exchangeBadgeColor(selectedExchange)}`}>
                  {selectedExchange === 'CDS' ? 'FOREX' : selectedExchange}
                </span>
              )}
              {symbol && ltp > 0 && (
                <div className="flex items-center gap-2 ml-3">
                  <span className="text-lg font-bold font-mono text-slate-900">₹{ltp.toFixed(2)}</span>
                  <span className={`text-sm font-mono ${change >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {change >= 0 ? '+' : ''}{change.toFixed(2)} ({changePct >= 0 ? '+' : ''}{changePct.toFixed(2)}%)
                  </span>
                  {quote?.timestamp && (
                    <span className="text-[10px] text-slate-400 ml-1">
                      {new Date(quote.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })}
                    </span>
                  )}
                </div>
              )}
              {quoteLoading && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
            </div>
            <button
              onClick={fetchAll}
              className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors"
              title="Refresh data"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="relative" style={{ minHeight: 360 }}>
            <div ref={chartContainerRef} className="w-full" style={{ height: 360 }} />
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

        {/* Order form */}
        <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Place Order</h3>
            {portfolios.length > 1 && (
              <select
                value={portfolioId ?? ''}
                onChange={(e) => setPortfolioId(e.target.value)}
                className="text-xs px-2 py-1 bg-slate-50 border border-slate-200 rounded text-slate-600"
              >
                {portfolios.map((p: any) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Current price display */}
          {symbol && ltp > 0 && (
            <div className="mb-4 p-3 bg-slate-50 rounded-lg">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">Current Price</span>
                <span className="text-sm font-bold font-mono text-slate-800">₹{selectedExchange === 'CDS' ? ltp.toFixed(4) : ltp.toFixed(2)}</span>
              </div>
              {quantity && parseInt(quantity) > 0 && (
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-slate-500">Est. Value</span>
                  <span className="text-xs font-mono text-slate-600">
                    ₹{(ltp * parseInt(quantity)).toLocaleString('en-IN', { maximumFractionDigits: selectedExchange === 'CDS' ? 4 : 0 })}
                  </span>
                </div>
              )}
              {selectedExchange !== 'NSE' && selectedExchange !== 'BSE' && (
                <div className="flex items-center justify-between mt-1">
                  <span className="text-xs text-slate-500">Market</span>
                  <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${exchangeBadgeColor(selectedExchange)}`}>
                    {selectedExchange === 'MCX' ? 'Commodity' : 'Currency'}
                  </span>
                </div>
              )}
            </div>
          )}

          <form onSubmit={handlePlaceOrder} className="space-y-4">
            <div className="grid grid-cols-2 gap-1 bg-slate-100 rounded-lg p-1">
              <button
                type="button"
                onClick={() => setOrderSide('BUY')}
                className={`py-2 text-sm font-semibold rounded-md transition-all ${
                  orderSide === 'BUY'
                    ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <ArrowUpCircle className="w-4 h-4 inline mr-1.5" />BUY
              </button>
              <button
                type="button"
                onClick={() => setOrderSide('SELL')}
                className={`py-2 text-sm font-semibold rounded-md transition-all ${
                  orderSide === 'SELL'
                    ? 'bg-red-600 text-white shadow-lg shadow-red-500/20'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <ArrowDownCircle className="w-4 h-4 inline mr-1.5" />SELL
              </button>
            </div>

            <div>
              <label className="text-xs text-slate-500 mb-1 block">Order Type</label>
              <div className="relative">
                <select
                  value={orderType}
                  onChange={(e) => setOrderType(e.target.value as OrderType)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 appearance-none focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                >
                  <option value="MARKET">Market</option>
                  <option value="LIMIT">Limit</option>
                </select>
                <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
              </div>
            </div>

            <div>
              <label className="text-xs text-slate-500 mb-1 block">Quantity</label>
              <input
                type="number"
                min="1"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="Enter quantity"
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
            </div>

            {orderType === 'LIMIT' && (
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Price</label>
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
            )}

            <button
              type="submit"
              disabled={isPlacing || !symbol.trim()}
              className={`w-full py-2.5 rounded-lg text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                orderSide === 'BUY'
                  ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20'
                  : 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20'
              }`}
            >
              {isPlacing && <Loader2 className="w-4 h-4 inline animate-spin mr-1.5" />}
              {isPlacing ? 'Placing...' : `${orderSide} ${symbol || 'SYMBOL'}`}
            </button>
          </form>

          {pendingOrders.length > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-200">
              <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">
                Pending ({pendingOrders.length})
              </h4>
              <div className="space-y-1.5 max-h-36 overflow-y-auto">
                {pendingOrders.map((o: any) => (
                  <div key={o.id} className="flex items-center justify-between text-xs px-2 py-1.5 bg-slate-50 rounded">
                    <div className="flex items-center gap-2">
                      <span className={`font-bold ${o.side === 'BUY' ? 'text-emerald-600' : 'text-red-600'}`}>{o.side}</span>
                      <span className="text-slate-700">{o.symbol}</span>
                      <span className="text-slate-400">×{o.qty}</span>
                    </div>
                    <button onClick={() => handleCancelOrder(o.id)} className="text-red-500 hover:text-red-600" title="Cancel">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
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
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
            </div>
          ) : (
            <>
              {activeTab === 'positions' && (
                <div className="overflow-x-auto">
                  {positions.length === 0 ? (
                    <p className="text-center text-slate-400 text-sm py-8">No open positions</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-200">
                          <th className="text-left pb-2 font-medium">Symbol</th>
                          <th className="text-center pb-2 font-medium">Side</th>
                          <th className="text-right pb-2 font-medium">Qty</th>
                          <th className="text-right pb-2 font-medium">Avg Price</th>
                          <th className="text-right pb-2 font-medium">LTP</th>
                          <th className="text-right pb-2 font-medium">Unrealized P&L</th>
                          <th className="text-right pb-2 font-medium">Realized P&L</th>
                          <th className="text-right pb-2 font-medium hidden sm:table-cell">Opened</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positions.map((pos: any) => {
                          const avgPrice = num(pos.avgEntryPrice ?? pos.avg_entry_price);
                          const qty = num(pos.qty);
                          const liveLtp = posLtpMap[pos.symbol] || 0;
                          const uPnl = liveLtp > 0 && avgPrice > 0
                            ? (liveLtp - avgPrice) * qty * (pos.side === 'SHORT' ? -1 : 1)
                            : num(pos.unrealizedPnl ?? pos.unrealized_pnl);
                          const rPnl = num(pos.realizedPnl ?? pos.realized_pnl);
                          return (
                            <tr key={pos.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                              <td className="py-2.5 text-slate-800 font-medium">
                                {pos.symbol}<span className="text-slate-400 ml-1 text-[10px]">{pos.exchange}</span>
                              </td>
                              <td className="py-2.5 text-center">
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${pos.side === 'LONG' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>{pos.side}</span>
                              </td>
                              <td className="py-2.5 text-right font-mono text-slate-600">{qty}</td>
                              <td className="py-2.5 text-right font-mono text-slate-600">₹{avgPrice.toFixed(2)}</td>
                              <td className="py-2.5 text-right font-mono text-slate-600">
                                {liveLtp > 0 ? `₹${liveLtp.toFixed(2)}` : '...'}
                              </td>
                              <td className={`py-2.5 text-right font-mono ${uPnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                {uPnl >= 0 ? '+' : ''}₹{uPnl.toFixed(2)}
                              </td>
                              <td className={`py-2.5 text-right font-mono ${rPnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                {rPnl >= 0 ? '+' : ''}₹{rPnl.toFixed(2)}
                              </td>
                              <td className="py-2.5 text-right text-slate-400 hidden sm:table-cell">{fmtTime(pos.openedAt ?? pos.opened_at)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === 'orders' && (
                <div className="overflow-x-auto">
                  {orders.length === 0 ? (
                    <p className="text-center text-slate-400 text-sm py-8">No orders yet</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-200">
                          <th className="text-left pb-2 font-medium">Time</th>
                          <th className="text-left pb-2 font-medium">Symbol</th>
                          <th className="text-center pb-2 font-medium">Side</th>
                          <th className="text-center pb-2 font-medium">Type</th>
                          <th className="text-right pb-2 font-medium">Qty</th>
                          <th className="text-right pb-2 font-medium">Price</th>
                          <th className="text-center pb-2 font-medium">Status</th>
                          <th className="text-center pb-2 font-medium">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map((order: any) => (
                          <tr key={order.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                            <td className="py-2.5 text-slate-400 whitespace-nowrap">{fmtTime(order.createdAt ?? order.created_at)}</td>
                            <td className="py-2.5 text-slate-800 font-medium">{order.symbol}</td>
                            <td className="py-2.5 text-center">
                              <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${order.side === 'BUY' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>{order.side}</span>
                            </td>
                            <td className="py-2.5 text-center text-slate-500">{order.orderType ?? order.order_type}</td>
                            <td className="py-2.5 text-right font-mono text-slate-600">{order.filledQty ?? order.filled_qty}/{order.qty}</td>
                            <td className="py-2.5 text-right font-mono text-slate-600">{order.price ? `₹${num(order.price).toFixed(2)}` : 'MKT'}</td>
                            <td className="py-2.5 text-center"><OrderStatusBadge status={order.status} /></td>
                            <td className="py-2.5 text-center">
                              {order.status === 'PENDING' && (
                                <button onClick={() => handleCancelOrder(order.id)} className="text-red-500 hover:text-red-600" title="Cancel order">
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}

              {activeTab === 'trades' && (
                <div className="overflow-x-auto">
                  {trades.length === 0 ? (
                    <p className="text-center text-slate-400 text-sm py-8">No completed trades yet</p>
                  ) : (
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-200">
                          <th className="text-left pb-2 font-medium">Symbol</th>
                          <th className="text-center pb-2 font-medium">Side</th>
                          <th className="text-right pb-2 font-medium">Qty</th>
                          <th className="text-right pb-2 font-medium">Entry</th>
                          <th className="text-right pb-2 font-medium">Exit</th>
                          <th className="text-right pb-2 font-medium">Net P&L</th>
                          <th className="text-right pb-2 font-medium hidden sm:table-cell">Duration</th>
                          <th className="text-right pb-2 font-medium hidden sm:table-cell">Closed</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trades.map((trade: any) => {
                          const netPnl = num(trade.netPnl ?? trade.net_pnl);
                          return (
                            <tr key={trade.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                              <td className="py-2.5 text-slate-800 font-medium">
                                {trade.symbol}<span className="text-slate-400 ml-1 text-[10px]">{trade.exchange}</span>
                              </td>
                              <td className="py-2.5 text-center">
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${trade.side === 'BUY' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>{trade.side}</span>
                              </td>
                              <td className="py-2.5 text-right font-mono text-slate-600">{trade.qty}</td>
                              <td className="py-2.5 text-right font-mono text-slate-600">₹{num(trade.entryPrice ?? trade.entry_price).toFixed(2)}</td>
                              <td className="py-2.5 text-right font-mono text-slate-600">₹{num(trade.exitPrice ?? trade.exit_price).toFixed(2)}</td>
                              <td className={`py-2.5 text-right font-mono font-semibold ${netPnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                {netPnl >= 0 ? '+' : ''}₹{netPnl.toFixed(2)}
                              </td>
                              <td className="py-2.5 text-right text-slate-400 hidden sm:table-cell">{trade.holdDuration ?? trade.hold_duration ?? '—'}</td>
                              <td className="py-2.5 text-right text-slate-400 hidden sm:table-cell">{fmtTime(trade.exitTime ?? trade.exit_time)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function OrderStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    FILLED: 'bg-emerald-50 text-emerald-600',
    PENDING: 'bg-amber-50 text-amber-600',
    PARTIALLY_FILLED: 'bg-blue-50 text-blue-600',
    CANCELLED: 'bg-slate-100 text-slate-500',
    REJECTED: 'bg-red-50 text-red-600',
  };
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${styles[status] ?? 'bg-slate-100 text-slate-500'}`}>
      {status}
    </span>
  );
}
