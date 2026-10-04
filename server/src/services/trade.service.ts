import { PrismaClient } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
import { MarketCalendar } from './market-calendar.js';
import { RiskService } from './risk.service.js';
import { OrderManagementService } from './oms.service.js';
import { getBrokerAdapter, type BrokerAdapter, type BrokerOrderInput as BrokerInput } from '../lib/broker-adapter.js';
import { wsHub } from '../lib/websocket.js';
import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
import { ExitCoordinator } from './exit-coordinator.service.js';
import { DecisionAuditService } from './decision-audit.service.js';
import { getRedis } from '../lib/redis.js';
import { isKillSwitchActive } from '../lib/rust-engine.js';
import { FillSimulatorService } from './fill-simulator.service.js';
import { ExecutionEngineService } from './execution-engine.service.js';
import { SmartOrderRouterService } from './smart-order-router.service.js';
import { OrderBookService } from './order-book.service.js';
import { MetricsService } from './metrics.service.js';
import { POVExecutorService } from './pov-executor.service.js';
import { SniperExecutorService } from './sniper-executor.service.js';
import { ISExecutorService } from './is-executor.service.js';
import { IcebergExecutor } from './iceberg-executor.service.js';
import { BrokerStopLossService } from './broker-stop-loss.service.js';
type OrderSide = string;
type OrderType = string;
type Exchange = string;

const log = createChildLogger('TradeService');

/** Prisma raises P2002 when a unique constraint (here, clientOrderId) is violated. */
function isUniqueConstraintError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';
}

const TWAP_AUTO_ROUTE_QTY_THRESHOLD = Number(process.env.TWAP_QTY_THRESHOLD ?? 500);
const TWAP_DEFAULT_SLICES = 5;
const TWAP_DEFAULT_DURATION_MIN = 10;
const TWAP_MAX_DEVIATION_PCT = 1.0;

const TRADING_MODE: 'PAPER' | 'LIVE' = (process.env.TRADING_MODE ?? 'PAPER').toUpperCase() as any;

export interface PlaceOrderInput {
  portfolioId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  qty: number;
  price?: number;
  triggerPrice?: number;
  instrumentToken: string;
  exchange?: Exchange;
  strategyTag?: string;
  expiry?: string;
  strike?: number;
  optionType?: 'CE' | 'PE';
  /** Units per lot. `qty` is always in UNITS; this is recorded, never multiplied in. */
  lotSize?: number;
  product?: 'INTRADAY' | 'DELIVERY' | 'MARGIN';
  stopLoss?: number;
  target?: number;
  /**
   * Idempotency key. Two calls carrying the same value place ONE order; the
   * second returns the first one's result. Enforced by a unique constraint on
   * orders.client_order_id, so it holds under concurrency too.
   */
  clientOrderId?: string;
  /** Internal: margin worked out before the order was accepted (null = paid in full). */
  marginPlan?: MarginPlan | null;
  /** Internal: price of the underlying when the order was placed, for margin sums. */
  underlyingSpot?: number | null;
}

/** Margin to block per unit when a position opens, and the position that lowered it (if any). */
export interface MarginPlan { perUnit: number; linkId: string | null }

import { calculateCosts, resolveInstrumentKind, type CostBreakdown } from '../lib/costs.js';
import { autoTopUpAmount, AUTO_TOPUP_LIMIT, MANUAL_CAPITAL_LIMIT } from '../lib/capital.js';
import {
  capitalBlocked, legacyShortMargin, futuresMargin, nakedOptionMargin, spreadMargin, exposureMargin,
  isIndexUnderlying,
} from '../lib/margin.js';

const CAPITAL_HINT = `Raise the capital in Settings (up to ₹${MANUAL_CAPITAL_LIMIT.toLocaleString('en-IN')}).`;
import {
  parseInstrumentSymbol,
  segmentForExchange,
  expiryToDate,
  type InstrumentSpec,
} from '../lib/instrument.js';
import { checkMarginSupported } from '../lib/margin-guard.js';
import { FailureRegistryService } from './failure-registry.service.js';

interface ExecutionSimulation {
  idealPrice: number;
  fillPrice: number;
  slippageBps: number;
  spreadCost: number;
  impactCost: number;
  filledQty: number;
  requestedQty: number;
  fillRatio: number;
  latencyMs: number;
}

function simulateExecution(
  idealPrice: number,
  qty: number,
  side: 'BUY' | 'SELL',
  exchange: string = 'NSE',
  orderType: string = 'MARKET',
): ExecutionSimulation {
  if (orderType !== 'MARKET') {
    return {
      idealPrice, fillPrice: idealPrice, slippageBps: 0, spreadCost: 0,
      impactCost: 0, filledQty: qty, requestedQty: qty, fillRatio: 1, latencyMs: 0,
    };
  }

  const fillSim = new FillSimulatorService();
  const marketState = { ltp: idealPrice, avgDailyVolume: 500_000 };
  const result = fillSim.simulate(
    { symbol: '', exchange: exchange ?? 'NSE', side, orderType: 'MARKET', qty, price: idealPrice },
    marketState,
  );

  const fillRatio = qty > 0 ? result.fillQty / qty : 1;
  const spreadCost = Math.abs(result.fillPrice - idealPrice) * result.fillQty;

  return {
    idealPrice: Number(idealPrice.toFixed(2)),
    fillPrice: result.fillPrice,
    slippageBps: result.slippageBps,
    spreadCost: Number(spreadCost.toFixed(2)),
    impactCost: result.marketImpact,
    filledQty: result.fillQty,
    requestedQty: qty,
    fillRatio: Number(fillRatio.toFixed(3)),
    latencyMs: result.latencyMs,
  };
}

export class TradeService {
  private marketData: MarketDataService;
  private calendar: MarketCalendar;
  private riskService: RiskService;
  private failureRegistry: FailureRegistryService;
  private broker: BrokerAdapter | null = null;
  private oms: OrderManagementService | null = null;
  private _twapExecutor: any = null;
  private fillSimulator = new FillSimulatorService();
  private smartRouter: SmartOrderRouterService;
  private executionEngine: ExecutionEngineService;
  private brokerStops: BrokerStopLossService;

  constructor(private prisma: PrismaClient, oms?: OrderManagementService) {
    this.marketData = new MarketDataService();
    this.calendar = new MarketCalendar();
    this.riskService = new RiskService(prisma);
    this.failureRegistry = new FailureRegistryService(prisma);
    this.oms = oms ?? new OrderManagementService(prisma);
    this.smartRouter = new SmartOrderRouterService(new OrderBookService());
    this.executionEngine = new ExecutionEngineService(this.fillSimulator);
    this.brokerStops = new BrokerStopLossService(prisma);

    if (TRADING_MODE === 'LIVE') {
      this.broker = getBrokerAdapter('breeze');
      if (this.broker) {
        this.broker.connect({}).catch(err => log.error({ err }, 'Broker connection failed'));
      }
    }
  }

  private async getTwapExecutor() {
    if (!this._twapExecutor) {
      const { TWAPExecutor } = await import('./twap-executor.service.js');
      this._twapExecutor = new TWAPExecutor(this.prisma);
      this._twapExecutor.setTradeService(this);
    }
    return this._twapExecutor;
  }

  isLiveMode(): boolean { return TRADING_MODE === 'LIVE' && !!this.broker; }

  getExecutionStats(): { latency: ReturnType<ExecutionEngineService['getLatencyStats']>; queueDepth: number } {
    return {
      latency: this.executionEngine.getLatencyStats(),
      queueDepth: this.executionEngine.getQueueDepth(),
    };
  }

  async executeLiveOrder(input: PlaceOrderInput): Promise<{ orderId: string; status: string; brokerOrderId?: string }> {
    if (!this.broker) throw new TradeError('Live broker not configured', 500);

    const brokerContract = this.contractFields(input);

    const brokerInput: BrokerInput = {
      symbol: input.symbol,
      exchange: input.exchange ?? 'NSE',
      side: input.side as 'BUY' | 'SELL',
      orderType: input.orderType as any,
      qty: input.qty,
      price: input.price,
      triggerPrice: input.triggerPrice,
      product: input.exchange === 'NFO' ? 'INTRADAY' : 'DELIVERY',
      expiry: input.expiry,
      strike: input.strike,
      optionType: input.optionType,
      // Breeze keys derivatives on the underlying plus expiry/right/strike, and
      // picks its `product` from the segment. Without these the adapter cannot
      // build a valid F&O payload.
      underlying: brokerContract.underlying,
      instrumentType: brokerContract.instrumentType as 'EQUITY' | 'FUTURES' | 'OPTIONS',
    };

    const result = await this.broker.placeOrder(brokerInput);
    if (result.status === 'FAILED') {
      throw new TradeError(`Broker rejected order: ${result.message}`, 400);
    }
    return { orderId: result.orderId, status: result.status, brokerOrderId: result.brokerOrderId };
  }

