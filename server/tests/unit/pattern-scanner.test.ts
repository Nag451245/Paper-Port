import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PatternScanner } from '../../src/services/pattern-scanner.service.js';
import { writeDaily, writeIntraday } from '../../src/lib/candle-lake.js';

const hhmm = (k: number) => { const m = 9 * 60 + 15 + 5 * k; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`; };
/** A session; `breakout` makes the 10:10 candle close above the opening range. */
const session = (day: string, breakout = false) => Array.from({ length: 75 }, (_, k) => {
  const c = breakout && k >= 11 ? 105 : 100;
  return { timestamp: `${day} ${hhmm(k)}`, open: 100, high: Math.max(c, 100.5), low: 99.5, close: c, volume: 1000 };
});
const weekdaysBefore = (day: string, n: number) => {
  const out: string[] = [];
  for (let t = Date.parse(`${day}T00:00:00Z`) - 86_400_000; out.length < n; t -= 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() % 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
};

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-')); process.env.MARKET_DATA_DIR = dir; });
afterEach(() => { delete process.env.MARKET_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

describe('PatternScanner', () => {
  const now = new Date('2026-10-05T04:46:00Z');                  // 10:16 IST
  const promote = (patterns: object[]) => fs.writeFileSync(path.join(dir, 'patterns.json'), JSON.stringify({ promoted: patterns }));

  function setup() {
    for (const s of ['TCS', 'INFY']) {
      writeIntraday(s, weekdaysBefore('2026-10-05', 12).flatMap((d) => session(d)));
      writeDaily(s, weekdaysBefore('2026-10-05', 70).map((d) => ({ timestamp: d, open: 100, high: 101, low: 99, close: 100, volume: 75_000 })));
    }
    const market = {
      getHistory: vi.fn(async (symbol: string) => (symbol === 'TCS' ? session('2026-10-05', true) : session('2026-10-05'))),
    };
    const record = vi.fn(async (sigs: unknown[]) => sigs.length);
    return { market, record, scanner: new PatternScanner(market as any, { record } as any, () => ['TCS', 'INFY'], () => now) };
  }

  it('does nothing at all when no pattern has been promoted', async () => {
    const { scanner, market, record } = setup();
    expect(await scanner.run('10:15')).toBe(0);
    expect(market.getHistory).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('records stocks matching a promoted pattern, using completed candles only', async () => {
    const { scanner, record } = setup();
    promote([{ id: '10:15-BUY-aboveOR', checkpoint: '10:15', side: 'BUY', conditions: ['aboveOR'] }]);
    expect(await scanner.run('10:15')).toBe(1);
    const [sig] = record.mock.calls[0][0] as any[];
    expect(sig).toMatchObject({ symbol: 'TCS', direction: 'BUY', strategy: 'pattern:10:15-BUY-aboveOR', entry: 105 });
    expect(sig.target - sig.entry).toBeCloseTo(10 * (sig.entry - sig.stop_loss), 6);
  });

  it('ignores patterns for other checkpoints', async () => {
    const { scanner, record } = setup();
    promote([{ id: '11:15-BUY-aboveOR', checkpoint: '11:15', side: 'BUY', conditions: ['aboveOR'] }]);
    expect(await scanner.run('10:15')).toBe(0);
    expect(record).not.toHaveBeenCalled();
  });
});
