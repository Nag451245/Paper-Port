import { PrismaClient } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
import { parseInstrumentSymbol } from '../lib/instrument.js';
import { istDateStr } from '../lib/ist.js';

const RISK_FREE_RATE = 0.07;

/**
 * Fallback implied volatility, used ONLY when the live option chain has no usable
 * IV for a strike.
 *
 * Real IV now comes from the Breeze option chain (the bridge solves it with
 * `implied_vol_bs` and also returns the exchange's own `implied_volatility`).
 * Every leg reports which one it got via `ivSource`, and the portfolio reports
 * MARKET / MIXED / ASSUMED, so a caller can always tell a measured number from
 * a modelled one.
 */
const ASSUMED_IV = 0.20;

/**
 * The chain reports IV in PERCENT (e.g. 18.5); Black-Scholes needs a decimal.
 *
 * Getting this wrong is a 100x error in vol, which does not merely scale the
 * Greeks — it inverts which side of the moneyness the model thinks it is on. The
 * range check rejects nonsense rather than propagating it: anything outside
 * 0.5%–300% annualised is treated as missing.
 */
function ivPercentToDecimal(ivPercent: number): number | null {
  if (!Number.isFinite(ivPercent) || ivPercent <= 0.5 || ivPercent > 300) return null;
  return ivPercent / 100;
}

// ── Black-Scholes Greeks ──
function d1(S: number, K: number, T: number, r: number, sigma: number): number {
  return (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
}

function d2(S: number, K: number, T: number, r: number, sigma: number): number {
  return d1(S, K, T, r, sigma) - sigma * Math.sqrt(T);
}

function normCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
  return 0.5 * (1 + sign * y);
}

function normPDF(x: number): number {
  return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}

interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
  iv: number;
}

function computeGreeks(
  spot: number, strike: number, tte: number, iv: number,
  optionType: 'CE' | 'PE', r = RISK_FREE_RATE,
): Greeks {
  if (tte <= 0 || iv <= 0) return { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, iv };

  const T = tte;
  const sqrtT = Math.sqrt(T);
  const _d1 = d1(spot, strike, T, r, iv);
  const _d2 = d2(spot, strike, T, r, iv);

  const delta = optionType === 'CE' ? normCDF(_d1) : normCDF(_d1) - 1;
  const gamma = normPDF(_d1) / (spot * iv * sqrtT);
  const vega = spot * normPDF(_d1) * sqrtT / 100;

  const thetaCE = -(spot * normPDF(_d1) * iv) / (2 * sqrtT) - r * strike * Math.exp(-r * T) * normCDF(_d2);
  const thetaPE = -(spot * normPDF(_d1) * iv) / (2 * sqrtT) + r * strike * Math.exp(-r * T) * normCDF(-_d2);
  const theta = (optionType === 'CE' ? thetaCE : thetaPE) / 365;

  const rhoVal = optionType === 'CE'
    ? strike * T * Math.exp(-r * T) * normCDF(_d2) / 100
    : -strike * T * Math.exp(-r * T) * normCDF(-_d2) / 100;

  return {
    delta: Number(delta.toFixed(4)),
    gamma: Number(gamma.toFixed(6)),
    theta: Number(theta.toFixed(2)),
    vega: Number(vega.toFixed(2)),
    rho: Number(rhoVal.toFixed(2)),
    iv: Number(iv.toFixed(4)),
  };
}

export interface OptionsLeg {
  symbol: string;
  strikePrice: number;
  optionType: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  qty: number;
  entryPrice: number;
  currentPrice: number;
  expiry: string;
  positionId?: string;
  /** LIVE when a real quote was fetched, ENTRY when it could not be. */
  priceSource?: 'LIVE' | 'ENTRY';
  /** MARKET when IV came from the live chain, ASSUMED when it fell back. */
  ivSource?: 'MARKET' | 'ASSUMED';
}

/** A position that looks like an option but cannot be identified well enough to price. */
export interface UnresolvedOptionPosition {
  positionId: string;
  symbol: string;
  reason: string;
}

export interface PortfolioGreeks {
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
  netRho: number;
  legs: Array<OptionsLeg & { greeks: Greeks; pnl: number; marginRequired: number }>;
  totalPnl: number;
  totalMarginRequired: number;
  daysToExpiry: number;
  /**
   * MARKET when every leg used live chain IV, ASSUMED when none did, MIXED when
   * some legs fell back. Anything but MARKET means part of the aggregate below is
   * modelled rather than measured.
   */
  ivSource: 'MARKET' | 'MIXED' | 'ASSUMED';
  /**
   * Positions that could not be identified. Previously these were silently
   * priced with the entry PREMIUM standing in for the strike, which produced a
   * delta of ~1.0 and poisoned the portfolio total. They are reported now.
   */
  unresolved: UnresolvedOptionPosition[];
}

