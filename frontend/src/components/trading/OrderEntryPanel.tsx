import { useState, useMemo } from 'react';
import type { OrderSide, OrderType, OrderCostBreakdown } from '@/types';
import { formatINR } from '@/types';

interface Props {
  symbol?: string;
  ltp?: number;
  onPlaceOrder?: (order: {
    side: OrderSide;
    type: OrderType;
    quantity: number;
    price: number;
    triggerPrice?: number;
    target?: number;
    stopLoss?: number;
  }) => void;
}

const ORDER_TYPES: OrderType[] = ['MARKET', 'LIMIT', 'SL', 'SL-M', 'BRACKET', 'COVER'];

function estimateCosts(price: number, quantity: number): OrderCostBreakdown {
  const turnover = price * quantity;
  const brokerage = Math.min(turnover * 0.0003, 20);
  const stt = turnover * 0.001;
  const exchangeCharges = turnover * 0.0000345;
  const gst = (brokerage + exchangeCharges) * 0.18;
  const sebiCharges = turnover * 0.000001;
  const stampDuty = turnover * 0.00003;
  return {
    brokerage,
    stt,
    exchangeCharges,
    gst,
    sebiCharges,
    stampDuty,
    total: brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty,
  };
}

export default function OrderEntryPanel({ symbol = '', ltp = 0, onPlaceOrder }: Props) {
  const [side, setSide] = useState<OrderSide>('BUY');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [quantity, setQuantity] = useState(1);
  const [price, setPrice] = useState(ltp);
  const [triggerPrice, setTriggerPrice] = useState(0);
  const [target, setTarget] = useState(0);
  const [stopLoss, setStopLoss] = useState(0);

  const isMarket = orderType === 'MARKET';
  const isSL = orderType === 'SL-M' || orderType === 'SL';
  const isBracket = orderType === 'BRACKET';

  const costs = useMemo(
    () => estimateCosts(isMarket ? ltp : price, quantity),
    [isMarket, ltp, price, quantity],
  );

  const handleSubmit = () => {
    onPlaceOrder?.({
      side,
      type: orderType,
      quantity,
      price: isMarket ? ltp : price,
      triggerPrice: isSL || isBracket ? triggerPrice : undefined,
      target: isBracket ? target : undefined,
      stopLoss: isBracket ? stopLoss : undefined,
    });
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-medium text-slate-500">
        {symbol ? `Order — ${symbol}` : 'Place Order'}
      </h3>

      {/* Buy / Sell toggle */}
      <div className="mb-4 flex gap-1 rounded-lg bg-slate-100 p-1">
        <button
          className={`flex-1 rounded-md py-2 text-sm font-semibold transition-colors ${
            side === 'BUY' ? 'bg-emerald-500 text-white' : 'text-slate-500 hover:text-slate-700'
          }`}
          onClick={() => setSide('BUY')}
        >
          BUY
        </button>
        <button
          className={`flex-1 rounded-md py-2 text-sm font-semibold transition-colors ${
            side === 'SELL' ? 'bg-red-500 text-white' : 'text-slate-500 hover:text-slate-700'
          }`}
          onClick={() => setSide('SELL')}
        >
          SELL
        </button>
      </div>

      {/* Order type */}
      <label className="mb-1 block text-xs text-slate-500">Order Type</label>
      <select
        value={orderType}
        onChange={(e) => setOrderType(e.target.value as OrderType)}
        className="mb-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
      >
        {ORDER_TYPES.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>

      {/* Quantity */}
      <label className="mb-1 block text-xs text-slate-500">Quantity</label>
      <input
        type="number"
        min={1}
        value={quantity}
        onChange={(e) => setQuantity(Math.max(1, +e.target.value))}
        className="mb-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
      />

      {/* Price */}
      <label className="mb-1 block text-xs text-slate-500">Price</label>
      <input
        type="number"
        value={isMarket ? ltp : price}
        disabled={isMarket}
        onChange={(e) => setPrice(+e.target.value)}
        className="mb-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500 disabled:opacity-50"
      />

      {/* Trigger Price (for SL orders) */}
      {(isSL || isBracket) && (
        <>
          <label className="mb-1 block text-xs text-slate-500">Trigger Price</label>
          <input
            type="number"
            value={triggerPrice}
            onChange={(e) => setTriggerPrice(+e.target.value)}
            className="mb-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
          />
        </>
      )}

      {/* Bracket order extras */}
      {isBracket && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">Target</label>
            <input
              type="number"
              value={target}
              onChange={(e) => setTarget(+e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">Stop Loss</label>
            <input
              type="number"
              value={stopLoss}
              onChange={(e) => setStopLoss(+e.target.value)}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
            />
          </div>
        </div>
      )}

      {/* Cost breakdown */}
      <div className="mb-4 rounded-lg bg-slate-50 p-3 text-xs">
        <p className="mb-2 font-medium text-slate-500">Estimated Charges</p>
        <div className="space-y-1 text-slate-400">
          <Row label="Brokerage" value={costs.brokerage} />
          <Row label="STT" value={costs.stt} />
          <Row label="Exchange" value={costs.exchangeCharges} />
          <Row label="GST" value={costs.gst} />
          <Row label="SEBI" value={costs.sebiCharges} />
          <Row label="Stamp Duty" value={costs.stampDuty} />
          <div className="border-t border-slate-200 pt-1 text-slate-700">
            <Row label="Total" value={costs.total} />
          </div>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        className={`w-full rounded-lg py-2.5 text-sm font-semibold text-white transition-colors ${
          side === 'BUY'
            ? 'bg-emerald-600 hover:bg-emerald-500'
            : 'bg-red-600 hover:bg-red-500'
        }`}
      >
        Place {side} Order
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between">
      <span>{label}</span>
      <span>{formatINR(value)}</span>
    </div>
  );
}
