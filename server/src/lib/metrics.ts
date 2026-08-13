/**
 * Prometheus metrics for Capital Guard.
 *
 * Exposes counters, gauges, and histograms for orders, trades, signals,
 * risk events, positions, NAV, P&L, and request latency.
 */

import client from 'prom-client';

const register = new client.Registry();

client.collectDefaultMetrics({ register });

// ── Counters ──

export const ordersTotal = new client.Counter({
  name: 'cg_orders_total',
  help: 'Total number of orders placed',
  labelNames: ['side', 'status'] as const,
  registers: [register],
});

export const tradesTotal = new client.Counter({
  name: 'cg_trades_total',
  help: 'Total number of completed trades',
  labelNames: ['strategy', 'outcome'] as const,
  registers: [register],
});

export const signalsTotal = new client.Counter({
  name: 'cg_signals_generated_total',
  help: 'Total signals generated',
  labelNames: ['source', 'direction'] as const,
  registers: [register],
});

export const riskViolationsTotal = new client.Counter({
  name: 'cg_risk_violations_total',
  help: 'Total risk violations',
  labelNames: ['rule', 'severity'] as const,
  registers: [register],
});

// ── Gauges ──

export const openPositions = new client.Gauge({
  name: 'cg_open_positions',
  help: 'Current number of open positions',
  registers: [register],
});

export const portfolioNav = new client.Gauge({
  name: 'cg_portfolio_nav',
  help: 'Current portfolio NAV in INR',
  registers: [register],
});

export const dailyPnl = new client.Gauge({
  name: 'cg_daily_pnl',
  help: 'Current day P&L in INR',
  registers: [register],
});

export const marginUtilization = new client.Gauge({
  name: 'cg_margin_utilization_pct',
  help: 'Current margin utilization percentage',
  registers: [register],
});

export const activeBots = new client.Gauge({
  name: 'cg_active_bots',
  help: 'Number of actively running bots',
  registers: [register],
});

export const rustEngineAvailable = new client.Gauge({
  name: 'cg_rust_engine_available',
  help: '1 if Rust engine is available, 0 otherwise',
  registers: [register],
});

export const mlServiceAvailable = new client.Gauge({
  name: 'cg_ml_service_available',
  help: '1 if Python ML service is available, 0 otherwise',
  registers: [register],
});

// ── Histograms ──

export const orderExecutionDuration = new client.Histogram({
  name: 'cg_order_execution_duration_seconds',
  help: 'Order execution latency in seconds',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export const signalLatency = new client.Histogram({
  name: 'cg_signal_latency_seconds',
  help: 'Signal generation latency in seconds',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [register],
});

export const apiRequestDuration = new client.Histogram({
  name: 'cg_api_request_duration_seconds',
  help: 'API request duration in seconds',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

export { register };
