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
type OrderSide = string;
type OrderType = string;
type Exchange = string;

const log = createChildLogger('TradeService');

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
}

interface CostBreakdown {
  brokerage: number;
  stt: number;
  exchangeCharges: number;
  gst: number;
  sebiCharges: number;
  stampDuty: number;
  totalCost: number;
}

function calculateCosts(qty: number, price: number, side: OrderSide, exchange: string = 'NSE'): CostBreakdown {
  const turnover = qty * price;

  if (exchange === 'MCX') {
    const brokerage = Math.min(turnover * 0.0003, 20);
    const ctt = side === 'SELL' ? turnover * 0.0001 : 0; // CTT instead of STT
    const exchangeCharges = turnover * 0.000026;
    const gst = (brokerage + exchangeCharges) * 0.18;
    const sebiCharges = turnover * 0.000001;
    const stampDuty = side === 'BUY' ? turnover * 0.00002 : 0;
    const totalCost = brokerage + ctt + exchangeCharges + gst + sebiCharges + stampDuty;
    return {
      brokerage: Number(brokerage.toFixed(2)),
      stt: Number(ctt.toFixed(2)),
      exchangeCharges: Number(exchangeCharges.toFixed(2)),
      gst: Number(gst.toFixed(2)),
      sebiCharges: Number(sebiCharges.toFixed(2)),
      stampDuty: Number(stampDuty.toFixed(2)),
      totalCost: Number(totalCost.toFixed(2)),
    };
  }

  if (exchange === 'CDS') {
    const brokerage = Math.min(turnover * 0.0003, 20);
    const stt = 0; // No STT on currency derivatives
    const exchangeCharges = turnover * 0.000035;
    const gst = (brokerage + exchangeCharges) * 0.18;
    const sebiCharges = turnover * 0.000001;
    const stampDuty = side === 'BUY' ? turnover * 0.00001 : 0;
    const totalCost = brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty;
    return {
      brokerage: Number(brokerage.toFixed(2)),
      stt: Number(stt.toFixed(2)),
      exchangeCharges: Number(exchangeCharges.toFixed(2)),
      gst: Number(gst.toFixed(2)),
      sebiCharges: Number(sebiCharges.toFixed(2)),
      stampDuty: Number(stampDuty.toFixed(2)),
      totalCost: Number(totalCost.toFixed(2)),
    };
  }

  // NSE/BSE equity
  const brokerage = Math.min(turnover * 0.0003, 20);
  const stt = side === 'SELL' ? turnover * 0.001 : 0;
  const exchangeCharges = turnover * 0.0000345;
  const gst = (brokerage + exchangeCharges) * 0.18;
  const sebiCharges = turnover * 0.000001;
  const stampDuty = side === 'BUY' ? turnover * 0.00015 : 0;
  const totalCost = brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty;

  return {
    brokerage: Number(brokerage.toFixed(2)),
    stt: Number(stt.toFixed(2)),
    exchangeCharges: Number(exchangeCharges.toFixed(2)),
    gst: Number(gst.toFixed(2)),
    sebiCharges: Number(sebiCharges.toFixed(2)),
    stampDuty: Number(stampDuty.toFixed(2)),
    totalCost: Number(totalCost.toFixed(2)),
  };
}

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

  // Spread model: base spread by exchange, scaled by time-of-day
  const baseSpreadBps: Record<string, number> = { MCX: 8, CDS: 5, NSE: 3, BSE: 4, NFO: 6 };
  let spreadBps = baseSpreadBps[exchange] ?? 3;

  // Time-of-day widening: wider at open (9:15-9:45) and close (15:00-15:30)
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const minuteOfDay = hour * 60 + minute;
  if (minuteOfDay < 585 || minuteOfDay > 900) { // Before 9:45 or after 15:00
    spreadBps *= 1.8;
  } else if (minuteOfDay < 615) { // 9:45 - 10:15
    spreadBps *= 1.3;
  }

  const spreadHalf = idealPrice * spreadBps / 20000;
  const spreadAdjusted = side === 'BUY' ? idealPrice + spreadHalf : idealPrice - spreadHalf;

  // Square-root market impact model: impact_bps = k * sqrt(participation_rate) * vol
  const k = exchange === 'MCX' ? 0.15 : exchange === 'NFO' ? 0.12 : 0.10;
  const estimatedDailyVolume = 500_000;
  const participationRate = estimatedDailyVolume > 0 ? qty / estimatedDailyVolume : 0.01;
  const estimatedVol = exchange === 'MCX' ? 0.025 : 0.018;
  const impactBps = k * Math.sqrt(participationRate) * estimatedVol * 10000;

  const slippageFactor = Math.min(qty * idealPrice / 5_000_000, 0.003);
  const randomJitter = (Math.random() - 0.5) * 0.0005;
  const totalSlippage = slippageFactor + impactBps / 10000 + Math.abs(randomJitter);
  const slippageAmount = spreadAdjusted * totalSlippage;
  const fillPrice = side === 'BUY'
    ? spreadAdjusted + slippageAmount
    : spreadAdjusted - slippageAmount;

  const impactCost = Math.abs(fillPrice - idealPrice) * qty;

  const liquidity = exchange === 'MCX' ? 0.85 : exchange === 'CDS' ? 0.80 : 0.95;
  const fillRatio = Math.min(1, liquidity + Math.random() * (1 - liquidity));
  const filledQty = Math.max(1, Math.round(qty * fillRatio));

  const latencyMs = Math.round(15 + Math.random() * 50);

  return {
    idealPrice: Number(idealPrice.toFixed(2)),
    fillPrice: Number(fillPrice.toFixed(2)),
    slippageBps: Number((totalSlippage * 10000).toFixed(1)),
    spreadCost: Number((spreadHalf * 2 * qty).toFixed(2)),
    impactCost: Number(impactCost.toFixed(2)),
    filledQty,
    requestedQty: qty,
    fillRatio: Number(fillRatio.toFixed(3)),
    latencyMs,
  };
}

