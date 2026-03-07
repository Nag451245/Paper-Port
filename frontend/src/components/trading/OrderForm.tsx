import { useState } from 'react';
import { ArrowUpCircle, ArrowDownCircle, ChevronDown, Loader2, X } from 'lucide-react';
import { tradingApi } from '@/services/api';
import { fireProfitConfetti } from '@/hooks/useTradeAnimation';
import { ExchangeBadge } from './StatusBadge';

/* eslint-disable @typescript-eslint/no-explicit-any */

type OrderSide = 'BUY' | 'SELL';
type OrderType = 'MARKET' | 'LIMIT';

function num(v: any): number {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v) || 0 : Number(v);
}

interface PendingOrder {
  id: string;
  side: string;
  symbol: string;
  qty: number;
  status: string;
}

interface OrderFormProps {
  symbol: string;
  exchange: string;
  ltp: number;
  portfolioId: string | null;
  portfolios: { id: string; name: string }[];
  pendingOrders: PendingOrder[];
  onPortfolioChange: (id: string) => void;
  onSuccess: (message: string) => void;
  onError: (message: string) => void;
  onRefresh: () => void;
}

export default function OrderForm({
  symbol,
  exchange,
  ltp,
  portfolioId,
  portfolios,
  pendingOrders,
  onPortfolioChange,
  onSuccess,
  onError,
  onRefresh,
}: OrderFormProps) {
  const [orderSide, setOrderSide] = useState<OrderSide>('BUY');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [isPlacing, setIsPlacing] = useState(false);

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!portfolioId) { onError('No portfolio found. Create one in Settings first.'); return; }
    const sym = symbol.trim().toUpperCase();
    if (!sym) { onError('Enter a symbol'); return; }
    const qty = parseInt(quantity, 10);
    if (!qty || qty <= 0) { onError('Enter a valid quantity'); return; }
    if (orderType === 'LIMIT') {
      const p = parseFloat(price);
      if (!p || p <= 0) { onError('Enter a valid price for limit order'); return; }
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
        instrument_token: `${sym}-${exchange}`,
        exchange,
      });
      const order = (result as any)?.data;
      if (order?._pendingReason || order?.status === 'PENDING') {
        onSuccess(`${orderSide} order queued as PENDING: ${qty} × ${sym}. Will execute when market opens and price matches.`);
      } else {
        onSuccess(`${orderSide} order placed: ${qty} × ${sym}`);
        if (orderSide === 'SELL') fireProfitConfetti();
      }
      setQuantity('');
      setPrice('');
      onRefresh();
    } catch (err: any) {
      onError(err?.response?.data?.error || err?.response?.data?.detail || err?.message || 'Failed to place order');
    } finally {
      setIsPlacing(false);
    }
  };

  const handleCancel = async (orderId: string) => {
    try {
      await tradingApi.cancelOrder(orderId);
      onSuccess('Order cancelled');
      onRefresh();
    } catch (err: any) {
      onError(err?.response?.data?.error || err?.response?.data?.detail || 'Cancel failed');
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Place Order</h3>
        {portfolios.length > 1 && (
          <select
            value={portfolioId ?? ''}
            onChange={(e) => onPortfolioChange(e.target.value)}
            className="text-xs px-2 py-1 bg-slate-50 border border-slate-200 rounded text-slate-600"
          >
            {portfolios.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        )}
      </div>

      {symbol && ltp > 0 && (
        <div className="mb-4 p-3 bg-slate-50 rounded-lg">
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">Current Price</span>
            <span className="text-sm font-bold font-mono text-slate-800">₹{exchange === 'CDS' ? ltp.toFixed(4) : ltp.toFixed(2)}</span>
          </div>
          {quantity && parseInt(quantity) > 0 && (
            <div className="flex items-center justify-between mt-1">
              <span className="text-xs text-slate-500">Est. Value</span>
              <span className="text-xs font-mono text-slate-600">
                ₹{(ltp * parseInt(quantity)).toLocaleString('en-IN', { maximumFractionDigits: exchange === 'CDS' ? 4 : 0 })}
              </span>
            </div>
          )}
          {exchange !== 'NSE' && exchange !== 'BSE' && (
            <div className="flex items-center justify-between mt-1">
              <span className="text-xs text-slate-500">Market</span>
              <ExchangeBadge exchange={exchange} />
            </div>
          )}
        </div>
      )}

      <form onSubmit={handlePlaceOrder} className="space-y-4">
        <div className="grid grid-cols-2 gap-1 bg-slate-100 rounded-lg p-1">
          <button
            type="button"
            onClick={() => setOrderSide('BUY')}
            className={`py-2 text-sm font-semibold rounded-md transition-all ${orderSide === 'BUY' ? 'bg-emerald-600 text-white shadow-lg shadow-emerald-500/20' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <ArrowUpCircle className="w-4 h-4 inline mr-1.5" />BUY
          </button>
          <button
            type="button"
            onClick={() => setOrderSide('SELL')}
            className={`py-2 text-sm font-semibold rounded-md transition-all ${orderSide === 'SELL' ? 'bg-red-600 text-white shadow-lg shadow-red-500/20' : 'text-slate-500 hover:text-slate-700'}`}
          >
            <ArrowDownCircle className="w-4 h-4 inline mr-1.5" />SELL
          </button>
        </div>

        <div>
          <label className="text-xs text-slate-500 mb-1 block">Order Type</label>
          <div className="relative">
            <select value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)} className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 appearance-none focus:outline-none focus:ring-2 focus:ring-indigo-500/40">
              <option value="MARKET">Market</option>
              <option value="LIMIT">Limit</option>
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          </div>
        </div>

        <div>
          <label className="text-xs text-slate-500 mb-1 block">Quantity</label>
          <input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="Enter quantity" className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40" />
        </div>

        {orderType === 'LIMIT' && (
          <div>
            <label className="text-xs text-slate-500 mb-1 block">Price</label>
            <input type="number" step="0.05" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40" />
          </div>
        )}

        <button
          type="submit"
          disabled={isPlacing || !symbol.trim()}
          className={`w-full py-2.5 rounded-lg text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed ${orderSide === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20' : 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20'}`}
        >
          {isPlacing && <Loader2 className="w-4 h-4 inline animate-spin mr-1.5" />}
          {isPlacing ? 'Placing...' : `${orderSide} ${symbol || 'SYMBOL'}`}
        </button>
      </form>

      {pendingOrders.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-200">
          <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">Pending ({pendingOrders.length})</h4>
          <div className="space-y-1.5 max-h-36 overflow-y-auto">
            {pendingOrders.map((o) => (
              <div key={o.id} className="flex items-center justify-between text-xs px-2 py-1.5 bg-slate-50 rounded">
                <div className="flex items-center gap-2">
                  <span className={`font-bold ${o.side === 'BUY' ? 'text-emerald-600' : 'text-red-600'}`}>{o.side}</span>
                  <span className="text-slate-700">{o.symbol}</span>
                  <span className="text-slate-400">×{o.qty}</span>
                </div>
                <button onClick={() => handleCancel(o.id)} className="text-red-500 hover:text-red-600" title="Cancel">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