interface ResolvedContract {
  strike: number;
  optionType: 'CE' | 'PE';
  expiry: Date;
  underlying: string;
}

export class OptionsPositionService {
  private marketData: MarketDataService;

  constructor(private prisma: PrismaClient) {
    this.marketData = new MarketDataService();
  }

  /**
   * Contract identity from the columns, falling back to the symbol.
   *
   * Returns null rather than guessing. The removed fallback was
   * `strike = parseFloat(tag[2]) || Number(pos.avgEntryPrice)`: with no tag, a
   * ₹120 premium became a strike of 120 against a spot of 24000, i.e. a deeply
   * in-the-money option with delta 1.0. Net portfolio delta was then meaningless
   * and so was any hedge sized from it.
   */
  private resolveContract(pos: {
    symbol: string;
    strike?: unknown;
    optionType?: string | null;
    expiry?: Date | null;
    underlying?: string | null;
    instrumentType?: string | null;
  }): ResolvedContract | { error: string } {
    const strikeFromColumn = pos.strike === null || pos.strike === undefined
      ? null
      : Number(pos.strike);
    const optionTypeFromColumn = pos.optionType === 'CE' || pos.optionType === 'PE'
      ? pos.optionType
      : null;

    if (strikeFromColumn && optionTypeFromColumn && pos.expiry) {
      return {
        strike: strikeFromColumn,
        optionType: optionTypeFromColumn,
        expiry: pos.expiry,
        underlying: pos.underlying ?? pos.symbol,
      };
    }

    // Columns absent (position predates them and was not backfilled). The symbol
    // is authoritative because every writer now builds it canonically.
    try {
      const spec = parseInstrumentSymbol(pos.symbol);
      if (spec.instrumentType === 'OPTIONS' && spec.strike && spec.optionType && spec.expiry) {
        return {
          strike: spec.strike,
          optionType: spec.optionType,
          expiry: spec.expiry,
          underlying: spec.underlying,
        };
      }
      return { error: 'symbol does not identify an option contract' };
    } catch (err) {
      return { error: `unparseable symbol: ${(err as Error).message}` };
    }
  }

  async getOptionsPortfolioGreeks(userId: string, spotPrice?: number): Promise<PortfolioGreeks> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    if (!portfolios.length) return this.emptyGreeks();

    const positions = await this.prisma.position.findMany({
      where: { portfolioId: { in: portfolios.map(p => p.id) }, status: 'OPEN' },
    });

    // Candidates: identified as options by column, or symbol-shaped like one.
    //
    // The digit before CE/PE is load-bearing. The old test was `/(CE|PE)$/i`,
    // which matches RELIANCE — it ends in "CE". Every RELIANCE equity position
    // was therefore treated as an option and, via the old
    // `strike = Number(avgEntryPrice)` fallback, greeked as a ~1400-strike
    // option against NIFTY spot: delta 1.0, silently poisoning net portfolio
    // delta and any hedge sized from it.
    const candidates = positions.filter(p =>
      (p as any).instrumentType === 'OPTIONS' || /\d(CE|PE)$/i.test(p.symbol)
    );
    if (candidates.length === 0) return this.emptyGreeks();

    let netDelta = 0, netGamma = 0, netTheta = 0, netVega = 0, netRho = 0;
    let totalPnl = 0, totalMargin = 0;
    let marketIvLegs = 0, assumedIvLegs = 0;
    const legs: PortfolioGreeks['legs'] = [];
    const unresolved: UnresolvedOptionPosition[] = [];

    // Spot is per-underlying. It used to be NIFTY's quote for every position,
    // with a hardcoded 22000 fallback — so a BANKNIFTY or stock option was
    // priced against the wrong index, or against a made-up number.
    const spotCache = new Map<string, number>();

