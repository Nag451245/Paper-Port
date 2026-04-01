/**
 * Prometheus metrics for Capital Guard.
 *
 * Exposes counters, gauges, and histograms for orders, trades, signals,
 * risk events, positions, NAV, P&L, and request latency.
 */
import client from 'prom-client';
declare const register: client.Registry<"text/plain; version=0.0.4; charset=utf-8">;
export declare const ordersTotal: client.Counter<"status" | "side">;
export declare const tradesTotal: client.Counter<"outcome" | "strategy">;
export declare const signalsTotal: client.Counter<"source" | "direction">;
export declare const riskViolationsTotal: client.Counter<"severity" | "rule">;
export declare const openPositions: client.Gauge<string>;
export declare const portfolioNav: client.Gauge<string>;
export declare const dailyPnl: client.Gauge<string>;
export declare const marginUtilization: client.Gauge<string>;
export declare const activeBots: client.Gauge<string>;
export declare const rustEngineAvailable: client.Gauge<string>;
export declare const mlServiceAvailable: client.Gauge<string>;
export declare const orderExecutionDuration: client.Histogram<string>;
export declare const signalLatency: client.Histogram<string>;
export declare const apiRequestDuration: client.Histogram<"method" | "route" | "status_code">;
export { register };
//# sourceMappingURL=metrics.d.ts.map