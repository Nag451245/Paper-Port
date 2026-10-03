/**
 * FII/FPI and DII net buying in the cash market (₹ crore), from official
 * sources only, in this order:
 *  1. NSE's daily provisional report for all exchanges (api/fiidiiTradeReact),
 *  2. NSE's report for NSE trades only (api/fiidiiTradeNse),
 *  3. NSDL's daily FPI report (foreign investors only; NSDL does not publish DII).
 * (NiftyTrader's API, used before, now refuses requests without a login; BSE
 * refuses automated requests.) NSE names the rows "FII/FPI" and "DII" and gives
 * values in crore.
 *
 * Every day read is saved to <MARKET_DATA_DIR>/fii-dii.json, so the trend
 * chart has history, and a moment when NSE does not answer shows the last day
 * saved (marked as such) instead of zeros.
 */
import fs from 'fs';
import path from 'path';
import { lakeDir } from './candle-lake.js';

export type FiiDiiSource = 'nse' | 'nse-only' | 'nsdl';
export interface FiiDiiDay {
  /** YYYY-MM-DD, the trading day the figures are for */
  date: string;
  fiiBuy: number; fiiSell: number; fiiNet: number;
  /** null when the source does not publish DII (NSDL) */
  diiBuy: number | null; diiSell: number | null; diiNet: number | null;
  source: FiiDiiSource;
  sourceLabel: string;
}

export const NSE_FII_DII_URL = 'https://www.nseindia.com/api/fiidiiTradeReact';
export const NSE_ONLY_FII_DII_URL = 'https://www.nseindia.com/api/fiidiiTradeNse';
export const NSDL_FPI_URL = 'https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx';
const LABELS: Record<FiiDiiSource, string> = {
  nse: 'NSE (all exchanges, provisional)',
  'nse-only': 'NSE (NSE trades only, provisional)',
  nsdl: 'NSDL (foreign investors only)',
};
const RANK: Record<FiiDiiSource, number> = { nse: 3, 'nse-only': 2, nsdl: 1 };
const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** "01-Oct-2026" → "2026-10-01" */
function nseDate(s: unknown): string | null {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(s ?? '').trim());
  return m && MONTHS[m[2].toLowerCase()] ? `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}` : null;
}
const num = (v: unknown) => Number(String(v ?? '').replace(/,/g, '')) || 0;

export function parseNseFiiDii(rows: unknown, source: 'nse' | 'nse-only' = 'nse'): FiiDiiDay | null {
  if (!Array.isArray(rows)) return null;
  const pick = (re: RegExp) => rows.find((r: any) => re.test(String(r?.category ?? '').trim()));
  const fii = pick(/^(FII|FPI)/i), dii = pick(/^DII/i);
  const date = nseDate(fii?.date ?? dii?.date);
  if ((!fii && !dii) || !date) return null;
  return {
    date,
    fiiBuy: num(fii?.buyValue), fiiSell: num(fii?.sellValue), fiiNet: num(fii?.netValue),
    diiBuy: num(dii?.buyValue), diiSell: num(dii?.sellValue), diiNet: num(dii?.netValue),
    source, sourceLabel: LABELS[source],
  };
}

/** NSDL's "Daily Trends in FPI Investments": the Equity / Stock Exchange row of the latest day. */
export function parseNsdlFpi(html: string): FiiDiiDay | null {
  const cells = (row: string) => [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
    .map((c) => c[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());
  // NSDL writes outflows in brackets: (9569.57)
  const value = (s: string) => { const neg = /^\(.*\)$/.test(s); const n = num(s.replace(/[()]/g, '')); return neg ? -n : n; };
  for (const m of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const c = cells(m[1]);
    const date = nseDate(c[0]);
    if (date && /^equity$/i.test(c[1] ?? '') && /stock exchange/i.test(c[2] ?? '')) {
      return {
        date, fiiBuy: value(c[3]), fiiSell: value(c[4]), fiiNet: value(c[5]),
        diiBuy: null, diiSell: null, diiNet: null, source: 'nsdl', sourceLabel: LABELS.nsdl,
      };
    }
  }
  return null;
}

async function fetchNsdl(): Promise<string | null> {
  try {
    const res = await fetch(NSDL_FPI_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        Accept: 'text/html,*/*', Referer: 'https://www.fpi.nsdl.co.in/',
      },
      signal: AbortSignal.timeout(30_000),                  // NSDL is often slow to answer
    });
    return res.ok ? await res.text() : null;
  } catch { return null; }
}

const historyFile = () => path.join(lakeDir(), 'fii-dii.json');

export function readFiiDiiHistory(): FiiDiiDay[] {
  try {
    const byDate = JSON.parse(fs.readFileSync(historyFile(), 'utf8')) as Record<string, FiiDiiDay>;
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  } catch { return []; }
}

function saveFiiDiiDay(day: FiiDiiDay): void {
  try {
    const file = historyFile();
    let byDate: Record<string, FiiDiiDay> = {};
    try { byDate = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first day */ }
    // A better source for the same day is never replaced by a lesser one.
    const held = byDate[day.date];
    if (held && RANK[held.source ?? 'nse'] > RANK[day.source]) return;
    byDate[day.date] = day;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(byDate));
    fs.renameSync(`${file}.tmp`, file);
  } catch { /* history is a convenience; never fail the request */ }
}

/**
 * The latest figures from the first official source that answers (saved for
 * the trend), else the last day saved with `stale: true`, else null.
 * `fetchJson` reads NSE (it needs NSE's cookies); NSDL is read directly.
 */
export async function latestFiiDii(
  fetchJson: (url: string) => Promise<unknown>,
  fetchHtml: () => Promise<string | null> = fetchNsdl,
): Promise<(FiiDiiDay & { stale?: boolean }) | null> {
  const fresh = parseNseFiiDii(await fetchJson(NSE_FII_DII_URL).catch(() => null), 'nse')
    ?? parseNseFiiDii(await fetchJson(NSE_ONLY_FII_DII_URL).catch(() => null), 'nse-only')
    ?? parseNsdlFpi((await fetchHtml().catch(() => null)) ?? '');
  if (fresh) { saveFiiDiiDay(fresh); return fresh; }
  const history = readFiiDiiHistory();
  const last = history[history.length - 1];
  return last ? { ...last, stale: true } : null;
}
