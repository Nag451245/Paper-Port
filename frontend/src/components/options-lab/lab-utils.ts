import { useEffect, useRef, useState } from 'react';
import { optionsLabApi, type FnoRates, type LabJob } from '@/services/api';

export const LAB_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];

export const inr = (n: number | null | undefined, digits = 0) =>
  n == null ? '—' : `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: digits })}`;
export const tone = (n: number | null | undefined) => (n == null ? 'text-slate-500' : n >= 0 ? 'text-emerald-600' : 'text-red-600');
/** Epoch seconds → IST "03 Oct 09:20". */
export const istTime = (t: number, withDate = true) => new Date(t * 1000).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', ...(withDate ? { day: '2-digit', month: 'short' } : {}), hour: '2-digit', minute: '2-digit', hour12: false,
});
export const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const shiftDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const errorText = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? (err as Error)?.message ?? fallback;

/** Charges for one option order at the rates of the day (same formula as the server). */
export function orderCharges(r: FnoRates, side: 'BUY' | 'SELL', price: number, qty: number): number {
  const turnover = Math.max(0, price) * Math.abs(qty);
  const exchange = turnover * r.exchangeOption, sebi = turnover * r.sebi;
  const stt = side === 'SELL' ? turnover * r.sttOptionSell : 0;
  const stamp = side === 'BUY' ? turnover * r.stampOptionBuy : 0;
  return r.brokeragePerOrder + stt + exchange + sebi + stamp + (r.brokeragePerOrder + exchange + sebi) * r.gst;
}

/** Start a server job and poll it until it finishes. */
export function useLabJob() {
  const [job, setJob] = useState<LabJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const poll = (id: string) => {
    timer.current = setTimeout(async () => {
      try {
        const { data } = await optionsLabApi.job(id);
        setJob(data);
        if (data.state === 'running') poll(id);
        else if (data.state === 'failed') setError(data.error ?? 'It did not work.');
        else onDone.current?.(data.result);
      } catch (err) {
        setError(errorText(err, 'Lost track of the job.'));
      }
    }, 1500);
  };

  const onDone = useRef<((result: unknown) => void) | null>(null);
  /** Start a job; `done` receives its result (called from the poll, not from a render or effect). */
  const start = async (kick: () => Promise<{ data: { jobId: string } }>, done?: (result: unknown) => void) => {
    onDone.current = done ?? null;
    setError(null);
    setJob(null);
    try {
      const { data } = await kick();
      setJob({ id: data.jobId, kind: 'backtest', state: 'running', progress: { done: 0, total: 0, message: 'Starting…' } });
      poll(data.jobId);
    } catch (err) {
      setError(errorText(err, 'Could not start.'));
    }
  };

  return { job, error, start, running: job?.state === 'running', setError };
}
