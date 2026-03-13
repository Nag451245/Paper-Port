import { useState, useEffect, useRef, useCallback } from 'react';
import { liveSocket, priceFeed } from '../services/websocket';

const STALE_THRESHOLD_MS = 30_000;

interface LivePrice {
  ltp: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: string;
  isStale?: boolean;
}

export function useLivePrice(symbol: string | null): LivePrice | null {
  const [price, setPrice] = useState<LivePrice | null>(null);
  const lastUpdateRef = useRef<number>(0);
  const staleTimerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const checkStale = useCallback(() => {
    if (lastUpdateRef.current > 0 && Date.now() - lastUpdateRef.current > STALE_THRESHOLD_MS) {
      setPrice(prev => prev ? { ...prev, isStale: true } : prev);
    }
  }, []);

  useEffect(() => {
    if (!symbol) return;

    liveSocket.connect();

    const unsub = priceFeed.subscribe(symbol, (quote) => {
      lastUpdateRef.current = Date.now();
      setPrice({
        ltp: quote.ltp,
        change: quote.change,
        changePercent: quote.changePercent,
        volume: quote.volume,
        timestamp: quote.timestamp,
        isStale: false,
      });
    });

    staleTimerRef.current = setInterval(checkStale, 10_000);

    return () => {
      unsub();
      if (staleTimerRef.current) clearInterval(staleTimerRef.current);
    };
  }, [symbol, checkStale]);

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