  /**
   * Send a market exit to the broker and wait for a terminal state.
   *
   * Throws 502 for a definite rejection (nothing executed — the caller can
   * safely restore the position) and 504 when the outcome is unknown after the
   * poll budget. The distinction matters: 502 is recoverable, 504 means an
   * order may be live and the position must not be re-entered or re-booked.
   */
  private async executeLiveExit(position: {
    id: string; symbol: string; exchange: string; side: string; qty: number;
  }): Promise<{ avgPrice: number; filledQty: number }> {
    if (!this.broker) throw new TradeError('Live broker not configured', 500);

    const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';
    const placed = await this.broker.placeOrder({
      symbol: position.symbol,
      exchange: position.exchange,
      side: exitSide,
      orderType: 'MARKET',
      qty: position.qty,
      product: position.exchange === 'NFO' ? 'INTRADAY' : 'DELIVERY',
    } as any);

    if (placed.status === 'FAILED' || !placed.orderId) {
      throw new TradeError(`Broker rejected exit order: ${placed.message ?? 'unknown reason'}`, 502);
    }

    const TERMINAL = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED']);
    const POLL_INTERVAL_MS = 2000;
    const MAX_POLLS = 30; // 60s — an exit is worth waiting longer for than an entry

    let avgPrice = 0;
    let filledQty = 0;

    for (let poll = 0; poll < MAX_POLLS; poll++) {
      const status = await this.broker.getOrderStatus(placed.orderId).catch(() => null);

      if (status) {
        if (status.avgPrice > 0) avgPrice = status.avgPrice;
        if (status.filledQty > 0) filledQty = status.filledQty;

        if (TERMINAL.has(status.status)) {
          if (status.status === 'FILLED') return { avgPrice, filledQty };
          // Rejected/cancelled/expired with nothing filled is a clean failure.
          if (filledQty === 0) {
            throw new TradeError(`Broker ${status.status.toLowerCase()} the exit order: ${status.message ?? 'no reason given'}`, 502);
          }
          // Partially filled then terminated: neither clean success nor clean
          // failure, so treat it as indeterminate rather than guessing.
          throw new TradeError(
            `Exit order ${status.status.toLowerCase()} after a partial fill of ${filledQty}/${position.qty} — manual reconciliation required`,
            504,
          );
        }
      }

      if (poll < MAX_POLLS - 1) await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Budget exhausted with the order still live. Do NOT assume it filled.
    throw new TradeError(
      `Exit order ${placed.orderId} did not reach a terminal state within ${(MAX_POLLS * POLL_INTERVAL_MS) / 1000}s — state unknown`,
      504,
    );
  }

  async getBrokerPositions() {
    if (!this.broker) return [];
    return this.broker.getPositions();
  }

  async getBrokerMargin() {
    if (!this.broker) return { available: 0, used: 0, total: 0 };
    return this.broker.getMarginAvailable();
  }

  async getTotalInvestedValue(portfolioId: string): Promise<number> {
    try {
      const openPositions = await this.prisma.position.findMany({
        where: { portfolioId, status: 'OPEN' },
        select: { avgEntryPrice: true, qty: true, side: true, exchange: true, marginBlocked: true },
      });

      if (!openPositions || !Array.isArray(openPositions)) return 0;

      return openPositions.reduce((total: number, pos: any) => total + capitalBlocked(pos), 0);
    } catch {
      return 0;
    }
  }

  async recoverCapital(portfolioId: string, userId: string, amountNeeded: number): Promise<{
    recovered: number;
    closedPositions: string[];
  }> {
    const positions = await this.prisma.position.findMany({
      where: { portfolioId, status: 'OPEN' },
      include: { portfolio: true },
    });

    if (positions.length === 0) return { recovered: 0, closedPositions: [] };

    const positionsWithPnl: Array<{ id: string; symbol: string; unrealizedPnl: number; value: number }> = [];

    for (const pos of positions) {
      const entryPrice = Number(pos.avgEntryPrice);
      let ltp = entryPrice;
      try {
        const quote = await this.marketData.getQuote(pos.symbol, pos.exchange);
        if (quote.ltp > 0) ltp = quote.ltp;
      } catch {}

      const unrealizedPnl = pos.side === 'LONG'
        ? (ltp - entryPrice) * pos.qty
        : (entryPrice - ltp) * pos.qty;

      positionsWithPnl.push({
        id: pos.id,
        symbol: pos.symbol,
        unrealizedPnl,
        value: entryPrice * pos.qty,
      });
    }

    // Close worst performers first (most negative P&L), then near-SL trades
    positionsWithPnl.sort((a, b) => a.unrealizedPnl - b.unrealizedPnl);

    let recovered = 0;
    const closedPositions: string[] = [];

    for (const pos of positionsWithPnl) {
      if (recovered >= amountNeeded) break;

      try {
        const quote = await this.marketData.getQuote(pos.symbol, 'NSE');
        const exitResult = await ExitCoordinator.closePosition({
          positionId: pos.id,
          userId,
          exitPrice: quote.ltp,
          reason: 'Capital recovery: closing worst performer',
          source: 'CAPITAL_RECOVERY',
          decisionType: 'EXIT_SIGNAL',
          prisma: this.prisma,
          tradeService: this,
          decisionAudit: new DecisionAuditService(this.prisma),
        });
        if (exitResult.success) {
          recovered += pos.value;
          closedPositions.push(pos.symbol);
        }
      } catch (err) {
        log.error({ err, symbol: pos.symbol }, 'Capital recovery: failed to close position');
      }
    }

    return { recovered, closedPositions };
  }

  /**
   * Look up a previously placed order by its idempotency key, scoped to the
   * caller so one user cannot probe another's order ids.
   */
  private async findByClientOrderId(clientOrderId: string, userId: string) {
    const existing = await this.prisma.order.findUnique({
      where: { clientOrderId },
      include: { portfolio: { select: { userId: true } } },
    });
    if (!existing) return null;
    if (existing.portfolio?.userId !== userId) {
      throw new TradeError('Idempotency key belongs to another account', 409);
    }
    const { portfolio: _portfolio, ...order } = existing as any;
    return order;
  }

  async placeOrder(userId: string, input: PlaceOrderInput, skipMarketCheck = false) {
    // ── Idempotency ────────────────────────────────────────────────────────
    // A retry — client timeout, proxy replay, bot re-tick after a slow cycle —
    // must not become a second live order. Callers that pass a clientOrderId
    // get the original order back instead. Checked first so a replay costs
    // nothing and never reaches the broker.
    if (input.clientOrderId) {
      const existing = await this.findByClientOrderId(input.clientOrderId, userId);
      if (existing) {
        log.info({ clientOrderId: input.clientOrderId, orderId: existing.id },
          'Idempotent replay — returning the original order, no new order placed');
        return { ...existing, idempotentReplay: true };
      }
    }

    try {
      const killed = await isKillSwitchActive();
      if (killed) {
        throw new TradeError('Kill switch is active — all new orders are blocked', 503);
      }
    } catch (err) {
      if (err instanceof TradeError) throw err;
      log.warn({ err }, 'Kill switch check failed (engine unreachable) — proceeding');
    }

    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: input.portfolioId },
    });

    if (!portfolio || portfolio.userId !== userId) {
      throw new TradeError('Portfolio not found', 404);
    }

    let exchange = input.exchange ?? 'NSE';
    if (!input.exchange) {
      try {
        const routeDecision = this.smartRouter.route({
          symbol: input.symbol, side: input.side, qty: input.qty, price: input.price,
        });
        if (routeDecision.confidence > 0.6) {
          exchange = routeDecision.exchange;
          log.info({ symbol: input.symbol, exchange, reason: routeDecision.reason }, 'Smart router selected exchange');
        }
      } catch { /* fall through to default */ }
    }
    const marketOpen = this.calendar.isMarketOpen(exchange);

    // STRICT RULE: No orders outside market hours — not even queued
    if (!marketOpen && !skipMarketCheck) {
      throw new TradeError(
        `Market is closed. Orders cannot be placed or queued outside market hours. ` +
        `${exchange} trading hours: ${exchange === 'MCX' ? '9:00-23:30' : exchange === 'CDS' ? '9:00-17:00' : '9:15-15:30'} IST.`,
        400,
      );
    }

    // ── Margin guard ───────────────────────────────────────────────────────
    // Checked before any broker interaction, order row, or capital reservation.
    // This system cannot yet compute SPAN + exposure, and the flat-percentage
    // fallback understates short-option margin by roughly sixty times, so a
    // paper equity curve built on it would be fiction. See lib/margin-guard.ts.
    const contract = this.contractFields({ ...input, exchange });

    // How much of this contract is held LONG, so the guard can tell a closing
    // SELL from a new short. Without this, buying a call — which IS allowed —
    // would leave no way to sell it again through the normal order path.
    let heldLongQty = 0;
    if (input.side === 'SELL') {
      const existingLongForGuard = await this.prisma.position.findFirst({
        where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'LONG', status: 'OPEN' },
        select: { qty: true },
      });
      heldLongQty = existingLongForGuard?.qty ?? 0;
    }

    const marginVerdict = checkMarginSupported({
      instrumentType: contract.instrumentType,
      side: input.side,
      symbol: input.symbol,
      exchange,
      qty: input.qty,
      reducingQty: heldLongQty,
    });
    if (!marginVerdict.allowed) {
      log.warn({ symbol: input.symbol, side: input.side, instrumentType: contract.instrumentType },
        'Order blocked — margin not modelled for this instrument');
      throw new TradeError(marginVerdict.reason!, 400);
    }

    // ── Known-failure check ────────────────────────────────────────────────
    // Refuse an order whose shape has already failed in a way that cannot
    // succeed. Matching is on shape, not the exact contract, so the NEXT weekly
    // expiry of a broken pattern is caught too. Only failures already marked
    // `blocked` are consulted, and a registry error never blocks a trade — an
    // unavailable registry must not become an outage.
    try {
      const known = await this.failureRegistry.checkBlocked({
        segment: contract.segment,
        instrumentType: contract.instrumentType,
        underlying: contract.underlying,
      });
      if (known.blocked) {
        log.error({ symbol: input.symbol, fingerprint: known.fingerprint, failureClass: known.failureClass },
          'Order refused — matches a known execution failure');
        throw new TradeError(known.reason!, 409);
      }
    } catch (err) {
      if (err instanceof TradeError) throw err;
      log.warn({ err }, 'Known-failure check unavailable — proceeding');
    }

    // Even with skipMarketCheck (manual AMO), bots must NEVER trade after hours
    if (!marketOpen && (input.strategyTag?.startsWith('AI-BOT') || input.strategyTag?.startsWith('BOT:'))) {
      throw new TradeError(
        'STRICT: Bot/Agent orders are blocked outside market hours. No exceptions.',
        400,
      );
    }

    // STRICT CAPITAL ENFORCEMENT: Never exceed declared initial capital
    let declaredCapital = Number(portfolio.initialCapital);
    const currentNav = Number(portfolio.currentNav);
    const totalInvested = await this.getTotalInvestedValue(input.portfolioId);

    // Per-symbol advisory lock: prevent concurrent orders from bypassing position limits
    const lockKey = `order_lock:${input.portfolioId}:${input.symbol}`;
    const redis = getRedis();
    if (redis) {
      const acquired = await redis.set(lockKey, '1', 'EX', 30, 'NX');
      if (!acquired) {
        throw new TradeError(
          `Another order for ${input.symbol} is already being processed. Please wait.`,
          429,
        );
      }
    }

    // ── Reserve the idempotency key BEFORE any broker interaction ──────────
    // The lookup at the top of this method only catches a retry that arrives
    // after the first one finished. Two simultaneous calls would both pass it
    // and, in LIVE mode, both reach the broker. Claiming the unique key here
    // means exactly one proceeds; the loser returns the winner's order.
    let reservedOrderId: string | null = null;
    if (input.clientOrderId) {
      try {
        const reservation = await this.prisma.order.create({
          data: {
            clientOrderId: input.clientOrderId,
            portfolioId: input.portfolioId,
            instrumentToken: input.instrumentToken,
            symbol: input.symbol,
            exchange,
            orderType: input.orderType,
            side: input.side,
            qty: input.qty,
            status: 'PENDING',
            filledQty: 0,
          },
        });
        reservedOrderId = reservation.id;
      } catch (err) {
        if (isUniqueConstraintError(err)) {
          if (redis) await redis.del(lockKey).catch(() => {});
          const winner = await this.findByClientOrderId(input.clientOrderId, userId);
          if (winner) {
            log.info({ clientOrderId: input.clientOrderId, orderId: winner.id },
              'Concurrent duplicate lost the idempotency race — returning the winning order');
            return { ...winner, idempotentReplay: true };
          }
        }
        if (redis) await redis.del(lockKey).catch(() => {});
        throw err;
      }
    }

    try {
    // ── Reference price ───────────────────────────────────────────────────
    // Resolved BEFORE the risk gate. Every position limit is denominated in
    // rupees, so without a price they cannot be evaluated at all.
    //
    // This used to run *after* the gate, and the gate used `input.price ?? 0`.
    // Bots place MARKET orders with no price (bot-engine passes `undefined`),
    // so estPrice was 0, and `if (estPrice > 0)` skipped preTradeCheck — the
    // max-open-positions, 5%-concentration and Rs 500k fat-finger limits were
    // silently bypassed for precisely the orders placed with nobody watching.
    let fillPrice = input.price ?? 0;

    if (fillPrice <= 0) {
      let quote: { ltp?: number; timestamp?: string } | null = null;
      try {
        quote = await this.marketData.getQuote(input.symbol, exchange);
      } catch (err) {
        throw new TradeError(
          `Cannot price ${input.symbol}: market data unavailable (${(err as Error).message}). ` +
          'Retry, or place a limit order with an explicit price.',
          503,
        );
      }

      fillPrice = Number(quote?.ltp ?? 0);
      if (!(fillPrice > 0)) {
        throw new TradeError(
          `Cannot place market order: unable to fetch current price for ${input.symbol}. ` +
          'Ensure Breeze API session is active or try a limit order with a specific price.',
          400,
        );
      }

      // Price staleness detection: reject trades on stale quotes
      if (quote?.timestamp) {
        const quoteAge = Date.now() - new Date(quote.timestamp).getTime();
        const MAX_QUOTE_AGE_MS = 5 * 60 * 1000; // 5 minutes
        if (quoteAge > MAX_QUOTE_AGE_MS) {
          throw new TradeError(
            `Price for ${input.symbol} is stale (${Math.round(quoteAge / 1000)}s old). ` +
            'Cannot place market order with outdated price data. Retry or use a limit order.',
            400,
          );
        }
      }
    }

    // ── Risk gate — FAILS CLOSED ──────────────────────────────────────────
    try {
      const orderValue = fillPrice * input.qty;

      const targetRisk = await this.riskService.enforceTargetRisk(userId, orderValue, input.symbol, input.side);
      if (!targetRisk.allowed) {
        throw new TradeError(`Risk gate blocked: ${targetRisk.violations.join('; ')}`, 400);
      }

      const positionRisk = await this.riskService.preTradeCheck(userId, input.symbol, input.side, input.qty, fillPrice);
      if (!positionRisk.allowed) {
        throw new TradeError(`Risk check failed: ${positionRisk.violations.join('; ')}`, 400);
      }
    } catch (err) {
      if (err instanceof TradeError) throw err;
      // Fail CLOSED. This previously logged 'Risk check error (non-blocking)'
      // and let the order through, so a transient DB or Redis fault disabled
      // every position, concentration and drawdown limit at once — silently.
      // An order we cannot risk-assess is an order we must not place.
      log.error({ err, userId, symbol: input.symbol, qty: input.qty, side: input.side },
        'Risk gate could not be evaluated — REJECTING order');
      throw new TradeError('Risk checks could not be evaluated — order rejected for safety.', 503);
    }

    // Auto-route large orders through TWAP to minimize market impact
    if (input.qty >= TWAP_AUTO_ROUTE_QTY_THRESHOLD && input.orderType === 'MARKET') {
      try {
        const quote = await this.marketData.getQuote(input.symbol, exchange);
        if (quote.ltp > 0) {
          const { selectOrderType } = await import('./twap-executor.service.js');
          const routing = selectOrderType({
            qty: input.qty,
            ltp: quote.ltp,
            avgDailyVolume: quote.volume ?? 500_000,
            confidence: 0.5,
            spreadPct: 0.05,
          });
          if (routing.orderType === 'TWAP' || routing.orderType === 'VWAP') {
            log.info({
              symbol: input.symbol, qty: input.qty, reason: routing.reason,
              estimatedImpactBps: routing.estimatedImpactBps,
              executionType: routing.orderType,
            }, `Auto-routing large order through ${routing.orderType}`);

            const twapConfig = {
              totalQty: input.qty,
              numSlices: TWAP_DEFAULT_SLICES,
              durationMinutes: TWAP_DEFAULT_DURATION_MIN,
              maxDeviationPct: TWAP_MAX_DEVIATION_PCT,
              symbol: input.symbol,
              side: input.side as 'BUY' | 'SELL',
              exchange,
              portfolioId: input.portfolioId,
              userId,
              strategyTag: input.strategyTag,
            };

            const twapExecutor = await this.getTwapExecutor();
            const twapResult = routing.orderType === 'VWAP'
              ? await twapExecutor.executeVWAP(twapConfig)
              : await twapExecutor.executeTWAP(twapConfig);
            if (twapResult.totalFilled > 0) {
              log.info({
                symbol: input.symbol,
                totalFilled: twapResult.totalFilled,
                avgPrice: twapResult.avgFillPrice,
                slippageBps: twapResult.slippageBps,
              }, `${routing.orderType} execution completed`);
            }
            return twapResult as any;
          }

          if (routing.orderType === 'POV') {
            const povExecutor = new POVExecutorService();
            povExecutor.setTradeService({ placeOrder: (uid, inp) => this.placeOrder(uid, inp) });
            povExecutor.setMarketData(this.marketData);
            const result = await povExecutor.execute({
              totalQty: input.qty, targetPct: 5, symbol: input.symbol,
              side: input.side as 'BUY' | 'SELL', exchange: input.exchange ?? 'NSE',
              portfolioId: input.portfolioId, userId,
              maxDurationMinutes: 60, pollIntervalMs: 10000, minSliceQty: 1,
              strategyTag: input.strategyTag,
            });
            log.info({ symbol: input.symbol, totalFilled: result.totalFilled, effectivePct: result.effectiveParticipationPct }, 'POV execution completed');
            return result as any;
          }

          if (routing.orderType === 'SNIPER') {
            const sniperExecutor = new SniperExecutorService();
            sniperExecutor.setTradeService({ placeOrder: (uid, inp) => this.placeOrder(uid, inp) });
            sniperExecutor.setMarketData(this.marketData);
            const result = await sniperExecutor.execute({
              totalQty: input.qty, symbol: input.symbol,
              side: input.side as 'BUY' | 'SELL', exchange: input.exchange ?? 'NSE',
              portfolioId: input.portfolioId, userId, depthThresholdMultiplier: 3.0,
              maxDurationMinutes: 120, pollIntervalMs: 5000, maxSlicePct: 30,
              strategyTag: input.strategyTag,
            });
            log.info({ symbol: input.symbol, totalFilled: result.totalFilled, opportunities: result.opportunitiesTaken }, 'Sniper execution completed');
            return result as any;
          }

          if (routing.orderType === 'IS') {
            const isExecutor = new ISExecutorService();
            isExecutor.setTradeService({ placeOrder: (uid, inp) => this.placeOrder(uid, inp) });
            isExecutor.setMarketData(this.marketData);
            const avgDailyVolume = quote.volume ?? 100000;
            const result = await isExecutor.execute({
              totalQty: input.qty, symbol: input.symbol, side: input.side as 'BUY' | 'SELL',
              exchange, portfolioId: input.portfolioId, userId,
              decisionPrice: quote.ltp, urgency: 0.8, avgDailyVolume,
              durationMinutes: 30, strategyTag: input.strategyTag,
            });
            log.info({ symbol: input.symbol, totalFilled: result.totalFilled, shortfallBps: result.totalShortfallBps }, 'IS execution completed');
            return result as any;
          }

          if (routing.orderType === 'ICEBERG') {
            const icebergExecutor = new IcebergExecutor();
            icebergExecutor.setTradeService({ placeOrder: (uid, inp) => this.placeOrder(uid, inp) });
            const result = await icebergExecutor.execute({
              totalQty: input.qty, showQty: Math.max(1, Math.floor(input.qty / 5)),
              randomizePct: 20, symbol: input.symbol, side: input.side as 'BUY' | 'SELL',
              exchange, portfolioId: input.portfolioId, userId,
              price: input.price, strategyTag: input.strategyTag,
              maxDurationMinutes: 60, pollIntervalMs: 5000,
            });
            log.info({ symbol: input.symbol, totalFilled: result.totalFilled }, 'Iceberg execution completed');
            return result as any;
          }
        }
      } catch (err) {
        log.warn({ err, symbol: input.symbol }, 'TWAP auto-routing check failed, falling back to normal execution');
      }
    }

    // fillPrice was resolved above, before the risk gate.
    let brokerOrderId: string | undefined;
    let effectiveQty = input.qty;
    let execSimResult: ExecutionSimulation | undefined;

    if (this.isLiveMode()) {
      const liveResult = await this.executeLiveOrder(input);
      brokerOrderId = liveResult.brokerOrderId;

      if (this.broker && liveResult.orderId) {
        const terminalStates = new Set(['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED']);
        const POLL_INTERVAL_MS = 2000;
        const MAX_POLLS = 15;

        for (let poll = 0; poll < MAX_POLLS; poll++) {
          const status = await this.broker.getOrderStatus(liveResult.orderId);
          if (status.avgPrice > 0) fillPrice = status.avgPrice;
          if (status.filledQty > 0) effectiveQty = status.filledQty;

          if (terminalStates.has(status.status)) {
            if (status.status === 'REJECTED' || status.status === 'CANCELLED') {
              throw new TradeError(
                `Broker ${status.status.toLowerCase()} the order: ${status.message ?? 'Unknown reason'}`,
                400,
              );
            }
            break;
          }

          if (poll < MAX_POLLS - 1) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
          }
        }
      }
    } else {
      const execSim = simulateExecution(fillPrice, input.qty, input.side as 'BUY' | 'SELL', exchange, input.orderType);
      execSimResult = execSim;
      fillPrice = execSim.fillPrice;
      effectiveQty = execSim.filledQty;
    }

    const instrumentKind = resolveInstrumentKind(exchange, input.symbol, input.optionType);
    const costs = calculateCosts(effectiveQty, fillPrice, input.side, exchange, instrumentKind);

    // Capital checks must use the quantity we will actually be charged for
    // (effectiveQty), not the requested qty — see handleFill below.
    const fullValue = fillPrice * effectiveQty + costs.totalCost;
    let availableCash = Number(portfolio.currentNav);

    // STRICT: Total invested + new order must never exceed declared capital
    if (input.side === 'BUY') {
      const existingShort = await this.prisma.position.findFirst({
        where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'SHORT', status: 'OPEN' },
      });
      if (!existingShort) {
        // Futures are bought on margin; everything else is paid for in full.
        input.underlyingSpot = await this.underlyingSpot(input);
        input.marginPlan = await this.planMargin(input, fillPrice, effectiveQty);
        const totalValue = input.marginPlan
          ? input.marginPlan.perUnit * effectiveQty + costs.totalCost
          : fullValue;
        ({ availableCash, declaredCapital } = await this.autoTopUp(portfolio, input, totalValue, availableCash, declaredCapital, totalInvested));
        if (totalValue > availableCash) {
          throw new TradeError(
            `Insufficient capital. Need ₹${totalValue.toFixed(0)} but only ₹${availableCash.toFixed(0)} available. ${CAPITAL_HINT}`,
            400,
          );
        }
        if (totalInvested + totalValue > declaredCapital * 1.0) {
          throw new TradeError(
            `STRICT: This order (₹${totalValue.toFixed(0)}) would push total invested (₹${totalInvested.toFixed(0)}) ` +
            `beyond declared capital of ₹${declaredCapital.toFixed(0)}. Not a single rupee more.`,
            400,
          );
        }
      }
    } else {
      const existingLong = await this.prisma.position.findFirst({
        where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'LONG', status: 'OPEN' },
      });
      if (existingLong) {
        // Selling an option that protects a sold one leaves that one unprotected:
        // the extra margin must be there before the sale is accepted.
        input.underlyingSpot = await this.underlyingSpot(input);
        const extra = await this.dependentsShortfall(existingLong.id, input.underlyingSpot);
        if (extra > 0) {
          ({ availableCash, declaredCapital } = await this.autoTopUp(portfolio, input, extra, availableCash, declaredCapital, totalInvested));
          if (extra > availableCash) {
            throw new TradeError(
              `This position protects another one you have sold. Selling it needs ₹${extra.toFixed(0)} more margin and only ₹${availableCash.toFixed(0)} is free. Close the sold position first. ${CAPITAL_HINT}`,
              400,
            );
          }
        }
      }
      if (!existingLong) {
        input.underlyingSpot = await this.underlyingSpot(input);
        input.marginPlan = await this.planMargin(input, fillPrice, effectiveQty);
        const marginRequired = (input.marginPlan?.perUnit ?? legacyShortMargin(fillPrice, 1, exchange)) * effectiveQty + costs.totalCost;
        ({ availableCash, declaredCapital } = await this.autoTopUp(portfolio, input, marginRequired, availableCash, declaredCapital, totalInvested));
        if (marginRequired > availableCash) {
          throw new TradeError(
            `Insufficient margin for short. Need ₹${marginRequired.toFixed(0)} but only ₹${availableCash.toFixed(0)} available. ${CAPITAL_HINT}`,
            400,
          );
        }
        if (totalInvested + marginRequired > declaredCapital * 1.0) {
          throw new TradeError(
            `STRICT: Short margin (₹${marginRequired.toFixed(0)}) would push total utilization (₹${totalInvested.toFixed(0)}) ` +
            `beyond declared capital of ₹${declaredCapital.toFixed(0)}. Not a single rupee more.`,
            400,
          );
        }
      }
    }

    // Always create as PENDING — OMS drives the lifecycle
    // Fill in the reservation made above, or create the row outright when no
    // idempotency key was supplied.
    const orderData = {
        clientOrderId: input.clientOrderId ?? null,
        portfolioId: input.portfolioId,
        instrumentToken: input.instrumentToken,
        symbol: input.symbol,
        exchange,
        orderType: input.orderType,
        side: input.side,
        qty: input.qty,
        price: fillPrice > 0 ? fillPrice : input.price,
        triggerPrice: input.triggerPrice,
        status: 'PENDING',
        filledQty: 0,
        avgFillPrice: null,
        ...costs,
        ...contract,
        idealPrice: execSimResult?.idealPrice,
        slippageBps: execSimResult?.slippageBps,
        fillLatencyMs: execSimResult ? Math.round(execSimResult.latencyMs) : null,
        spreadCostBps: execSimResult ? Math.round(execSimResult.spreadCost * 10000 / (execSimResult.idealPrice * input.qty || 1)) : null,
        impactCost: execSimResult?.impactCost,
        brokerOrderId: brokerOrderId ?? null,
        filledAt: null,
    };

    const order = reservedOrderId
      ? await this.prisma.order.update({ where: { id: reservedOrderId }, data: orderData })
      : await this.prisma.order.create({ data: orderData });

    MetricsService.getInstance().recordOrderPlaced(input.side, input.orderType, TRADING_MODE);

    emit('execution', {
      type: 'ORDER_PLACED', userId, orderId: order.id,
      symbol: input.symbol, side: input.side, qty: input.qty, orderType: input.orderType,
    }).catch(err => log.error({ err, orderId: order.id }, 'Failed to emit ORDER_PLACED event'));

    // Transition PENDING → SUBMITTED via OMS
    if (this.oms) {
      await this.oms.submitOrder(order.id);
    } else {
      await this.prisma.order.update({ where: { id: order.id }, data: { status: 'SUBMITTED' } });
    }

    if (input.orderType === 'MARKET' && fillPrice > 0 && effectiveQty > 0) {
      // Transition SUBMITTED → FILLED via OMS
      if (this.oms) {
        await this.oms.recordFill(order.id, effectiveQty, fillPrice);
      } else {
        await this.prisma.order.update({
          where: { id: order.id },
          data: { status: 'FILLED', filledQty: effectiveQty, avgFillPrice: fillPrice, filledAt: new Date() },
        });
      }

      await this.handleFill(order.id, input, fillPrice, costs, effectiveQty);

      emit('execution', {
        type: 'ORDER_FILLED', userId, orderId: order.id,
        symbol: input.symbol, fillPrice, qty: effectiveQty,
        slippageBps: execSimResult?.slippageBps ?? 0,
      }).catch(err => log.error({ err, orderId: order.id }, 'Failed to emit ORDER_FILLED event'));

      this.smartRouter.recordFillQuality(exchange, execSimResult?.slippageBps ?? 0);

      if (execSimResult) {
        MetricsService.getInstance().recordLatency(execSimResult.latencyMs);
        this.executionEngine.getLatencyStats();
      }

      wsHub.broadcastTradeExecution(userId, {
        symbol: input.symbol,
        side: input.side,
        qty: effectiveQty,
        price: fillPrice,
      });
    }

    // Re-read order to get final state after OMS transitions
    const finalOrder = await this.prisma.order.findUnique({ where: { id: order.id } });
    return { ...(finalOrder ?? order), brokerOrderId, tradingMode: TRADING_MODE };

    } catch (err) {
      // An abandoned reservation must not be left PENDING: matchPendingOrders
      // sweeps every PENDING order and would fill an order this call rejected.
      // REJECTED is terminal, so the matcher ignores it while the idempotency
      // record survives — a retry with the same key sees the same outcome.
      if (reservedOrderId) {
        await this.prisma.order.update({
          where: { id: reservedOrderId },
          data: { status: 'REJECTED' },
        }).catch(e => log.error({ err: e, reservedOrderId },
          'Failed to release order reservation — it may be left PENDING and picked up by the matcher'));
      }
      throw err;
    } finally {
      if (redis) await redis.del(lockKey).catch(() => {});
    }
  }

  /**
   * Contract identity columns for an order, position or trade row.
   *
   * Explicit input wins over the symbol: order placement knows the contract and
   * passes expiry/strike/optionType directly. The symbol is the fallback for
   * callers carrying nothing else, and it is trustworthy only because every
   * writer now builds it through lib/instrument.ts.
   *
   * Two vocabularies are deliberately kept apart here. `instrumentType` is
   * contract IDENTITY (EQUITY | FUTURES | OPTIONS). `resolveInstrumentKind` in
   * lib/costs.ts is a COST classification that intentionally reports MCX as
   * 'EQUITY' because commodities have their own charge branch. Merging the two
   * would silently apply NFO option STT to a commodity trade.
   */
  private contractFields(input: {
    symbol: string;
    exchange?: string;
    expiry?: string;
    strike?: number;
    optionType?: 'CE' | 'PE';
    lotSize?: number;
    product?: string;
  }) {
    let spec: InstrumentSpec | null = null;
    try {
      spec = parseInstrumentSymbol(input.symbol, input.exchange);
    } catch {
      // Unparseable symbol: fall back to whatever the caller supplied rather
      // than failing the order. Equity symbols never reach the throw path.
      spec = null;
    }

    const exchange = (input.exchange ?? spec?.exchange ?? 'NSE').toUpperCase();
    const optionType = input.optionType ?? spec?.optionType ?? null;
    const instrumentType = optionType ? 'OPTIONS' : (spec?.instrumentType ?? 'EQUITY');

    let expiry: Date | null = spec?.expiry ?? null;
    if (input.expiry) {
      try {
        expiry = expiryToDate(input.expiry);
      } catch (err) {
        throw new TradeError(`Invalid expiry "${input.expiry}": ${(err as Error).message}`, 400);
      }
    }

    return {
      segment: segmentForExchange(exchange),
      instrumentType,
      underlying: spec?.underlying ?? input.symbol.trim().toUpperCase(),
      expiry,
      strike: input.strike ?? spec?.strike ?? null,
      optionType,
      lotSize: input.lotSize ?? null,
      product: input.product ?? null,
    };
  }

  /**
   * Contract identity copied from the position being closed, so a Trade row can
   * never disagree with the Position it came from. Positions opened before the
   * derivative columns existed yield nulls — which is the honest answer, and the
   * backfill script is what fills those in.
   */
  private contractFieldsFromPosition(position: {
    segment?: string | null;
    instrumentType?: string | null;
    underlying?: string | null;
    expiry?: Date | null;
    strike?: unknown;
    optionType?: string | null;
    lotSize?: number | null;
    product?: string | null;
  }) {
    return {
      segment: position.segment ?? null,
      instrumentType: position.instrumentType ?? null,
      underlying: position.underlying ?? null,
      expiry: position.expiry ?? null,
      strike: (position.strike ?? null) as never,
      optionType: position.optionType ?? null,
      lotSize: position.lotSize ?? null,
      product: position.product ?? null,
    };
  }

  /**
   * Add capital when an order the user placed themselves needs more than the
   * portfolio has, if the portfolio allows it (see lib/capital.ts: ₹50,000
   * steps, never beyond ₹50 lakh in total). Bots and the AI agent never
   * trigger it: how much money they may use is the user's decision.
   */
  private async autoTopUp(
    portfolio: { id: string; userId: string; autoTopUp?: boolean | null },
    input: { strategyTag?: string; symbol: string },
    need: number, cash: number, capital: number, invested: number,
  ): Promise<{ availableCash: number; declaredCapital: number }> {
    const same = { availableCash: cash, declaredCapital: capital };
    const shortfall = Math.max(need - cash, invested + need - capital);
    const byUser = !input.strategyTag || /^(STRAT:|STRATEGY$|MANUAL)/.test(input.strategyTag);
    if (shortfall <= 0 || !byUser || portfolio.autoTopUp === false) return same;
    const amount = autoTopUpAmount(capital, shortfall);
    if (amount <= 0) return same;
    await this.prisma.portfolio.update({
      where: { id: portfolio.id },
      data: { initialCapital: { increment: amount }, currentNav: { increment: amount }, autoToppedUp: { increment: amount } },
    });
    log.info({ portfolioId: portfolio.id, amount, capital: capital + amount, symbol: input.symbol }, 'Capital topped up automatically for an order');
    await this.prisma.notification.create({
      data: {
        userId: portfolio.userId, type: 'info', title: 'Capital added automatically',
        message: `₹${amount.toLocaleString('en-IN')} was added so your ${input.symbol} order could go through. ` +
          `Capital is now ₹${(capital + amount).toLocaleString('en-IN')} (automatic limit ₹${AUTO_TOPUP_LIMIT.toLocaleString('en-IN')}). Profit and loss are unchanged.`,
      },
    }).catch(() => { /* the notice is a courtesy; the order must not fail on it */ });
    return { availableCash: cash + amount, declaredCapital: capital + amount };
  }

  private shortMarginRequired(price: number, qty: number, exchange: string): number {
    return legacyShortMargin(price, qty, exchange);
  }

  /** Price of the underlying for margin sums (options only); null when it cannot be had quickly. */
  private async underlyingSpot(input: PlaceOrderInput): Promise<number | null> {
    const c = this.contractFields(input);
    if (c.instrumentType !== 'OPTIONS' || !c.underlying) return null;
    try {
      const quote = await Promise.race([
        this.marketData.getQuote(c.underlying, isIndexUnderlying(c.underlying) || c.segment !== 'COM' ? 'NSE' : 'MCX'),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3_000)),
      ]);
      return Number(quote.ltp) > 0 ? Number(quote.ltp) : null;
    } catch {
      return null;
    }
  }

  /**
   * Margin for opening `qty` of this order (see lib/margin.ts), or null when
   * the order is simply paid for (buying shares or options).
   * A sold option is cheaper to hold when a bought option of the same type and
   * expiry protects it, or when it pairs with a sold option of the other type;
   * `linkId` records which position that is.
   */
  private async planMargin(input: PlaceOrderInput, price: number, qty: number, db?: any): Promise<MarginPlan | null> {
    const prisma = db ?? this.prisma;
    const exchange = (input.exchange ?? 'NSE').toUpperCase();
    const c = this.contractFields(input);
    if (c.instrumentType === 'FUTURES') {
      return { perUnit: futuresMargin(price, 1, exchange, c.underlying), linkId: null };
    }
    if (input.side !== 'SELL') return null;
    if (c.instrumentType !== 'OPTIONS' || !c.optionType || !c.strike) {
      return { perUnit: legacyShortMargin(price, 1, exchange), linkId: null };
    }

    const short = {
      underlying: c.underlying, exchange, optionType: c.optionType as 'CE' | 'PE', strike: Number(c.strike), qty,
      spot: input.underlyingSpot ?? null,
    };
    let best = { total: nakedOptionMargin(short), linkId: null as string | null };
    try {
      const related: any[] = await prisma.position.findMany({
        where: { portfolioId: input.portfolioId, status: 'OPEN', underlying: c.underlying, expiry: c.expiry, instrumentType: 'OPTIONS' },
      });
      // How much of each position already supports another one.
      const used = new Map<string, number>();
      for (const p of related) if (p.marginLinkId) used.set(p.marginLinkId, (used.get(p.marginLinkId) ?? 0) + p.qty);
      for (const p of related) {
        if (p.qty - (used.get(p.id) ?? 0) < qty) continue;
        let total: number | null = null;
        if (p.side === 'LONG' && p.optionType === c.optionType) total = spreadMargin(short, Number(p.strike));
        else if (p.side === 'SHORT' && p.optionType !== c.optionType && !p.marginLinkId && p.marginBlocked != null) total = exposureMargin(short);
        if (total != null && total < best.total) best = { total, linkId: p.id };
      }
    } catch { /* no related positions readable: the unprotected figure stands */ }
    return { perUnit: best.total / qty, linkId: best.linkId };
  }

  /** Open sold options whose margin was lowered by `positionId`, with what each needs once it is gone. */
  private async dependents(positionId: string, spot: number | null | undefined, db?: any) {
    const prisma = db ?? this.prisma;
    let rows: any[] = [];
    try {
      rows = await prisma.position.findMany({ where: { marginLinkId: positionId, status: 'OPEN' } });
    } catch { return []; }
    return (rows ?? []).map((d: any) => {
      const naked = d.optionType && d.strike != null
        ? nakedOptionMargin({ underlying: d.underlying, exchange: d.exchange, optionType: d.optionType, strike: Number(d.strike), qty: d.qty, spot: spot ?? null })
        : Number(d.marginBlocked ?? 0);
      return { id: d.id as string, extra: Math.max(0, naked - Number(d.marginBlocked ?? 0)) };
    });
  }

  private async dependentsShortfall(positionId: string, spot: number | null | undefined): Promise<number> {
    return (await this.dependents(positionId, spot)).reduce((sum, d) => sum + d.extra, 0);
  }

  /**
   * `positionId` is closing: the sold options it protected now stand alone, so
   * raise their margin to the unprotected figure and take it from cash.
   */
  private async releaseMarginLinks(portfolioId: string, positionId: string, spot: number | null | undefined, db?: any): Promise<void> {
    const prisma = db ?? this.prisma;
    const deps = await this.dependents(positionId, spot, prisma);
    let total = 0;
    for (const d of deps) {
      await prisma.position.update({ where: { id: d.id }, data: { marginLinkId: null, marginBlocked: { increment: d.extra } } });
      total += d.extra;
    }
    if (total > 0) {
      const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
      if (portfolio) await this.safeUpdateNav(portfolioId, Number(portfolio.currentNav), -total, prisma);
      log.info({ portfolioId, positionId, extra: total }, 'Protection closed: margin raised on the sold options it covered');
    }
  }

  /**
   * Apply a cash delta to portfolio NAV.
   *
   * The write is an atomic `increment`, not a read-modify-write: two fills
   * settling concurrently (e.g. the bot engine and a manual order, or two
   * different symbols — the Redis order lock is per portfolio+symbol) would
   * otherwise both read the same NAV and the second would silently discard
   * the first one's delta.
   *
   * `currentNav` is used only for validation and logging; it is not written.
   */
  private async safeUpdateNav(portfolioId: string, currentNav: number, delta: number, db?: any): Promise<void> {
    const prisma = db ?? this.prisma;
    if (!isFinite(delta) || isNaN(delta)) {
      log.error({ currentNav, delta, portfolioId }, 'CRITICAL: NAV delta is not a finite number');
      throw new TradeError(`P&L calculation produced invalid NAV. Trade aborted.`, 500);
    }
    const projectedNav = currentNav + delta;
    if (!isFinite(projectedNav) || isNaN(projectedNav)) {
      log.error({ currentNav, delta, projectedNav }, 'CRITICAL: NAV update would produce invalid value');
      throw new TradeError(`P&L calculation produced invalid NAV. Trade aborted.`, 500);
    }
    if (projectedNav < 0) {
      log.warn({ currentNav, delta, projectedNav, portfolioId }, 'NAV going negative — margin overdraft in paper trading, allowing it');
    }
    await prisma.portfolio.update({
      where: { id: portfolioId },
      data: { currentNav: { increment: delta } },
    });
  }

  /**
   * Apply a fill to positions and cash.
   *
   * `filledQty` is the quantity actually filled, which may be less than
   * `input.qty` on a partial fill (broker partial in LIVE mode, or the fill
   * simulator in PAPER mode). Positions and NAV must move by the filled
   * quantity, never the requested one, or the order row and the position
   * disagree and cash is debited for shares that were never bought.
   */
  private async handleFill(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
    filledQty: number,
  ) {
    if (filledQty <= 0) return;
    await this.prisma.$transaction(async (tx) => {
      if (input.side === 'BUY') {
        await this.handleBuyFill(orderId, input, fillPrice, costs, filledQty, tx);
      } else {
        await this.handleSellFill(orderId, input, fillPrice, costs, filledQty, tx);
      }
    });
  }

  private async handleBuyFill(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
    filledQty: number,
    db?: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
  ) {
    const prisma = db ?? this.prisma;
    // First check if there's a SHORT position to cover
    const existingShort = await prisma.position.findFirst({
      where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'SHORT', status: 'OPEN' },
    });

    if (existingShort) {
      const entryPrice = Number(existingShort.avgEntryPrice);
      const coverQty = Math.min(filledQty, existingShort.qty);
      const coverRatio = coverQty / filledQty;
      const exitCost = costs.totalCost * coverRatio;
      const entryCost = calculateCosts(
        coverQty, entryPrice, 'SELL', input.exchange ?? 'NSE',
        resolveInstrumentKind(input.exchange ?? 'NSE', input.symbol, input.optionType),
      ).totalCost;
      const grossPnl = (entryPrice - fillPrice) * coverQty;
      const roundTripCosts = exitCost + entryCost;
      const exitOnlyPnl = grossPnl - exitCost;
      const netPnl = grossPnl - roundTripCosts;

      await prisma.trade.create({
        data: {
          portfolioId: input.portfolioId,
          positionId: existingShort.id,
          symbol: input.symbol,
          exchange: input.exchange ?? 'NSE',
          side: 'BUY',
          entryPrice,
          exitPrice: fillPrice,
          qty: coverQty,
          grossPnl,
          totalCosts: roundTripCosts,
          netPnl,
          entryTime: existingShort.openedAt,
          exitTime: new Date(),
          strategyTag: input.strategyTag,
          ...this.contractFieldsFromPosition(existingShort),
        },
      });

      const remainingQty = existingShort.qty - coverQty;
      const prevRealized = Number(existingShort.realizedPnl ?? 0);
      const cumulativeRealized = prevRealized + netPnl;
      // Release exactly what was blocked for the covered part (the old flat
      // rule for positions opened before margins were stored).
      const stored = existingShort.marginBlocked != null ? Number(existingShort.marginBlocked) : null;
      const marginReleased = stored != null
        ? stored * (coverQty / existingShort.qty)
        : this.shortMarginRequired(entryPrice, coverQty, input.exchange ?? 'NSE');
      if (remainingQty <= 0) {
        await prisma.position.update({
          where: { id: existingShort.id },
          data: { status: 'CLOSED', realizedPnl: cumulativeRealized, closedAt: new Date() },
        });
        await this.releaseMarginLinks(input.portfolioId, existingShort.id, input.underlyingSpot, prisma);
      } else {
        await prisma.position.update({
          where: { id: existingShort.id },
          data: { qty: remainingQty, realizedPnl: cumulativeRealized, ...(stored != null ? { marginBlocked: stored - marginReleased } : {}) },
        });
      }

      const portfolio = await prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
      if (portfolio) {
        const cashChange = marginReleased + exitOnlyPnl;
        await this.safeUpdateNav(input.portfolioId, Number(portfolio.currentNav), cashChange, prisma);
      }

      await prisma.order.update({ where: { id: orderId }, data: { positionId: existingShort.id } });

      const excessQty = filledQty - coverQty;
      if (excessQty > 0) {
        const excessRatio = excessQty / filledQty;
        const excessCosts = { ...costs, totalCost: costs.totalCost * excessRatio };
        await this.openLongPosition(orderId, input, fillPrice, excessCosts, excessQty, prisma);
      }
      return;
    }

    await this.openLongPosition(orderId, input, fillPrice, costs, filledQty, prisma);
  }

  private async openLongPosition(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
    qty: number,
    db?: any,
  ) {
    const prisma = db ?? this.prisma;
    const existingLong = await prisma.position.findFirst({
      where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'LONG', status: 'OPEN' },
    });

    // Futures are bought on margin (the plan); shares and options are paid in full (no plan).
    const plan = input.marginPlan !== undefined ? input.marginPlan : await this.planMargin(input, fillPrice, qty, prisma);
    const margin = plan ? plan.perUnit * qty : null;

    if (existingLong) {
      const oldQty = existingLong.qty;
      const oldAvg = Number(existingLong.avgEntryPrice);
      const newQty = oldQty + qty;
      const newAvg = (oldAvg * oldQty + fillPrice * qty) / newQty;

      await prisma.position.update({
        where: { id: existingLong.id },
        data: {
          qty: newQty, avgEntryPrice: newAvg,
          // Added to a margined position only; one bought outright before stays paid in full.
          ...(margin != null && existingLong.marginBlocked != null ? { marginBlocked: Number(existingLong.marginBlocked) + margin } : {}),
        },
      });
      await prisma.order.update({ where: { id: orderId }, data: { positionId: existingLong.id } });
    } else {
      const position = await prisma.position.create({
        data: {
          portfolioId: input.portfolioId,
          instrumentToken: input.instrumentToken,
          symbol: input.symbol,
          exchange: input.exchange ?? 'NSE',
          qty,
          avgEntryPrice: fillPrice,
          side: 'LONG',
          strategyTag: input.strategyTag,
          stopLoss: input.stopLoss ?? null,
          target: input.target ?? null,
          ...(margin != null ? { marginBlocked: margin } : {}),
          ...this.contractFields(input),
        },
      });
      await prisma.order.update({ where: { id: orderId }, data: { positionId: position.id } });
    }

    const portfolio = await prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
    if (portfolio) {
      const onMargin = margin != null && (!existingLong || existingLong.marginBlocked != null);
      const purchaseCost = (onMargin ? margin! : fillPrice * qty) + costs.totalCost;
      await this.safeUpdateNav(input.portfolioId, Number(portfolio.currentNav), -purchaseCost, prisma);
    }
  }

  private async handleSellFill(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
    filledQty: number,
    db?: any,
  ) {
    const prisma = db ?? this.prisma;
    const existingLong = await prisma.position.findFirst({
      where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'LONG', status: 'OPEN' },
    });

    if (existingLong) {
      const entryPrice = Number(existingLong.avgEntryPrice);
      const closeQty = Math.min(filledQty, existingLong.qty);
      const closeRatio = closeQty / filledQty;
      const exitCost = costs.totalCost * closeRatio;
      const entryCost = calculateCosts(
        closeQty, entryPrice, 'BUY', input.exchange ?? 'NSE',
        resolveInstrumentKind(input.exchange ?? 'NSE', input.symbol, input.optionType),
      ).totalCost;
      const grossPnl = (fillPrice - entryPrice) * closeQty;
      const roundTripCosts = exitCost + entryCost;
      const netPnl = grossPnl - roundTripCosts;

      await prisma.trade.create({
        data: {
          portfolioId: input.portfolioId,
          positionId: existingLong.id,
          symbol: input.symbol,
          exchange: input.exchange ?? 'NSE',
          side: 'SELL',
          entryPrice,
          exitPrice: fillPrice,
          qty: closeQty,
          grossPnl,
          totalCosts: roundTripCosts,
          netPnl,
          entryTime: existingLong.openedAt,
          exitTime: new Date(),
          strategyTag: input.strategyTag,
          ...this.contractFieldsFromPosition(existingLong),
        },
      });

      const remainingQty = existingLong.qty - closeQty;
      const prevRealized = Number(existingLong.realizedPnl ?? 0);
      const cumulativeRealized = prevRealized + netPnl;
      const stored = existingLong.marginBlocked != null ? Number(existingLong.marginBlocked) : null;
      const marginReleased = stored != null ? stored * (closeQty / existingLong.qty) : 0;
      if (remainingQty <= 0) {
        await prisma.position.update({
          where: { id: existingLong.id },
          data: { status: 'CLOSED', realizedPnl: cumulativeRealized, closedAt: new Date() },
        });
      } else {
        await prisma.position.update({
          where: { id: existingLong.id },
          data: { qty: remainingQty, realizedPnl: cumulativeRealized, ...(stored != null ? { marginBlocked: stored - marginReleased } : {}) },
        });
      }
      // Whatever this position protected now stands alone.
      await this.releaseMarginLinks(input.portfolioId, existingLong.id, input.underlyingSpot, prisma);

      const portfolio = await prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
      if (portfolio) {
        // Paid in full: the sale proceeds come back. On margin (futures): the margin and the gain or loss.
        const saleProceeds = stored != null
          ? marginReleased + grossPnl - exitCost
          : fillPrice * closeQty - exitCost;
        await this.safeUpdateNav(input.portfolioId, Number(portfolio.currentNav), saleProceeds, prisma);
      }

      await prisma.order.update({ where: { id: orderId }, data: { positionId: existingLong.id } });

      const excessQty = filledQty - closeQty;
      if (excessQty > 0) {
        const excessRatio = excessQty / filledQty;
        const excessCosts = { ...costs, totalCost: costs.totalCost * excessRatio };
        await this.openShortPosition(orderId, input, fillPrice, excessCosts, excessQty, prisma);
      }
      return;
    }

    await this.openShortPosition(orderId, input, fillPrice, costs, filledQty, prisma);
  }

  private async openShortPosition(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
    qty: number,
    db?: any,
  ) {
    if (fillPrice <= 0) {
      throw new TradeError('Cannot open SHORT with invalid fill price', 400);
    }

    const prisma = db ?? this.prisma;
    const existingShort = await prisma.position.findFirst({
      where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'SHORT', status: 'OPEN' },
    });
    const plan = input.marginPlan ?? await this.planMargin({ ...input, side: 'SELL' }, fillPrice, qty, prisma);
    const marginBlocked = (plan?.perUnit ?? this.shortMarginRequired(fillPrice, 1, input.exchange ?? 'NSE')) * qty;

    const MAX_SHORT_QTY = 10_000;

    if (existingShort) {
      const oldQty = existingShort.qty;
      const oldAvg = Number(existingShort.avgEntryPrice);
      const newQty = oldQty + qty;

      if (newQty > MAX_SHORT_QTY) {
        throw new TradeError(`SHORT qty ${newQty} would exceed max ${MAX_SHORT_QTY} for ${input.symbol}`, 400);
      }

      const newAvg = (oldAvg * oldQty + fillPrice * qty) / newQty;

      await prisma.position.update({
        where: { id: existingShort.id },
        data: {
          qty: newQty, avgEntryPrice: newAvg,
          marginBlocked: (existingShort.marginBlocked != null
            ? Number(existingShort.marginBlocked)
            : this.shortMarginRequired(oldAvg, oldQty, input.exchange ?? 'NSE')) + marginBlocked,
        },
      });
      await prisma.order.update({ where: { id: orderId }, data: { positionId: existingShort.id } });
    } else {
      if (qty > MAX_SHORT_QTY) {
        throw new TradeError(`SHORT qty ${qty} would exceed max ${MAX_SHORT_QTY} for ${input.symbol}`, 400);
      }
      const position = await prisma.position.create({
        data: {
          portfolioId: input.portfolioId,
          instrumentToken: input.instrumentToken,
          symbol: input.symbol,
          exchange: input.exchange ?? 'NSE',
          qty,
          avgEntryPrice: fillPrice,
          side: 'SHORT',
          strategyTag: input.strategyTag,
          stopLoss: input.stopLoss ?? null,
          target: input.target ?? null,
          marginBlocked,
          marginLinkId: plan?.linkId ?? null,
          ...this.contractFields(input),
        },
      });
      await prisma.order.update({ where: { id: orderId }, data: { positionId: position.id } });
    }

    const portfolio = await prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
    if (portfolio) {
      const cashChange = -(marginBlocked + costs.totalCost);
      await this.safeUpdateNav(input.portfolioId, Number(portfolio.currentNav), cashChange, prisma);
    }
  }

  async cancelOrder(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { portfolio: true },
    });

    if (!order || order.portfolio.userId !== userId) {
      throw new TradeError('Order not found', 404);
    }

    if (order.status !== 'PENDING' && order.status !== 'SUBMITTED') {
      throw new TradeError('Only pending/submitted orders can be cancelled', 400);
    }

    if (this.oms) {
      await this.oms.cancelOrder(orderId, `User ${userId} requested cancellation`);
      return this.prisma.order.findUnique({ where: { id: orderId } });
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });
  }

  async listOrders(userId: string, params: { status?: string; page?: number; limit?: number } = {}) {
    const { status, page = 1, limit: rawLimit = 50 } = params;
    const limit = Math.min(Math.max(1, rawLimit), 200);

    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    const portfolioIds = portfolios.map((p) => p.id);

    const where: any = { portfolioId: { in: portfolioIds } };
    if (status) where.status = status;

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return { orders, total, page, limit };
  }

  async getOrder(orderId: string, userId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { portfolio: true },
    });

    if (!order || order.portfolio.userId !== userId) {
      throw new TradeError('Order not found', 404);
    }

    return order;
  }

  async listPositions(userId: string, strategyTag?: string) {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    const portfolioIds = portfolios.map((p) => p.id);

    const where: any = { portfolioId: { in: portfolioIds }, status: 'OPEN' };
    if (strategyTag) where.strategyTag = strategyTag;

    return this.prisma.position.findMany({
      where,
      orderBy: { openedAt: 'desc' },
    });
  }

  async listActiveStrategies(userId: string) {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    const portfolioIds = portfolios.map((p) => p.id);

    const positions = await this.prisma.position.findMany({
      where: {
        portfolioId: { in: portfolioIds },
        status: 'OPEN',
        strategyTag: { not: null },
      },
      orderBy: { openedAt: 'desc' },
    });

    const grouped: Record<string, {
      strategyTag: string;
      legs: typeof positions;
      realizedPnl: number;
      unrealizedPnl: number;
      deployedAt: Date;
    }> = {};

    for (const pos of positions) {
      const tag = pos.strategyTag!;
      if (!grouped[tag]) {
        grouped[tag] = { strategyTag: tag, legs: [], realizedPnl: 0, unrealizedPnl: 0, deployedAt: pos.openedAt };
      }
      grouped[tag].legs.push(pos);
      grouped[tag].realizedPnl += Number(pos.realizedPnl ?? 0);
      grouped[tag].unrealizedPnl += Number(pos.unrealizedPnl ?? 0);
      if (pos.openedAt < grouped[tag].deployedAt) {
        grouped[tag].deployedAt = pos.openedAt;
      }
    }

    return Object.values(grouped);
  }

  async exitStrategyLegs(userId: string, positionIds: string[]) {
    const results: { positionId: string; success: boolean; message: string; pnl?: number }[] = [];

    // Close the protected (sold) legs before the legs that protect them, so no
    // leg is ever left unprotected halfway through — the order a trader would use.
    try {
      const rows: any[] = await this.prisma.position.findMany({
        where: { id: { in: positionIds } }, select: { id: true, side: true, marginLinkId: true },
      });
      const rank = (id: string) => {
        const p = rows?.find((r) => r.id === id);
        return !p ? 1 : p.marginLinkId ? 0 : p.side === 'SHORT' ? 1 : 2;
      };
      positionIds = [...positionIds].sort((a, b) => rank(a) - rank(b));
    } catch { /* keep the given order */ }

    for (const posId of positionIds) {
      try {
        const position = await this.getPosition(posId, userId);
        if (position.status !== 'OPEN') {
          results.push({ positionId: posId, success: false, message: 'Already closed' });
          continue;
        }

        let exitPrice = 0;
        try {
          const quote = await this.marketData.getQuote(position.symbol, position.exchange);
          exitPrice = quote.ltp;
        } catch { /* fallback */ }

        if (exitPrice <= 0) {
          results.push({ positionId: posId, success: false, message: 'No price available' });
          continue;
        }

        const exitResult = await ExitCoordinator.closePosition({
          positionId: posId,
          userId,
          exitPrice,
          reason: 'Strategy leg exit',
          source: 'STRATEGY_LEG_EXIT',
          decisionType: 'EXIT_SIGNAL',
          prisma: this.prisma,
          tradeService: this,
          decisionAudit: new DecisionAuditService(this.prisma),
        });
        results.push({
          positionId: posId,
          success: exitResult.success,
          message: exitResult.success
            ? `${position.side === 'SHORT' ? 'Covered' : 'Sold'} ${position.qty} ${position.symbol} @ ₹${exitPrice.toFixed(2)}`
            : (exitResult.error ?? 'Exit failed'),
          pnl: exitResult.pnl,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({ positionId: posId, success: false, message: msg });
      }
    }

    const totalPnl = results.filter(r => r.pnl != null).reduce((s, r) => s + (r.pnl ?? 0), 0);
    return {
      closed: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      totalPnl,
      results,
    };
  }

  async getPosition(positionId: string, userId: string) {
    const position = await this.prisma.position.findUnique({
      where: { id: positionId },
      include: { portfolio: true },
    });

    if (!position || position.portfolio.userId !== userId) {
      throw new TradeError('Position not found', 404);
    }

    return position;
  }

  async closePosition(positionId: string, userId: string, exitPrice: number) {
    const position = await this.getPosition(positionId, userId);

    if (position.status !== 'OPEN') {
      throw new TradeError('Position is already closed', 400);
    }

    // Atomic check-and-close: only update if still OPEN (prevents TOCTOU double-close)
    const atomicClose = await this.prisma.position.updateMany({
      where: { id: positionId, status: 'OPEN' },
      data: { status: 'CLOSING' as any },
    });
    if (atomicClose.count === 0) {
      throw new TradeError('Position is already being closed by another process', 409);
    }

    // ── LIVE: the exit must happen at the broker BEFORE the books move ──────
    //
    // Everything below this point is pure bookkeeping — it creates an Order row
    // and marks it FILLED locally. Without this block, closing a position in
    // LIVE mode updated our records and left the position wide open at the
    // broker, with the divergence invisible until EOD reconciliation.
    if (this.isLiveMode()) {
      // Pull the resting protective stop first. If it fires on the same move we
      // would exit twice and end up inverted.
      try {
        await this.brokerStops.cancelStop(positionId);
      } catch (err) {
        log.error({ err, positionId }, 'Could not cancel protective stop before exit — proceeding, watch for a double exit');
      }

      try {
        const fill = await this.executeLiveExit(position);
        if (fill.avgPrice > 0) exitPrice = fill.avgPrice;
      } catch (err) {
        const indeterminate = err instanceof TradeError && err.statusCode === 504;
        if (indeterminate) {
          // The order may still be live at the broker. Leaving the position in
          // CLOSING keeps it out of both OPEN and CLOSED queries so nothing
          // re-enters or double-books it, but it needs a human.
          log.fatal({ positionId, symbol: position.symbol },
            'EXIT STATE UNKNOWN at broker — position left in CLOSING. Reconcile manually before trading this symbol.');
          throw err;
        }
        // Definite failure: nothing was executed. Put the position back so it
        // stays visible, protected and counted by risk.
        await this.prisma.position.updateMany({
          where: { id: positionId, status: 'CLOSING' as any },
          data: { status: 'OPEN' },
        });
        log.error({ err, positionId }, 'Broker rejected the exit — position restored to OPEN, books unchanged');
        throw err;
      }
    }

    const entryPrice = Number(position.avgEntryPrice);
    const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';
    const entrySide = position.side === 'LONG' ? 'BUY' : 'SELL';
    const grossPnl = position.side === 'LONG'
      ? (exitPrice - entryPrice) * position.qty
      : (entryPrice - exitPrice) * position.qty;
    const posKind = resolveInstrumentKind(position.exchange, position.symbol);
    const exitCosts = calculateCosts(position.qty, exitPrice, exitSide, position.exchange, posKind);
    const entryCosts = calculateCosts(position.qty, entryPrice, entrySide, position.exchange, posKind);
    const roundTripCosts = exitCosts.totalCost + entryCosts.totalCost;
    const exitOnlyPnl = grossPnl - exitCosts.totalCost;
    const netPnl = grossPnl - roundTripCosts;

    // Create an exit Order record so the close flows through OMS
    const exitOrder = await this.prisma.order.create({
      data: {
        portfolioId: position.portfolioId,
        instrumentToken: (position as any).instrumentToken ?? `${position.symbol}-EXIT`,
        symbol: position.symbol,
        exchange: position.exchange,
        orderType: 'MARKET',
        side: exitSide,
        qty: position.qty,
        price: exitPrice,
        status: 'PENDING',
        filledQty: 0,
        avgFillPrice: null,
        ...exitCosts,
      },
    });

    // OMS transitions: PENDING → SUBMITTED → FILLED
    if (this.oms) {
      await this.oms.submitOrder(exitOrder.id);
      await this.oms.recordFill(exitOrder.id, position.qty, exitPrice);
    } else {
      await this.prisma.order.update({
        where: { id: exitOrder.id },
        data: { status: 'FILLED', filledQty: position.qty, avgFillPrice: exitPrice, filledAt: new Date() },
      });
    }

    const trade = await this.prisma.trade.create({
      data: {
        portfolioId: position.portfolioId,
        positionId: position.id,
        symbol: position.symbol,
        exchange: position.exchange,
        side: exitSide,
        entryPrice,
        exitPrice,
        qty: position.qty,
        grossPnl,
        totalCosts: roundTripCosts,
        netPnl,
        entryTime: position.openedAt,
        exitTime: new Date(),
        strategyTag: position.strategyTag,
        ...this.contractFieldsFromPosition(position),
      },
    });

    const prevRealized = Number(position.realizedPnl ?? 0);
    const cumulativeRealized = prevRealized + netPnl;

    await this.prisma.position.update({
      where: { id: positionId },
      data: { status: 'CLOSED', realizedPnl: cumulativeRealized, closedAt: new Date() },
    });

    const portfolio = await this.prisma.portfolio.findUnique({ where: { id: position.portfolioId } });
    if (portfolio) {
      const stored = (position as any).marginBlocked != null ? Number((position as any).marginBlocked) : null;
      let cashChange: number;
      if (position.side === 'LONG') {
        // Paid in full: the sale proceeds. On margin (futures): the margin and the gain or loss.
        cashChange = stored != null ? stored + exitOnlyPnl : exitPrice * position.qty - exitCosts.totalCost;
      } else {
        const marginReleased = stored ?? this.shortMarginRequired(entryPrice, position.qty, position.exchange);
        cashChange = marginReleased + exitOnlyPnl;
      }
      // Sold options this position protected now stand alone: their margin goes up.
      const leaning = await this.dependents(position.id, null);
      if (leaning.length) {
        const spot = await this.underlyingSpot({ symbol: position.symbol, exchange: position.exchange } as PlaceOrderInput);
        await this.releaseMarginLinks(position.portfolioId, position.id, spot);
      }

      await this.safeUpdateNav(position.portfolioId, Number(portfolio.currentNav), cashChange);
    }

    emit('execution', {
      type: 'POSITION_CLOSED', userId, positionId,
      symbol: position.symbol, pnl: netPnl, exitPrice,
      strategyTag: position.strategyTag ?? undefined,
    }).catch(err => log.error({ err, positionId }, 'Failed to emit POSITION_CLOSED event'));

    return trade;
  }

  async listTrades(userId: string, params: { page?: number; limit?: number; fromDate?: string; toDate?: string; symbol?: string } = {}) {
    const { page = 1, limit: rawLimit = 50, fromDate, toDate, symbol } = params;
    const limit = Math.min(Math.max(1, rawLimit), 200);

    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    const portfolioIds = portfolios.map((p) => p.id);

    const where: any = { portfolioId: { in: portfolioIds } };
    if (symbol) where.symbol = symbol;
    if (fromDate || toDate) {
      where.exitTime = {};
      if (fromDate) where.exitTime.gte = new Date(fromDate);
      if (toDate) {
        const end = new Date(toDate);
        end.setHours(23, 59, 59, 999);
        where.exitTime.lte = end;
      }
    }

    const [trades, total] = await Promise.all([
      this.prisma.trade.findMany({
        where,
        orderBy: { exitTime: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.trade.count({ where }),
    ]);

    return { trades, total, page, limit };
  }

  async getTrade(tradeId: string, userId: string) {
    const trade = await this.prisma.trade.findUnique({
      where: { id: tradeId },
      include: { portfolio: true },
    });

    if (!trade || trade.portfolio.userId !== userId) {
      throw new TradeError('Trade not found', 404);
    }

    return trade;
  }

  /**
   * Match pending orders against current market prices.
   * - MARKET orders placed after hours: fill at current LTP when market opens
   * - LIMIT BUY orders: fill when LTP <= order price
   * - LIMIT SELL orders: fill when LTP >= order price
   */
  async matchPendingOrders(): Promise<{ matched: number; failed: number }> {
    if (!this.calendar.isMarketOpen()) return { matched: 0, failed: 0 };

    // The kill switch must stop fills, not just new orders.
    //
    // This sweep filled every resting PENDING/SUBMITTED order without consulting
    // it, so tripping the kill switch (or the daily-loss circuit breaker, which
    // fires on the same condition) stopped placement while the existing queue
    // kept converting into positions — exactly when the system had decided it
    // should not be trading.
    try {
      if (await isKillSwitchActive()) {
        log.warn({}, 'Kill switch active — pending-order matching skipped');
        return { matched: 0, failed: 0 };
      }
    } catch (err) {
      log.warn({ err }, 'Kill switch check failed during pending-order matching — proceeding');
    }

    const pendingOrders = await this.prisma.order.findMany({
      where: { status: { in: ['PENDING', 'SUBMITTED'] } },
      include: { portfolio: true },
      take: 50,
    });

    let matched = 0;
    let failed = 0;

    for (const order of pendingOrders) {
      try {
        let ltp = 0;
        try {
          const quote = await this.marketData.getQuote(order.symbol, order.exchange);
          ltp = quote.ltp;
        } catch { continue; }

        if (ltp <= 0) continue;

        const orderPrice = Number(order.price ?? 0);
        let shouldFill = false;

        if (order.orderType === 'MARKET') {
          // MARKET orders placed after hours -- fill at current LTP
          shouldFill = true;
        } else {
          // LIMIT orders -- check if price condition is met
          if (order.side === 'BUY' && ltp <= orderPrice) shouldFill = true;
          if (order.side === 'SELL' && ltp >= orderPrice) shouldFill = true;
        }

        if (!shouldFill) continue;

        const fillPrice = order.orderType === 'MARKET' ? ltp : orderPrice;
        const costs = calculateCosts(
          order.qty, fillPrice, order.side, order.exchange,
          resolveInstrumentKind(order.exchange, order.symbol),
        );

        // Re-validate capital
        const portfolio = await this.prisma.portfolio.findUnique({ where: { id: order.portfolioId } });
        if (!portfolio) continue;

        const totalValue = fillPrice * order.qty + costs.totalCost;
        const availableCash = Number(portfolio.currentNav);

        if (order.side === 'BUY') {
          const existingShort = await this.prisma.position.findFirst({
            where: { portfolioId: order.portfolioId, symbol: order.symbol, side: 'SHORT', status: 'OPEN' },
          });
          if (!existingShort && totalValue > availableCash) {
            if (this.oms) {
              await this.oms.rejectOrder(order.id, 'Insufficient capital for BUY');
            } else {
              await this.prisma.order.update({ where: { id: order.id }, data: { status: 'REJECTED' } });
            }
            failed++;
            continue;
          }
        } else {
          const existingLong = await this.prisma.position.findFirst({
            where: { portfolioId: order.portfolioId, symbol: order.symbol, side: 'LONG', status: 'OPEN' },
          });
          if (!existingLong) {
            const plan = await this.planMargin({
              portfolioId: order.portfolioId, symbol: order.symbol, side: 'SELL', orderType: order.orderType as any,
              qty: order.qty, instrumentToken: order.instrumentToken, exchange: order.exchange as any,
            }, fillPrice, order.qty).catch(() => null);
            const marginRequired = (plan?.perUnit ?? this.shortMarginRequired(fillPrice, 1, order.exchange)) * order.qty + costs.totalCost;
            if (marginRequired > availableCash) {
              if (this.oms) {
                await this.oms.rejectOrder(order.id, 'Insufficient margin for SELL');
              } else {
                await this.prisma.order.update({ where: { id: order.id }, data: { status: 'REJECTED' } });
              }
              failed++;
              continue;
            }
          }
        }

        // Fill the order via OMS
        if (this.oms) {
          await this.oms.recordFill(order.id, order.qty, fillPrice);
        } else {
          await this.prisma.order.update({
            where: { id: order.id },
            data: { status: 'FILLED', filledQty: order.qty, avgFillPrice: fillPrice, ...costs, filledAt: new Date() },
          });
        }

        const input: PlaceOrderInput = {
          portfolioId: order.portfolioId,
          symbol: order.symbol,
          side: order.side,
          orderType: order.orderType,
          qty: order.qty,
          price: fillPrice,
          instrumentToken: order.instrumentToken,
          exchange: order.exchange,
        };

        await this.handleFill(order.id, input, fillPrice, costs, order.qty);
        matched++;
      } catch {
        failed++;
      }
    }

    return { matched, failed };
  }
}

export class TradeError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'TradeError';
  }
}
