/**
 * The candle lake: years of candles for every stock, kept as compressed files
 * instead of database rows.
 *
 * Why files: 5-minute candles for ~530 stocks are ~10 million rows a year.
 * In Postgres that is ~2 GB a year plus index upkeep, and every backtest or
 * scan would read through the database. As gzipped CSV it is ~13 bytes a
 * candle (measured): ~240 KB per stock-year, ~125 MB a year for all of them,
 * read straight off disk without touching the database.
 *
 * Layout under MARKET_DATA_DIR (default ~/market-data, outside the app folder
 * so deploys never touch it):
 *   5m/<SYMBOL>/<YYYY-MM>.csv.gz   epochSeconds,open,high,low,close,volume  (bar start)
 *   1d/<SYMBOL>.csv.gz             YYYY-MM-DD,open,high,low,close,volume
 *   manifest.json                  what each symbol covers, for the backfill
 *
 * Only 5-minute candles are stored for intraday; 15-minute and 1-hour candles
 * are built from them, so the timeframes can never disagree.
 * Past months are written once; only the current month's file is rewritten.
 * Writes go to a temp file and are renamed into place, so a crash never leaves
 * a half-written file.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import type { HistoricalBar } from '../services/market-data.service.js';
import { barInstant, formatBarTime } from './bar-time.js';

export const lakeDir = () => process.env.MARKET_DATA_DIR || path.join(os.homedir(), 'market-data');

export type LakeInterval = '5m' | '15m' | '1h' | '1d';

/** App interval names → lake interval, or null for intervals the lake does not serve. */
export function lakeInterval(interval: string): LakeInterval | null {
  const i = interval.toLowerCase();
  if (['5m', '5min', '5minute'].includes(i)) return '5m';
  if (['15m', '15min', '15minute'].includes(i)) return '15m';
  if (['1h', '1hour', '60m', '60min', 'hour'].includes(i)) return '1h';
  if (['1d', '1day', 'day', 'daily'].includes(i)) return '1d';
  return null;
}

const SESSION_START_MIN = 9 * 60 + 15;
const istMinuteOfDay = (ms: number) => Math.floor((((ms + 330 * 60_000) % 86_400_000) + 86_400_000) % 86_400_000 / 60_000);

/**
 * Build `minutes`-long candles from 5-minute ones, aligned to the 09:15 open
 * (15m: 09:15, 09:30 …; 1h: 09:15, 10:15 … 15:15). Input oldest first.
 */