    // One option-chain fetch per underlying+expiry, reused across every leg on
    // that contract month. This supplies real IV AND the option's own LTP.
    // Fetching per leg would be far worse than it looks: getQuote on an option
    // symbol routes to fetchFnOQuote, which pulls the ENTIRE chain to read one
    // strike — so an 4-leg condor previously meant four full chain downloads.
    const chainCache = new Map<string, any>();
    const getChain = async (underlying: string, expiryIso: string): Promise<any | null> => {
      const key = `${underlying}:${expiryIso}`;
      if (chainCache.has(key)) return chainCache.get(key);
      let chain: any = null;
      try {
        chain = await this.marketData.getOptionsChain(underlying, expiryIso);
      } catch {
        chain = null;
      }
      chainCache.set(key, chain);
      return chain;
    };

    for (const pos of candidates) {
      const resolved = this.resolveContract(pos as any);
      if ('error' in resolved) {
        unresolved.push({ positionId: pos.id, symbol: pos.symbol, reason: resolved.error });
        continue;
      }

      const expiryIso = istDateStr(resolved.expiry);
      const chain = await getChain(resolved.underlying, expiryIso);

      // Prefer the chain's own underlyingValue — it is the spot the exchange
      // priced these premiums against, so IV and spot stay internally consistent.
      let spot = spotPrice ?? spotCache.get(resolved.underlying) ?? 0;
      if (spot <= 0 && Number(chain?.underlyingValue) > 0) {
        spot = Number(chain.underlyingValue);
        spotCache.set(resolved.underlying, spot);
      }
      if (spot <= 0) {
        try {
          const q = await this.marketData.getQuote(resolved.underlying);
          spot = q.ltp;
          spotCache.set(resolved.underlying, spot);
        } catch {
          spot = 0;
        }
      }
      if (spot <= 0) {
        unresolved.push({
          positionId: pos.id,
          symbol: pos.symbol,
          reason: `no spot price available for underlying ${resolved.underlying}`,
        });
        continue;
      }

      const tte = Math.max(
        (resolved.expiry.getTime() - Date.now()) / (365.25 * 86400000),
        0.001,
      );

      const entryPrice = Number(pos.avgEntryPrice);

      // Locate this exact strike in the chain. Both the option's own premium and
      // its implied volatility come from here.
      const isCall = resolved.optionType === 'CE';
      const strikeRow = Array.isArray(chain?.strikes)
        ? chain.strikes.find((s: any) => Number(s.strike) === resolved.strike)
        : undefined;

      // The option's own premium, not the underlying's price. This used to be
      // hardcoded to entryPrice, which made leg P&L exactly zero forever.
      let currentPrice = entryPrice;
      let priceSource: 'LIVE' | 'ENTRY' = 'ENTRY';
      const chainLtp = Number(isCall ? strikeRow?.callLTP : strikeRow?.putLTP);
      if (Number.isFinite(chainLtp) && chainLtp > 0) {
        currentPrice = chainLtp;
        priceSource = 'LIVE';
      } else {
        try {
          const optQuote = await this.marketData.getQuote(pos.symbol, pos.exchange ?? 'NFO');
          if (optQuote?.ltp > 0) {
            currentPrice = optQuote.ltp;
            priceSource = 'LIVE';
          }
        } catch { /* leave at entry and say so via priceSource */ }
      }

      // Real implied volatility, converted from the chain's percent to a decimal.
      const chainIv = ivPercentToDecimal(Number(isCall ? strikeRow?.callIV : strikeRow?.putIV));
      const iv = chainIv ?? ASSUMED_IV;
      const legIvSource: 'MARKET' | 'ASSUMED' = chainIv === null ? 'ASSUMED' : 'MARKET';
      if (legIvSource === 'MARKET') marketIvLegs++; else assumedIvLegs++;

      const multiplier = pos.side === 'LONG' ? 1 : -1;
      const greeks = computeGreeks(spot, resolved.strike, tte, iv, resolved.optionType);

      netDelta += greeks.delta * pos.qty * multiplier;
      netGamma += greeks.gamma * pos.qty * multiplier;
      netTheta += greeks.theta * pos.qty * multiplier;
      netVega += greeks.vega * pos.qty * multiplier;
      netRho += greeks.rho * pos.qty * multiplier;

      const legPnl = (currentPrice - entryPrice) * pos.qty * multiplier;
      totalPnl += legPnl;

      // Short-option margin approximation, retained only so the figure is not
      // blank. It is NOT SPAN: lib/margin-guard.ts blocks opening short options
      // precisely because this system cannot compute their margin.
      let marginReq = 0;
      if (pos.side === 'SHORT') {
        const otmAmount = resolved.optionType === 'CE'
          ? Math.max(resolved.strike - spot, 0)
          : Math.max(spot - resolved.strike, 0);
        marginReq = Math.max(
          spot * pos.qty * 0.15 - otmAmount * pos.qty,
          spot * pos.qty * 0.05,
        );
      }
      totalMargin += marginReq;

      legs.push({
        symbol: pos.symbol,
        strikePrice: resolved.strike,
        optionType: resolved.optionType,
        side: pos.side === 'LONG' ? 'BUY' : 'SELL',
        qty: pos.qty,
        entryPrice,
        currentPrice,
        expiry: istDateStr(resolved.expiry),
        positionId: pos.id,
        priceSource,
        ivSource: legIvSource,
        greeks,
        pnl: Number(legPnl.toFixed(2)),
        marginRequired: Number(marginReq.toFixed(2)),
      });
    }

