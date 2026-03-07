/**
 * Event Workers — BullMQ consumers for all 5 event bus categories.
 *
 * Bridges the gap between event producers (TradeService, OMS, RiskService, etc.)
 * and consumers (WebSocket push, decision audit, learning triggers).
 */

import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import {
  registerWorker,
  type AppEvent,
  type ExecutionEvent,
  type RiskEvent,
  type SignalEvent,
  type SystemEvent,
  type MarketDataEvent,
} from '../lib/event-bus.js';
import { wsHub } from '../lib/websocket.js';
import { createChildLogger } from '../lib/logger.js';
import type { LearningEngine } from './learning-engine.js';
import type { BotEngine } from './bot-engine.js';

const log = createChildLogger('EventWorkers');

export function registerAllWorkers(
  prisma: PrismaClient,
  learningEngine?: LearningEngine,
  botEngine?: BotEngine,
): void {
  log.info('Registering event bus workers for all 5 categories');

  // ── Execution events: order fills, position changes, OMS state transitions ──
  registerWorker('execution', async (job: Job<AppEvent>) => {
    const event = job.data as ExecutionEvent;

    switch (event.type) {
      case 'ORDER_PLACED':
        wsHub.broadcastToUser(event.userId, { type: 'order_placed', data: event });
        break;

      case 'ORDER_FILLED':
        wsHub.broadcastToUser(event.userId, { type: 'order_filled', data: event });
        log.info({ orderId: event.orderId, symbol: event.symbol, fillPrice: event.fillPrice }, 'Order filled');
        break;

      case 'POSITION_CLOSED': {
        wsHub.broadcastToUser(event.userId, { type: 'position_closed', data: event });
        // Persist to decision audit for learning loop
        try {
          await prisma.decisionAudit.create({
            data: {
              userId: event.userId,
              decisionType: 'POSITION_CLOSED',
              symbol: event.symbol,
              direction: event.pnl >= 0 ? 'WIN' : 'LOSS',
              confidence: 0,
              signalSource: 'EXECUTION',
              marketDataSnapshot: JSON.stringify({ exitPrice: event.exitPrice, pnl: event.pnl }),
              reasoning: `Position closed at ₹${event.exitPrice}, PnL: ₹${event.pnl.toFixed(2)}`,
            },
          });
        } catch { /* audit is best-effort */ }

        // Intraday Bayesian update: adjust strategy confidence in real-time
        if (learningEngine) {
          learningEngine.runIntradayUpdate({
            strategyTag: event.strategyTag ?? '',
            netPnl: event.pnl ?? 0,
            userId: event.userId,
            symbol: event.symbol,
          }).catch(err => log.warn({ err }, 'Intraday learning update failed'));
        }

        // Update BotEngine's Thompson sampling posteriors
        if (botEngine && event.strategyTag) {
          botEngine.bayesianUpdate(event.strategyTag, event.pnl >= 0);
        }
        break;
      }

      case 'ORDER_STATE_CHANGE':
        if ('orderId' in event) {
          // Look up the order to find the userId for WebSocket push
          try {
            const order = await prisma.order.findUnique({
              where: { id: event.orderId },
              include: { portfolio: { select: { userId: true } } },
            });
            if (order?.portfolio?.userId) {
              wsHub.broadcastToUser(order.portfolio.userId, { type: 'order_state_change', data: event });
            }
          } catch { /* best-effort */ }
        }
        break;

      case 'POSITION_OPENED':
        wsHub.broadcastToUser(event.userId, { type: 'position_opened', data: event });
        break;
    }
  }, { concurrency: 10 });

  // ── Risk events: violations, circuit breakers ──
  registerWorker('risk', async (job: Job<AppEvent>) => {
    const event = job.data as RiskEvent;

    switch (event.type) {
      case 'RISK_VIOLATION':
        wsHub.broadcastToUser(event.userId, { type: 'risk_violation', data: event });

        try {
          await prisma.riskEvent.create({
            data: {
              userId: event.userId,
              ruleType: 'RISK_VIOLATION',
              severity: event.severity,
              details: JSON.stringify(event),
            },
          });
        } catch { /* best-effort */ }
        break;

      case 'CIRCUIT_BREAKER_TRIGGERED':
        wsHub.broadcastToUser(event.userId, { type: 'circuit_breaker', data: event });
        log.warn({ userId: event.userId, reason: event.reason, drawdownPct: event.drawdownPct },
          'Circuit breaker triggered');

        try {
          await prisma.riskEvent.create({
            data: {
              userId: event.userId,
              ruleType: 'CIRCUIT_BREAKER',
              severity: 'critical',
              details: JSON.stringify(event),
            },
          });
        } catch { /* best-effort */ }
        break;

      case 'RISK_CHECK_PASSED':
        break;
    }
  }, { concurrency: 5 });

  // ── Signal events: generated signals, validations ──
  registerWorker('signals', async (job: Job<AppEvent>) => {
    const event = job.data as SignalEvent;

    switch (event.type) {
      case 'SIGNAL_GENERATED':
        wsHub.broadcastToUser(event.userId, { type: 'signal_generated', data: event });
        break;

      case 'SIGNAL_VALIDATED':
        wsHub.broadcastToUser(event.userId, { type: 'signal_validated', data: event });
        break;

      case 'SIGNAL_EXPIRED':
        wsHub.broadcastToUser(event.userId, { type: 'signal_expired', data: event });
        break;
    }
  }, { concurrency: 5 });

  // ── System events: market phase changes, kill switch ──
  registerWorker('system', async (job: Job<AppEvent>) => {
    const event = job.data as SystemEvent;

    switch (event.type) {
      case 'PHASE_CHANGE':
        wsHub.broadcastRegime({ regime: event.to, confidence: 1.0, timestamp: event.timestamp });
        log.info({ from: event.from, to: event.to }, 'Market phase change processed by worker');
        break;

      case 'MARKET_OPEN':
        log.info({ exchange: event.exchange }, 'Market opened');
        break;

      case 'MARKET_CLOSE':
        log.info({ exchange: event.exchange }, 'Market closed');
        break;

      case 'KILL_SWITCH_ACTIVATED':
        wsHub.broadcastToUser(event.userId, { type: 'kill_switch', data: { active: true, timestamp: event.timestamp } });
        log.warn({ userId: event.userId }, 'Kill switch activated');
        break;

      case 'KILL_SWITCH_DEACTIVATED':
        wsHub.broadcastToUser(event.userId, { type: 'kill_switch', data: { active: false, timestamp: event.timestamp } });
        log.info({ userId: event.userId }, 'Kill switch deactivated');
        break;
    }
  }, { concurrency: 3 });

  // ── Market data events: ticks, gaps ──
  registerWorker('market-data', async (job: Job<AppEvent>) => {
    const event = job.data as MarketDataEvent;

    switch (event.type) {
      case 'DATA_GAP_DETECTED':
        log.warn({ symbol: event.symbol, gapMinutes: event.gapMinutes }, 'Data gap detected');
        break;

      case 'TICK_RECEIVED':
        break;

      case 'CANDLE_CLOSED':
        break;
    }
  }, { concurrency: 3 });

  log.info('All 5 event bus workers registered');
}
