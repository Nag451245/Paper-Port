import { PrismaClient } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
type OrderSide = string;
type OrderType = string;
type Exchange = string;

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

  const spreadBps = exchange === 'MCX' ? 8 : exchange === 'CDS' ? 5 : 3;
  const spreadHalf = idealPrice * spreadBps / 20000;
  const spreadAdjusted = side === 'BUY' ? idealPrice + spreadHalf : idealPrice - spreadHalf;

  const slippageFactor = Math.min(qty * idealPrice / 5_000_000, 0.003);
  const randomJitter = (Math.random() - 0.5) * 0.001;
  const slippage = slippageFactor + Math.abs(randomJitter);
  const slippageAmount = spreadAdjusted * slippage;
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
    slippageBps: Number((slippage * 10000).toFixed(1)),
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

  constructor(private prisma: PrismaClient) {
    this.marketData = new MarketDataService();
  }

  async placeOrder(userId: string, input: PlaceOrderInput) {
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: input.portfolioId },
    });

    if (!portfolio || portfolio.userId !== userId) {
      throw new TradeError('Portfolio not found', 404);
    }

    let fillPrice = input.price ?? 0;

    if (input.orderType === 'MARKET' && fillPrice <= 0) {
      const quote = await this.marketData.getQuote(input.symbol, input.exchange ?? 'NSE');
      fillPrice = quote.ltp;
      if (fillPrice <= 0) {
        throw new TradeError(
          `Cannot place market order: unable to fetch current price for ${input.symbol}. ` +
          'Ensure Breeze API session is active or try a limit order with a specific price.',
          400,
        );
      }
    }

    const execSim = simulateExecution(fillPrice, input.qty, input.side as 'BUY' | 'SELL', input.exchange ?? 'NSE', input.orderType);
    fillPrice = execSim.fillPrice;
    const effectiveQty = execSim.filledQty;

    const costs = calculateCosts(effectiveQty, fillPrice, input.side, input.exchange ?? 'NSE');

    const totalValue = fillPrice * input.qty + costs.totalCost;
    const availableCash = Number(portfolio.currentNav);

    if (input.side === 'BUY') {
      // BUY needs full capital unless closing a SHORT (which releases margin)
      const existingShort = await this.prisma.position.findFirst({
        where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'SHORT', status: 'OPEN' },
      });
      if (!existingShort && totalValue > availableCash) {
        throw new TradeError(
          `Insufficient capital. Need ₹${totalValue.toFixed(0)} but only ₹${availableCash.toFixed(0)} available.`,
          400,
        );
      }
    } else {
      // SELL: if no LONG position exists, this will be a short -- check margin
      const existingLong = await this.prisma.position.findFirst({
        where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'LONG', status: 'OPEN' },
      });
      if (!existingLong) {
        const marginRequired = this.shortMarginRequired(fillPrice, input.qty, input.exchange ?? 'NSE') + costs.totalCost;
        if (marginRequired > availableCash) {
          throw new TradeError(
            `Insufficient margin for short. Need ₹${marginRequired.toFixed(0)} but only ₹${availableCash.toFixed(0)} available.`,
            400,
          );
        }
      }
    }

    const order = await this.prisma.order.create({
      data: {
        portfolioId: input.portfolioId,
        instrumentToken: input.instrumentToken,
        symbol: input.symbol,
        exchange: input.exchange ?? 'NSE',
        orderType: input.orderType,
        side: input.side,
        qty: input.qty,
        price: fillPrice > 0 ? fillPrice : input.price,
        triggerPrice: input.triggerPrice,
        status: input.orderType === 'MARKET' ? 'FILLED' : 'PENDING',
        filledQty: input.orderType === 'MARKET' ? input.qty : 0,
        avgFillPrice: input.orderType === 'MARKET' ? fillPrice : null,
        ...costs,
        filledAt: input.orderType === 'MARKET' ? new Date() : null,
      },
    });

    if (input.orderType === 'MARKET' && fillPrice > 0) {
      await this.handleFill(order.id, input, fillPrice, costs);
    }

    return order;
  }

  private shortMarginRequired(price: number, qty: number, exchange: string): number {
    // Paper trading margin rates (realistic approximations)
    const rate = exchange === 'MCX' ? 0.10 : exchange === 'CDS' ? 0.05 : 0.25;
    return price * qty * rate;
  }

  private async handleFill(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
  ) {
    if (input.side === 'BUY') {
      await this.handleBuyFill(orderId, input, fillPrice, costs);
    } else {
      await this.handleSellFill(orderId, input, fillPrice, costs);
    }
  }

  private async handleBuyFill(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
  ) {
    // First check if there's a SHORT position to cover
    const existingShort = await this.prisma.position.findFirst({
      where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'SHORT', status: 'OPEN' },
    });

    if (existingShort) {
      const entryPrice = Number(existingShort.avgEntryPrice);
      const coverQty = Math.min(input.qty, existingShort.qty);
      const grossPnl = (entryPrice - fillPrice) * coverQty;
      const netPnl = grossPnl - costs.totalCost;

      await this.prisma.trade.create({
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
      if (remainingQty <= 0) {
        await this.prisma.position.update({
          where: { id: existingShort.id },
          data: { status: 'CLOSED', realizedPnl: netPnl, closedAt: new Date() },
        });
      } else {
        await this.prisma.position.update({
          where: { id: existingShort.id },
          data: { qty: remainingQty },
        });
      }

      // Release blocked margin + settle P&L.  Cost to cover = buyback price * qty + costs.
      // Margin released = original margin on covered qty.
      const portfolio = await this.prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
      if (portfolio) {
        const marginReleased = this.shortMarginRequired(entryPrice, coverQty, input.exchange ?? 'NSE');
        const coverCost = fillPrice * coverQty + costs.totalCost;
        // Net cash change: margin comes back, cover cost goes out, P&L settles
        // = marginReleased - coverCost + (entryPrice * coverQty)
        // Simplified: entryPrice*qty was received when shorting; now we pay back fillPrice*qty
        const cashChange = marginReleased + netPnl;
        await this.prisma.portfolio.update({
          where: { id: input.portfolioId },
          data: { currentNav: Number(portfolio.currentNav) + cashChange },
        });
      }

      await this.prisma.order.update({ where: { id: orderId }, data: { positionId: existingShort.id } });

      // If BUY qty exceeds SHORT qty, open a LONG with remainder
      const excessQty = input.qty - coverQty;
      if (excessQty > 0) {
        await this.openLongPosition(orderId, input, fillPrice, costs, excessQty);
      }
      return;
    }

    // No SHORT to cover -- open or add to LONG position
    await this.openLongPosition(orderId, input, fillPrice, costs, input.qty);
  }

  private async openLongPosition(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
    qty: number,
  ) {
    const existingLong = await this.prisma.position.findFirst({
      where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'LONG', status: 'OPEN' },
    });

    if (existingLong) {
      const oldQty = existingLong.qty;
      const oldAvg = Number(existingLong.avgEntryPrice);
      const newQty = oldQty + qty;
      const newAvg = (oldAvg * oldQty + fillPrice * qty) / newQty;

      await this.prisma.position.update({
        where: { id: existingLong.id },
        data: { qty: newQty, avgEntryPrice: newAvg },
      });
      await this.prisma.order.update({ where: { id: orderId }, data: { positionId: existingLong.id } });
    } else {
      const position = await this.prisma.position.create({
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
      await this.prisma.order.update({ where: { id: orderId }, data: { positionId: position.id } });
    }

    const portfolio = await this.prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
    if (portfolio) {
      const purchaseCost = fillPrice * qty + costs.totalCost;
      await this.prisma.portfolio.update({
        where: { id: input.portfolioId },
        data: { currentNav: Number(portfolio.currentNav) - purchaseCost },
      });
    }
  }

  private async handleSellFill(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
  ) {
    // First check if there's a LONG position to close
    const existingLong = await this.prisma.position.findFirst({
      where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'LONG', status: 'OPEN' },
    });

    if (existingLong) {
      const entryPrice = Number(existingLong.avgEntryPrice);
      const closeQty = Math.min(input.qty, existingLong.qty);
      const grossPnl = (fillPrice - entryPrice) * closeQty;
      const netPnl = grossPnl - costs.totalCost;

      await this.prisma.trade.create({
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
      if (remainingQty <= 0) {
        await this.prisma.position.update({
          where: { id: existingLong.id },
          data: { status: 'CLOSED', realizedPnl: netPnl, closedAt: new Date() },
        });
      } else {
        await this.prisma.position.update({
          where: { id: existingLong.id },
          data: { qty: remainingQty },
        });
      }

      const portfolio = await this.prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
      if (portfolio) {
        const saleProceeds = fillPrice * closeQty - costs.totalCost;
        await this.prisma.portfolio.update({
          where: { id: input.portfolioId },
          data: { currentNav: Number(portfolio.currentNav) + saleProceeds },
        });
      }

      await this.prisma.order.update({ where: { id: orderId }, data: { positionId: existingLong.id } });

      // If SELL qty exceeds LONG qty, open a SHORT with remainder
      const excessQty = input.qty - closeQty;
      if (excessQty > 0) {
        await this.openShortPosition(orderId, input, fillPrice, costs, excessQty);
      }
      return;
    }

    // No LONG to close -- open a SHORT position
    await this.openShortPosition(orderId, input, fillPrice, costs, input.qty);
  }

  private async openShortPosition(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
    qty: number,
  ) {
    const existingShort = await this.prisma.position.findFirst({
      where: { portfolioId: input.portfolioId, symbol: input.symbol, side: 'SHORT', status: 'OPEN' },
    });

    if (existingShort) {
      const oldQty = existingShort.qty;
      const oldAvg = Number(existingShort.avgEntryPrice);
      const newQty = oldQty + qty;
      const newAvg = (oldAvg * oldQty + fillPrice * qty) / newQty;

      await this.prisma.position.update({
        where: { id: existingShort.id },
        data: { qty: newQty, avgEntryPrice: newAvg },
      });
      await this.prisma.order.update({ where: { id: orderId }, data: { positionId: existingShort.id } });
    } else {
      const position = await this.prisma.position.create({
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
      await this.prisma.order.update({ where: { id: orderId }, data: { positionId: position.id } });
    }

    // Block margin for the short position
    const portfolio = await this.prisma.portfolio.findUnique({ where: { id: input.portfolioId } });
    if (portfolio) {
      const marginBlocked = this.shortMarginRequired(fillPrice, qty, input.exchange ?? 'NSE') + costs.totalCost;
      await this.prisma.portfolio.update({
        where: { id: input.portfolioId },
        data: { currentNav: Number(portfolio.currentNav) - marginBlocked },
      });
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

    if (order.status !== 'PENDING') {
      throw new TradeError('Only pending orders can be cancelled', 400);
    }

    return this.prisma.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });
  }

  async listOrders(userId: string, params: { status?: string; page?: number; limit?: number } = {}) {
    const { status, page = 1, limit = 50 } = params;

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

  async listPositions(userId: string) {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    const portfolioIds = portfolios.map((p) => p.id);

    return this.prisma.position.findMany({
      where: { portfolioId: { in: portfolioIds }, status: 'OPEN' },
      orderBy: { openedAt: 'desc' },
    });
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

    const entryPrice = Number(position.avgEntryPrice);
    const grossPnl = position.side === 'LONG'
      ? (exitPrice - entryPrice) * position.qty
      : (entryPrice - exitPrice) * position.qty;
    const costs = calculateCosts(position.qty, exitPrice, 'SELL');
    const netPnl = grossPnl - costs.totalCost;

    const trade = await this.prisma.trade.create({
      data: {
        portfolioId: position.portfolioId,
        positionId: position.id,
        symbol: position.symbol,
        exchange: position.exchange,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
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

    await this.prisma.position.update({
      where: { id: positionId },
      data: { status: 'CLOSED', realizedPnl: netPnl, closedAt: new Date() },
    });

    // Add sale proceeds back to available cash
    const portfolio = await this.prisma.portfolio.findUnique({ where: { id: position.portfolioId } });
    if (portfolio) {
      const saleProceeds = exitPrice * position.qty - costs.totalCost;
      await this.prisma.portfolio.update({
        where: { id: position.portfolioId },
        data: { currentNav: Number(portfolio.currentNav) + saleProceeds },
      });
    }

    return trade;
  }

  async listTrades(userId: string, params: { page?: number; limit?: number; fromDate?: string; toDate?: string; symbol?: string } = {}) {
    const { page = 1, limit = 50, fromDate, toDate, symbol } = params;

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
