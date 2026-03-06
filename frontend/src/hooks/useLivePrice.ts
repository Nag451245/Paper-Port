import { useState, useEffect, useRef, useCallback } from 'react';
import { liveSocket, priceFeed } from '../services/websocket';

interface LivePrice {
  ltp: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: string;
}

export function useLivePrice(symbol: string | null): LivePrice | null {
  const [price, setPrice] = useState<LivePrice | null>(null);

  useEffect(() => {
    if (!symbol) return;

    liveSocket.connect();

    const unsub = priceFeed.subscribe(symbol, (quote) => {
      setPrice({
        ltp: quote.ltp,
        change: quote.change,
        changePercent: quote.changePercent,
        volume: quote.volume,
        timestamp: quote.timestamp,
      });
    });

    return unsub;
  }, [symbol]);

  return price;
}

export function useLivePrices(symbols: string[]): Map<string, LivePrice> {
  const [prices, setPrices] = useState<Map<string, LivePrice>>(new Map());
  const symbolsKey = symbols.join(',');

  useEffect(() => {
    if (symbols.length === 0) return;
    liveSocket.connect();

    const unsubs: (() => void)[] = [];

    for (const sym of symbols) {
      const unsub = priceFeed.subscribe(sym, (quote) => {
        setPrices(prev => {
          const next = new Map(prev);
          next.set(sym, {
            ltp: quote.ltp,
            change: quote.change,
            changePercent: quote.changePercent,
            volume: quote.volume,
            timestamp: quote.timestamp,
          });
          return next;
        });
      });
      unsubs.push(unsub);
    }

    return () => { for (const u of unsubs) u(); };
  }, [symbolsKey]);

  return prices;
}

export function useWebSocketEvent<T = any>(eventType: string): T | null {
  const [data, setData] = useState<T | null>(null);

  useEffect(() => {
    liveSocket.connect();
    const unsub = liveSocket.on(eventType, (msg) => setData(msg as T));
    return unsub;
  }, [eventType]);

  return data;
}
