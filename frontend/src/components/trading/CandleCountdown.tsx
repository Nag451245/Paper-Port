import { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';

const OPEN = 9 * 60 + 15, CLOSE = 15 * 60 + 30;

/** Seconds until the current `minutes`-long candle closes (candles start at 09:15 IST), or null outside market hours. */
function secondsToCandleClose(minutes: number, now = Date.now()): number | null {
  const ist = new Date(now + 330 * 60_000);
  const day = ist.getUTCDay();
  const sec = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
  if (day === 0 || day === 6 || sec < OPEN * 60 || sec >= CLOSE * 60) return null;
  const size = minutes * 60;
  const end = Math.min(CLOSE * 60, OPEN * 60 + (Math.floor((sec - OPEN * 60) / size) + 1) * size);
  return end - sec;
}

/** "5m candle closes in 02:13" for intraday charts, while the market is open. */
export default function CandleCountdown({ minutes }: { minutes: number }) {
  const [left, setLeft] = useState(() => secondsToCandleClose(minutes));
  useEffect(() => {
    const id = setInterval(() => setLeft(secondsToCandleClose(minutes)), 1000);
    return () => clearInterval(id);
  }, [minutes]);
  if (left == null) return null;
  return (
    <span className="shrink-0 flex items-center gap-1 text-[10px] text-slate-500 ml-1" title="Time left in the current candle">
      <Timer className="w-3 h-3" />
      <span className="font-mono">{String(Math.floor(left / 60)).padStart(2, '0')}:{String(left % 60).padStart(2, '0')}</span>
    </span>
  );
}