export function aggregate(bars: HistoricalBar[], minutes: number): HistoricalBar[] {
  const out: HistoricalBar[] = [];
  let cur: HistoricalBar | null = null, curKey = -1;
  for (const b of bars) {
    const ms = barInstant(b.timestamp);
    const m = istMinuteOfDay(ms);
    const bucketMin = SESSION_START_MIN + Math.floor((m - SESSION_START_MIN) / minutes) * minutes;
    const key = ms - (m - bucketMin) * 60_000;
    if (key !== curKey) {
      if (cur) out.push(cur);
      cur = { timestamp: formatBarTime(key, false), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      curKey = key;
    } else {
      cur!.high = Math.max(cur!.high, b.high);
      cur!.low = Math.min(cur!.low, b.low);
      cur!.close = b.close;
      cur!.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ───────────── files ─────────────
const safe = (symbol: string) => symbol.toUpperCase().replace(/[^A-Z0-9&_-]/g, '_');
const monthFile = (symbol: string, month: string) => path.join(lakeDir(), '5m', safe(symbol), `${month}.csv.gz`);
const dailyFile = (symbol: string) => path.join(lakeDir(), '1d', `${safe(symbol)}.csv.gz`);

function readGz(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n').filter(Boolean);
}

function writeGz(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, zlib.gzipSync(lines.join('\n'), { level: 9 }));
  fs.renameSync(tmp, file);
}

const px = (v: number) => (Math.round(v * 100) / 100).toString();
const row = (key: string | number, b: HistoricalBar) => `${key},${px(b.open)},${px(b.high)},${px(b.low)},${px(b.close)},${Math.round(b.volume || 0)}`;
const parse = (line: string) => {
  const [k, o, h, l, c, v] = line.split(',');
  return { k, open: +o, high: +h, low: +l, close: +c, volume: +v };
};

/** Merge intraday 5-minute candles into the lake (new values win). Returns candles written. */
export function writeIntraday(symbol: string, bars: HistoricalBar[]): number {
  const byMonth = new Map<string, Map<number, HistoricalBar>>();
  for (const b of bars) {
    if (!(b.close > 0) || b.timestamp.length <= 10) continue;
    const ms = barInstant(b.timestamp);
    const month = formatBarTime(ms, true).slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, new Map());
    byMonth.get(month)!.set(Math.round(ms / 1000), b);
  }
  let n = 0;
  for (const [month, incoming] of byMonth) {
    const file = monthFile(symbol, month);
    const merged = new Map<number, string>();
    for (const line of readGz(file)) merged.set(Number(line.slice(0, line.indexOf(','))), line);
    for (const [sec, b] of incoming) merged.set(sec, row(sec, b));
    writeGz(file, [...merged].sort((a, b) => a[0] - b[0]).map(([, l]) => l));
    n += incoming.size;
  }
  return n;
}

/** Merge daily candles (YYYY-MM-DD timestamps) into the lake. */
export function writeDaily(symbol: string, bars: HistoricalBar[]): number {
  const file = dailyFile(symbol);
  const merged = new Map<string, string>();
  for (const line of readGz(file)) merged.set(line.slice(0, 10), line);
  let n = 0;
  for (const b of bars) {
    if (!(b.close > 0)) continue;
    const day = b.timestamp.slice(0, 10);
    merged.set(day, row(day, b));
    n++;
  }
  writeGz(file, [...merged].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, l]) => l));
  return n;
}

const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
};

/** Candles for [from, to] (YYYY-MM-DD, inclusive), oldest first, in the app's format. */
export function readBars(symbol: string, interval: LakeInterval, from: string, to: string): HistoricalBar[] {
  if (interval === '1d') {
    return readGz(dailyFile(symbol))
      .map(parse)
      .filter((b) => b.k >= from && b.k <= to)
      .map(({ k, ...b }) => ({ timestamp: k, ...b }));
  }
  const lo = barInstant(from), hi = barInstant(`${to} 23:59:59`);
  const five: HistoricalBar[] = [];
  for (const month of monthsBetween(from, to)) {
    for (const line of readGz(monthFile(symbol, month))) {
      const { k, ...b } = parse(line);
      const ms = Number(k) * 1000;
      if (ms >= lo && ms <= hi) five.push({ timestamp: formatBarTime(ms, false), ...b });
    }
  }
  return interval === '5m' ? five : aggregate(five, interval === '15m' ? 15 : 60);
}

/** The trading days a symbol's intraday files cover within [from, to]. */
export function intradayDays(symbol: string, from: string, to: string): Set<string> {
  return new Set(readBars(symbol, '5m', from, to).map((b) => b.timestamp.slice(0, 10)));
}

// ───────────── manifest (backfill progress) ─────────────
export interface SymbolCoverage {
  /** Earliest day the intraday backfill has reached (it walks backwards). */
  intradayFrom?: string;
  /** The broker has no intraday history before intradayFrom. */
  intradayComplete?: boolean;
  /** Empty backfill windows in a row (the broker may have nothing older). */
  emptyWindows?: number;
  /** Daily history has been fetched in full once. */
  dailyComplete?: boolean;
  lastSync?: string;
}
export type Manifest = Record<string, SymbolCoverage>;

const manifestFile = () => path.join(lakeDir(), 'manifest.json');
export function readManifest(): Manifest {
  try { return JSON.parse(fs.readFileSync(manifestFile(), 'utf8')); } catch { return {}; }
}
export function writeManifest(m: Manifest): void {
  fs.mkdirSync(lakeDir(), { recursive: true });
  const tmp = `${manifestFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(m));
  fs.renameSync(tmp, manifestFile());
}

/** Total size of the lake on disk, in bytes. */
export function lakeSize(dir = lakeDir()): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? lakeSize(p) : fs.statSync(p).size;
  }
  return total;
}
