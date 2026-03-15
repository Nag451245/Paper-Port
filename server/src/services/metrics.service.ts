import client from 'prom-client';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('MetricsService');

export class MetricsService {
  private static instance: MetricsService;

  private ordersPlaced: client.Counter;
  private ordersFilled: client.Counter;
  private ordersRejected: client.Counter;
  private riskViolations: client.Counter;
  private circuitBreakerActivations: client.Counter;

  private orderLatency: client.Histogram;
  private apiRequestDuration: client.Histogram;
  private summaryFetchDuration: client.Histogram;

  private openPositionsGauge: client.Gauge;
  private portfolioNavGauge: client.Gauge;
  private heapUsedGauge: client.Gauge;
  private eventLoopLagGauge: client.Gauge;
  private wsConnectionsGauge: client.Gauge;
  private prismaPoolGauge: client.Gauge;

  private collectInterval: ReturnType<typeof setInterval> | null = null;
  private gaugeProvider?: () => Promise<{ openPositions: number; nav: number; wsConnections: number }>;

  private constructor() {
    this.ordersPlaced = new client.Counter({
      name: 'orders_placed_total',
      help: 'Total orders placed',
      labelNames: ['side', 'orderType', 'mode'] as const,
    });

    this.ordersFilled = new client.Counter({
      name: 'orders_filled_total',
      help: 'Total orders filled',
      labelNames: ['side', 'mode'] as const,
    });

    this.ordersRejected = new client.Counter({
      name: 'orders_rejected_total',
      help: 'Total orders rejected',
      labelNames: ['reason'] as const,
    });

    this.riskViolations = new client.Counter({
      name: 'risk_violations_total',
      help: 'Total risk rule violations',
      labelNames: ['ruleType'] as const,
    });

    this.circuitBreakerActivations = new client.Counter({
      name: 'circuit_breaker_activations_total',
      help: 'Total circuit breaker activations',
    });

    this.orderLatency = new client.Histogram({
      name: 'order_latency_ms',
      help: 'Order round-trip latency in milliseconds',
      buckets: [10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    });

    this.apiRequestDuration = new client.Histogram({
      name: 'api_request_duration_ms',
      help: 'API request duration in milliseconds',
      labelNames: ['method', 'route'] as const,
      buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
    });

    this.summaryFetchDuration = new client.Histogram({
      name: 'summary_fetch_duration_ms',
      help: 'Summary data fetch duration in milliseconds',
      buckets: [50, 100, 250, 500, 1000, 2500, 5000],
    });

    this.openPositionsGauge = new client.Gauge({
      name: 'open_positions_count',
      help: 'Current open position count',
    });

    this.portfolioNavGauge = new client.Gauge({
      name: 'portfolio_nav',
      help: 'Current portfolio net asset value',
    });

    this.heapUsedGauge = new client.Gauge({
      name: 'heap_used_bytes',
      help: 'V8 heap used in bytes',
    });

    this.eventLoopLagGauge = new client.Gauge({
      name: 'event_loop_lag_ms',
      help: 'Event loop lag in milliseconds',
    });

    this.wsConnectionsGauge = new client.Gauge({
      name: 'ws_connections_count',
      help: 'Active WebSocket connections',
    });

    this.prismaPoolGauge = new client.Gauge({
      name: 'prisma_pool_utilization',
      help: 'Prisma connection pool utilization ratio',
    });
  }

  static getInstance(): MetricsService {
    if (!MetricsService.instance) {
      MetricsService.instance = new MetricsService();
    }
    return MetricsService.instance;
  }

  async getMetrics(): Promise<string> {
    return client.register.metrics();
  }

  getContentType(): string {
    return client.register.contentType;
  }

  setGaugeProvider(provider: () => Promise<{ openPositions: number; nav: number; wsConnections: number }>): void {
    this.gaugeProvider = provider;
  }

  startCollecting(): void {
    client.collectDefaultMetrics();

    this.collectInterval = setInterval(() => {
      const mem = process.memoryUsage();
      this.heapUsedGauge.set(mem.heapUsed);

      const start = performance.now();
      setImmediate(() => {
        const lag = performance.now() - start;
        this.eventLoopLagGauge.set(lag);
      });

      if (this.gaugeProvider) {
        this.gaugeProvider().then(({ openPositions, nav, wsConnections }) => {
          this.openPositionsGauge.set(openPositions);
          this.portfolioNavGauge.set(nav);
          this.wsConnectionsGauge.set(wsConnections);
        }).catch(() => {});
      }
    }, 10_000);

    log.info('Metrics collection started');
  }

  stopCollecting(): void {
    if (this.collectInterval) {
      clearInterval(this.collectInterval);
      this.collectInterval = null;
    }
    log.info('Metrics collection stopped');
  }

  recordOrderPlaced(side: string, orderType: string, mode: string): void {
    this.ordersPlaced.labels(side, orderType, mode).inc();
  }

  recordOrderFilled(side: string, mode: string): void {
    this.ordersFilled.labels(side, mode).inc();
  }

  recordOrderRejected(reason: string): void {
    this.ordersRejected.labels(reason).inc();
  }

  recordRiskViolation(ruleType: string): void {
    this.riskViolations.labels(ruleType).inc();
  }

  recordCircuitBreakerActivation(): void {
    this.circuitBreakerActivations.inc();
  }

  recordLatency(ms: number): void {
    this.orderLatency.observe(ms);
  }

  recordApiDuration(method: string, route: string, ms: number): void {
    this.apiRequestDuration.labels(method, route).observe(ms);
  }

  recordSummaryFetchDuration(ms: number): void {
    this.summaryFetchDuration.observe(ms);
  }

  setOpenPositions(n: number): void {
    this.openPositionsGauge.set(n);
  }

  setNav(n: number): void {
    this.portfolioNavGauge.set(n);
  }

  setWsConnections(n: number): void {
    this.wsConnectionsGauge.set(n);
  }

  setPrismaPoolUtilization(ratio: number): void {
    this.prismaPoolGauge.set(ratio);
  }
}