export class TradeService {
  private marketData: MarketDataService;
  private calendar: MarketCalendar;
  private riskService: RiskService;
  private broker: BrokerAdapter | null = null;
  private oms: OrderManagementService | null = null;
  private _twapExecutor: any = null;

  constructor(private prisma: PrismaClient, oms?: OrderManagementService) {
    this.marketData = new MarketDataService();
    this.calendar = new MarketCalendar();
    this.riskService = new RiskService(prisma);
    this.oms = oms ?? new OrderManagementService(prisma);

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

  async executeLiveOrder(input: PlaceOrderInput): Promise<{ orderId: string; status: string; brokerOrderId?: string }> {
    if (!this.broker) throw new TradeError('Live broker not configured', 500);

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
    };

    const result = await this.broker.placeOrder(brokerInput);
    if (result.status === 'FAILED') {
      throw new TradeError(`Broker rejected order: ${result.message}`, 400);
    }
    return { orderId: result.orderId, status: result.status, brokerOrderId: result.brokerOrderId };
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
        select: { avgEntryPrice: true, qty: true, side: true, exchange: true },
      });

      if (!openPositions || !Array.isArray(openPositions)) return 0;

      let total = 0;
      for (const pos of openPositions) {
        const entryPrice = Number(pos.avgEntryPrice);
        if (pos.side === 'LONG') {
          total += entryPrice * pos.qty;
        } else {
          const rate = pos.exchange === 'MCX' ? 0.10 : pos.exchange === 'CDS' ? 0.05 : 0.25;
          total += entryPrice * pos.qty * rate;
        }
      }
      return total;
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

  async placeOrder(userId: string, input: PlaceOrderInput, skipMarketCheck = false) {
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

    const exchange = input.exchange ?? 'NSE';
    const marketOpen = this.calendar.isMarketOpen(exchange);

    // STRICT RULE: No orders outside market hours — not even queued
    if (!marketOpen && !skipMarketCheck) {
      throw new TradeError(
        `Market is closed. Orders cannot be placed or queued outside market hours. ` +
        `${exchange} trading hours: ${exchange === 'MCX' ? '9:00-23:30' : exchange === 'CDS' ? '9:00-17:00' : '9:15-15:30'} IST.`,
        400,
      );
    }

    // Even with skipMarketCheck (manual AMO), bots must NEVER trade after hours
    if (!marketOpen && (input.strategyTag?.startsWith('AI-BOT') || input.strategyTag?.startsWith('BOT:'))) {
      throw new TradeError(
        'STRICT: Bot/Agent orders are blocked outside market hours. No exceptions.',
        400,
      );
    }

    // STRICT CAPITAL ENFORCEMENT: Never exceed declared initial capital
    const declaredCapital = Number(portfolio.initialCapital);
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

    try {
    // Risk gate: enforce target-aware and position limits before any order (now atomic with lock)
    try {
      const estPrice = input.price ?? 0;
      const orderValue = estPrice > 0 ? estPrice * input.qty : 0;

      const targetRisk = await this.riskService.enforceTargetRisk(userId, orderValue, input.symbol, input.side);
      if (!targetRisk.allowed) {
        throw new TradeError(`Risk gate blocked: ${targetRisk.violations.join('; ')}`, 400);
      }

      if (estPrice > 0) {
        const positionRisk = await this.riskService.preTradeCheck(userId, input.symbol, input.side, input.qty, estPrice);
        if (!positionRisk.allowed) {
          throw new TradeError(`Risk check failed: ${positionRisk.violations.join('; ')}`, 400);
        }
      }
    } catch (err) {
      if (err instanceof TradeError) throw err;
      log.warn({ err }, 'Risk check error (non-blocking)');
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
        }
      } catch (err) {
        log.warn({ err, symbol: input.symbol }, 'TWAP auto-routing check failed, falling back to normal execution');
      }
    }

    let fillPrice = input.price ?? 0;

    // Market is open -- execute normally
    if (input.orderType === 'MARKET' && fillPrice <= 0) {
      const quote = await this.marketData.getQuote(input.symbol, exchange);
      fillPrice = quote.ltp;
      if (fillPrice <= 0) {
        throw new TradeError(
          `Cannot place market order: unable to fetch current price for ${input.symbol}. ` +
          'Ensure Breeze API session is active or try a limit order with a specific price.',
          400,
        );
      }

      // Price staleness detection: reject trades on stale quotes
      if (quote.timestamp) {
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

    const costs = calculateCosts(effectiveQty, fillPrice, input.side, exchange);

    const totalValue = fillPrice * input.qty + costs.totalCost;
    const availableCash = Number(portfolio.currentNav);

    // STRICT: Total invested + new order must never exceed declared capital
    if (input.side === 'BUY') {
      const existingShort = await this.prisma.position.findFirst({
        where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'SHORT', status: 'OPEN' },
      });
      if (!existingShort) {
        if (totalValue > availableCash) {
          throw new TradeError(
            `Insufficient capital. Need ₹${totalValue.toFixed(0)} but only ₹${availableCash.toFixed(0)} available.`,
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
      if (!existingLong) {
        const marginRequired = this.shortMarginRequired(fillPrice, input.qty, exchange) + costs.totalCost;
        if (marginRequired > availableCash) {
          throw new TradeError(
            `Insufficient margin for short. Need ₹${marginRequired.toFixed(0)} but only ₹${availableCash.toFixed(0)} available.`,
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
    const order = await this.prisma.order.create({
      data: {
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
        idealPrice: execSimResult?.idealPrice,
        slippageBps: execSimResult?.slippageBps,
        fillLatencyMs: execSimResult ? Math.round(execSimResult.latencyMs) : null,
        spreadCostBps: execSimResult ? Math.round(execSimResult.spreadCost * 10000 / (execSimResult.idealPrice * input.qty || 1)) : null,
        impactCost: execSimResult?.impactCost,
        brokerOrderId: brokerOrderId ?? null,
        filledAt: null,
      },
    });

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

    if (input.orderType === 'MARKET' && fillPrice > 0) {
      // Transition SUBMITTED → FILLED via OMS
      if (this.oms) {
        await this.oms.recordFill(order.id, effectiveQty, fillPrice);
      } else {
        await this.prisma.order.update({
          where: { id: order.id },
          data: { status: 'FILLED', filledQty: effectiveQty, avgFillPrice: fillPrice, filledAt: new Date() },
        });
      }

      await this.handleFill(order.id, input, fillPrice, costs);

      emit('execution', {
        type: 'ORDER_FILLED', userId, orderId: order.id,
        symbol: input.symbol, fillPrice, qty: effectiveQty,
        slippageBps: execSimResult?.slippageBps ?? 0,
      }).catch(err => log.error({ err, orderId: order.id }, 'Failed to emit ORDER_FILLED event'));

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

    } finally {
      if (redis) await redis.del(lockKey).catch(() => {});
    }
  }

  private shortMarginRequired(price: number, qty: number, exchange: string): number {
    const rate = exchange === 'MCX' ? 0.10 : exchange === 'CDS' ? 0.05 : 0.25;
    return price * qty * rate;
  }

  private async safeUpdateNav(portfolioId: string, currentNav: number, delta: number, db?: any): Promise<void> {
    const prisma = db ?? this.prisma;
    const newNav = currentNav + delta;
    if (!isFinite(newNav) || isNaN(newNav)) {
      log.error({ currentNav, delta, newNav }, 'CRITICAL: NAV update would produce invalid value');
      throw new TradeError(`P&L calculation produced invalid NAV. Trade aborted.`, 500);
    }
    if (newNav < 0) {
      log.warn({ currentNav, delta, newNav, portfolioId }, 'NAV going negative — margin overdraft in paper trading, allowing it');
    }
    await prisma.portfolio.update({
      where: { id: portfolioId },
      data: { currentNav: newNav },
    });
  }

  private async handleFill(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
  ) {
    await this.prisma.$transaction(async (tx) => {
      if (input.side === 'BUY') {
        await this.handleBuyFill(orderId, input, fillPrice, costs, tx);
      } else {
        await this.handleSellFill(orderId, input, fillPrice, costs, tx);
      }
    });
  }

  private async handleBuyFill(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
    db?: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0],
  ) {
    const prisma = db ?? this.prisma;
    // First check if there's a SHORT position to cover
    const existingShort = await prisma.position.findFirst({
      where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'SHORT', status: 'OPEN' },
    });

    if (existingShort) {
      const entryPrice = Number(existingShort.avgEntryPrice);
      const coverQty = Math.min(input.qty, existingShort.qty);
      const grossPnl = (entryPrice - fillPrice) * coverQty;
      const netPnl = grossPnl - costs.totalCost;

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
          totalCosts: costs.totalCost,
          netPnl,
          entryTime: existingShort.openedAt,
          exitTime: new Date(),
          strategyTag: input.strategyTag,
        },
      });

      const remainingQty = existingShort.qty - coverQty;
      const prevRealized = Number(existingShort.realizedPnl ?? 0);
      const cumulativeRealized = prevRealized + netPnl;
      if (remainingQty <= 0) {
        await prisma.position.update({
          where: { id: existingShort.id },
          data: { status: 'CLOSED', realizedPnl: cumulativeRealized, closedAt: new Date() },
        });
      } else {
        await prisma.position.update({
          where: { id: existingShort.id },
          data: { qty: remainingQty, realizedPnl: cumulativeRealized },
        });
      }

      const portfolio = await prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
      if (portfolio) {
        const marginReleased = this.shortMarginRequired(entryPrice, coverQty, input.exchange ?? 'NSE');
        const cashChange = marginReleased + netPnl;
        await this.safeUpdateNav(input.portfolioId, Number(portfolio.currentNav), cashChange, prisma);
      }

      await prisma.order.update({ where: { id: orderId }, data: { positionId: existingShort.id } });

      const excessQty = input.qty - coverQty;
      if (excessQty > 0) {
        await this.openLongPosition(orderId, input, fillPrice, costs, excessQty, prisma);
      }
      return;
    }

    await this.openLongPosition(orderId, input, fillPrice, costs, input.qty, prisma);
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

    if (existingLong) {
      const oldQty = existingLong.qty;
      const oldAvg = Number(existingLong.avgEntryPrice);
      const newQty = oldQty + qty;
      const newAvg = (oldAvg * oldQty + fillPrice * qty) / newQty;

      await prisma.position.update({
        where: { id: existingLong.id },
        data: { qty: newQty, avgEntryPrice: newAvg },
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
        },
      });
      await prisma.order.update({ where: { id: orderId }, data: { positionId: position.id } });
    }

    const portfolio = await prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
    if (portfolio) {
      const purchaseCost = fillPrice * qty + costs.totalCost;
      await this.safeUpdateNav(input.portfolioId, Number(portfolio.currentNav), -purchaseCost, prisma);
    }
  }

  private async handleSellFill(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
    db?: any,
  ) {
    const prisma = db ?? this.prisma;
    const existingLong = await prisma.position.findFirst({
      where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'LONG', status: 'OPEN' },
    });

    if (existingLong) {
      const entryPrice = Number(existingLong.avgEntryPrice);
      const closeQty = Math.min(input.qty, existingLong.qty);
      const grossPnl = (fillPrice - entryPrice) * closeQty;
      const netPnl = grossPnl - costs.totalCost;

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
          totalCosts: costs.totalCost,
          netPnl,
          entryTime: existingLong.openedAt,
          exitTime: new Date(),
          strategyTag: input.strategyTag,
        },
      });

      const remainingQty = existingLong.qty - closeQty;
      const prevRealized = Number(existingLong.realizedPnl ?? 0);
      const cumulativeRealized = prevRealized + netPnl;
      if (remainingQty <= 0) {
        await prisma.position.update({
          where: { id: existingLong.id },
          data: { status: 'CLOSED', realizedPnl: cumulativeRealized, closedAt: new Date() },
        });
      } else {
        await prisma.position.update({
          where: { id: existingLong.id },
          data: { qty: remainingQty, realizedPnl: cumulativeRealized },
        });
      }

      const portfolio = await prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
      if (portfolio) {
        const saleProceeds = fillPrice * closeQty - costs.totalCost;
        await this.safeUpdateNav(input.portfolioId, Number(portfolio.currentNav), saleProceeds, prisma);
      }

      await prisma.order.update({ where: { id: orderId }, data: { positionId: existingLong.id } });

      const excessQty = input.qty - closeQty;
      if (excessQty > 0) {
        await this.openShortPosition(orderId, input, fillPrice, costs, excessQty, prisma);
      }
      return;
    }

    await this.openShortPosition(orderId, input, fillPrice, costs, input.qty, prisma);
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
        data: { qty: newQty, avgEntryPrice: newAvg },
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
        },
      });
      await prisma.order.update({ where: { id: orderId }, data: { positionId: position.id } });
    }

    const portfolio = await prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
    if (portfolio) {
      const marginBlocked = this.shortMarginRequired(fillPrice, qty, input.exchange ?? 'NSE');
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

    const entryPrice = Number(position.avgEntryPrice);
    const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';
    const grossPnl = position.side === 'LONG'
      ? (exitPrice - entryPrice) * position.qty
      : (entryPrice - exitPrice) * position.qty;
    const costs = calculateCosts(position.qty, exitPrice, exitSide);
    const netPnl = grossPnl - costs.totalCost;

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
        ...costs,
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
        totalCosts: costs.totalCost,
        netPnl,
        entryTime: position.openedAt,
        exitTime: new Date(),
        strategyTag: position.strategyTag,
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
      let cashChange: number;
      if (position.side === 'LONG') {
        cashChange = exitPrice * position.qty - costs.totalCost;
      } else {
        const marginReleased = this.shortMarginRequired(entryPrice, position.qty, position.exchange);
        cashChange = marginReleased + netPnl;
      }

      const newNav = Number(portfolio.currentNav) + cashChange;
      if (!isFinite(newNav)) {
        throw new TradeError(`P&L calculation produced invalid NAV (${newNav}). Trade aborted.`, 500);
      }

      await this.prisma.portfolio.update({
        where: { id: position.portfolioId },
        data: { currentNav: newNav },
      });
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
        const costs = calculateCosts(order.qty, fillPrice, order.side, order.exchange);

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
            const marginRequired = this.shortMarginRequired(fillPrice, order.qty, order.exchange) + costs.totalCost;
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

        await this.handleFill(order.id, input, fillPrice, costs);
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
