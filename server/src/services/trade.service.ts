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

    const costs = calculateCosts(input.qty, fillPrice, input.side, input.exchange ?? 'NSE');

    const totalValue = fillPrice * input.qty + costs.totalCost;
    const availableCash = Number(portfolio.currentNav);
    if (input.side === 'BUY' && totalValue > availableCash) {
      throw new TradeError(
        `Insufficient capital. Need ₹${totalValue.toFixed(0)} but only ₹${availableCash.toFixed(0)} available.`,
        400,
      );
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

  private async handleFill(
    orderId: string,
    input: PlaceOrderInput,
    fillPrice: number,
    costs: CostBreakdown,
  ) {
    if (input.side === 'BUY') {
      const existingPosition = await this.prisma.position.findFirst({
        where: {
          portfolioId: input.portfolioId,
          symbol: input.symbol,
          side: 'LONG',
          status: 'OPEN',
        },
      });

      if (existingPosition) {
        const oldQty = existingPosition.qty;
        const oldAvg = Number(existingPosition.avgEntryPrice);
        const newQty = oldQty + input.qty;
        const newAvg = (oldAvg * oldQty + fillPrice * input.qty) / newQty;

        await this.prisma.position.update({
          where: { id: existingPosition.id },
          data: { qty: newQty, avgEntryPrice: newAvg },
        });

        await this.prisma.order.update({
          where: { id: orderId },
          data: { positionId: existingPosition.id },
        });
      } else {
        const position = await this.prisma.position.create({
          data: {
            portfolioId: input.portfolioId,
            instrumentToken: input.instrumentToken,
            symbol: input.symbol,
            exchange: input.exchange ?? 'NSE',
            qty: input.qty,
            avgEntryPrice: fillPrice,
            side: 'LONG',
            strategyTag: input.strategyTag,
          },
        });

        await this.prisma.order.update({
          where: { id: orderId },
          data: { positionId: position.id },
        });
      }

      // Deduct purchase cost + transaction fees from available cash
      const portfolio = await this.prisma.portfolio.findUnique({
        where: { id: input.portfolioId },
      });
      if (portfolio) {
        const purchaseCost = fillPrice * input.qty + costs.totalCost;
        await this.prisma.portfolio.update({
          where: { id: input.portfolioId },
          data: { currentNav: Number(portfolio.currentNav) - purchaseCost },
        });
      }
    } else {
      const existingPosition = await this.prisma.position.findFirst({
        where: {
          portfolioId: input.portfolioId,
          symbol: input.symbol,
          side: 'LONG',
          status: 'OPEN',
        },
      });

      if (existingPosition) {
        const entryPrice = Number(existingPosition.avgEntryPrice);
        const closeQty = Math.min(input.qty, existingPosition.qty);
        const grossPnl = (fillPrice - entryPrice) * closeQty;
        const netPnl = grossPnl - costs.totalCost;

        await this.prisma.trade.create({
          data: {
            portfolioId: input.portfolioId,
            positionId: existingPosition.id,
            symbol: input.symbol,
            exchange: input.exchange ?? 'NSE',
            side: 'SELL',
            entryPrice,
            exitPrice: fillPrice,
            qty: closeQty,
            grossPnl,
            totalCosts: costs.totalCost,
            netPnl,
            entryTime: existingPosition.openedAt,
            exitTime: new Date(),
            strategyTag: input.strategyTag,
          },
        });

        const remainingQty = existingPosition.qty - closeQty;
        if (remainingQty <= 0) {
          await this.prisma.position.update({
            where: { id: existingPosition.id },
            data: {
              status: 'CLOSED',
              realizedPnl: netPnl,
              closedAt: new Date(),
            },
          });
        } else {
          await this.prisma.position.update({
            where: { id: existingPosition.id },
            data: { qty: remainingQty },
          });
        }

        // Add sale proceeds back to available cash
        const portfolio = await this.prisma.portfolio.findUnique({
          where: { id: input.portfolioId },
        });
        if (portfolio) {
          const saleProceeds = fillPrice * closeQty - costs.totalCost;
          await this.prisma.portfolio.update({
            where: { id: input.portfolioId },
            data: { currentNav: Number(portfolio.currentNav) + saleProceeds },
          });
        }

        await this.prisma.order.update({
          where: { id: orderId },
          data: { positionId: existingPosition.id },
        });
      }
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
      if (toDate) where.exitTime.lte = new Date(toDate);
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