    const daysToExpiry = legs.length > 0
      ? Math.min(...legs.map(l => Math.max(0, Math.ceil((new Date(l.expiry).getTime() - Date.now()) / 86400000))))
      : 0;

    return {
      netDelta: Number(netDelta.toFixed(2)),
      netGamma: Number(netGamma.toFixed(4)),
      netTheta: Number(netTheta.toFixed(2)),
      netVega: Number(netVega.toFixed(2)),
      netRho: Number(netRho.toFixed(2)),
      legs,
      totalPnl: Number(totalPnl.toFixed(2)),
      totalMarginRequired: Number(totalMargin.toFixed(2)),
      daysToExpiry,
      ivSource: assumedIvLegs === 0 && marketIvLegs > 0
        ? 'MARKET'
        : marketIvLegs === 0 ? 'ASSUMED' : 'MIXED',
      unresolved,
    };
  }

  /**
   * Rolling a position is not implemented.
   *
   * The previous implementation was pure bookkeeping: it marked the old row
   * CLOSED with `realizedPnl: 0`, created a new row at the OLD entry price, and
   * never touched the broker or a market price. In LIVE mode that rewrote our
   * books while leaving the real position open at ICICI — the same failure class
   * as the closePosition bug. It also bypassed `placeOrder` entirely, so the
   * margin guard and the whole risk gate never ran.
   *
   * A correct roll is two real orders (close near leg, open far leg) through
   * TradeService, with the broker's fills booked rather than assumed.
   */
  async rollPosition(
    _userId: string,
    _positionId: string,
    _newStrike: number,
    _newExpiry: string,
  ): Promise<{ closed: string; opened: string }> {
    throw new Error(
      'Rolling is not implemented. The previous version only rewrote the database: ' +
      'it booked no P&L, used the old entry price for the new leg, never placed an ' +
      'order, and bypassed the risk gate — in LIVE mode it would leave the real ' +
      'position open at the broker. Close and reopen through the normal order path.',
    );
  }

  async getExpiringPositions(userId: string, withinDays = 3): Promise<Array<{ symbol: string; positionId: string; expiry: string; daysLeft: number }>> {
    const portfolios = await this.prisma.portfolio.findMany({ where: { userId }, select: { id: true } });
    if (!portfolios.length) return [];

    const positions = await this.prisma.position.findMany({
      where: { portfolioId: { in: portfolios.map(p => p.id) }, status: 'OPEN' },
    });

    const now = Date.now();
    const results: Array<{ symbol: string; positionId: string; expiry: string; daysLeft: number }> = [];

    for (const pos of positions) {
      // Expiry comes from the column, or from the symbol for rows predating it.
      // It used to be read out of `strategyTag`, which meant a position tagged
      // with a strategy name instead had no expiry and was skipped entirely —
      // so genuinely expiring positions went unreported.
      let expiry: Date | null = (pos as any).expiry ?? null;
      if (!expiry) {
        try {
          const spec = parseInstrumentSymbol(pos.symbol);
          expiry = spec.expiry;
        } catch { expiry = null; }
      }
      if (!expiry) continue;

      const daysLeft = Math.ceil((expiry.getTime() - now) / 86400000);
      if (daysLeft <= withinDays && daysLeft >= 0) {
        results.push({
          symbol: pos.symbol,
          positionId: pos.id,
          expiry: istDateStr(expiry),
          daysLeft,
        });
      }
    }

    return results.sort((a, b) => a.daysLeft - b.daysLeft);
  }

  private emptyGreeks(): PortfolioGreeks {
    return {
      netDelta: 0, netGamma: 0, netTheta: 0, netVega: 0, netRho: 0,
      legs: [], totalPnl: 0, totalMarginRequired: 0, daysToExpiry: 0,
      ivSource: 'ASSUMED', unresolved: [],
    };
  }
}
