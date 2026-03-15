import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';

const log = createChildLogger('IcebergExecutor');

export interface IcebergConfig {
  totalQty: number;
  showQty: number;
  randomizePct: number;
  symbol: string;
  side: 'BUY' | 'SELL';
  exchange: string;
  portfolioId: string;
  userId: string;
  price?: number;
  strategyTag?: string;
  maxDurationMinutes: number;
  pollIntervalMs: number;
}

interface IcebergSlice {
  sliceIndex: number;
  qty: number;
  price: number;
  status: 'FILLED' | 'PARTIAL' | 'FAILED';
  timestamp: string;
}

interface OrderExecutor {
  placeOrder(userId: string, input: {
    portfolioId: string;
    symbol: string;
    side: string;
    orderType: string;
    qty: number;
    price?: number;
    instrumentToken: string;
    exchange?: string;
    strategyTag?: string;
  }): Promise<any>;
}

export class IcebergExecutor {
  private tradeService!: OrderExecutor;
  private activeIcebergs = new Map<string, { config: IcebergConfig; slices: IcebergSlice[]; cancelled: boolean }>();

  setTradeService(ts: OrderExecutor): void {
    this.tradeService = ts;
  }

  async execute(config: IcebergConfig): Promise<{
    executionId: string;
    slices: IcebergSlice[];
    avgFillPrice: number;
    totalFilled: number;
    totalShown: number;
  }> {
    const executionId = `ice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const execution = { config, slices: [] as IcebergSlice[], cancelled: false };
    this.activeIcebergs.set(executionId, execution);

    log.info({
      executionId, symbol: config.symbol, totalQty: config.totalQty,
      showQty: config.showQty, randomizePct: config.randomizePct,
    }, 'Iceberg execution started');

    let remainingQty = config.totalQty;
    let sliceIndex = 0;
    const deadline = Date.now() + config.maxDurationMinutes * 60_000;

    while (remainingQty > 0 && !execution.cancelled && Date.now() < deadline) {
      const baseShow = Math.min(config.showQty, remainingQty);
      const randomFactor = 1 + (Math.random() * 2 - 1) * (config.randomizePct / 100);
      let showQty = Math.round(baseShow * randomFactor);
      showQty = Math.max(1, Math.min(showQty, remainingQty));

      try {
        const order = await this.tradeService.placeOrder(config.userId, {
          portfolioId: config.portfolioId,
          symbol: config.symbol,
          side: config.side,
          orderType: config.price ? 'LIMIT' : 'MARKET',
          qty: showQty,
          price: config.price,
          instrumentToken: config.symbol,
          exchange: config.exchange,
          strategyTag: `${config.strategyTag ?? 'iceberg'}:slice${sliceIndex}`,
        });

        const fillPrice = Number(order.avgFillPrice ?? config.price ?? 0);
        const filledQty = Number(order.filledQty ?? showQty);

        execution.slices.push({
          sliceIndex,
          qty: filledQty,
          price: fillPrice,
          status: filledQty >= showQty ? 'FILLED' : 'PARTIAL',
          timestamp: new Date().toISOString(),
        });

        remainingQty -= filledQty;
        log.info({
          executionId, sliceIndex, showQty, filledQty, fillPrice,
          remainingQty, hiddenQty: remainingQty,
        }, 'Iceberg slice filled');
      } catch (err) {
        execution.slices.push({
          sliceIndex, qty: showQty, price: 0,
          status: 'FAILED', timestamp: new Date().toISOString(),
        });
        log.error({ executionId, sliceIndex, err }, 'Iceberg slice failed');
      }

      sliceIndex++;

      if (remainingQty > 0 && !execution.cancelled) {
        await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
      }
    }

    const filledSlices = execution.slices.filter(s => s.status === 'FILLED' || s.status === 'PARTIAL');
    const totalFilled = filledSlices.reduce((s, sl) => s + sl.qty, 0);
    const totalCost = filledSlices.reduce((s, sl) => s + sl.qty * sl.price, 0);
    const avgFillPrice = totalFilled > 0 ? totalCost / totalFilled : 0;

    this.activeIcebergs.delete(executionId);

    emit('execution', {
      type: 'ORDER_FILLED', userId: config.userId, orderId: executionId,
      symbol: config.symbol, fillPrice: avgFillPrice, qty: totalFilled, slippageBps: 0,
    }).catch(err => log.error({ err, executionId }, 'Failed to emit iceberg fill event'));

    log.info({ executionId, totalFilled, avgFillPrice, slicesUsed: sliceIndex }, 'Iceberg execution completed');

    return { executionId, slices: execution.slices, avgFillPrice, totalFilled, totalShown: sliceIndex };
  }

  cancel(executionId: string): boolean {
    const execution = this.activeIcebergs.get(executionId);
    if (!execution) return false;
    execution.cancelled = true;
    log.info({ executionId }, 'Iceberg execution cancelled');
    return true;
  }

  getActiveIcebergs(): string[] {
    return Array.from(this.activeIcebergs.keys());
  }
}
