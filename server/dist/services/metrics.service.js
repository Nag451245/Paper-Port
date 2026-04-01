import client from 'prom-client';
import { createChildLogger } from '../lib/logger.js';
const log = createChildLogger('MetricsService');
export class MetricsService {
    static instance;
    ordersPlaced;
    ordersFilled;
    ordersRejected;
    riskViolations;
    circuitBreakerActivations;
    orderLatency;
    apiRequestDuration;
    summaryFetchDuration;
    openPositionsGauge;
    portfolioNavGauge;
    heapUsedGauge;
    eventLoopLagGauge;
    wsConnectionsGauge;
    prismaPoolGauge;
    collectInterval = null;
    gaugeProvider;
    constructor() {
        this.ordersPlaced = new client.Counter({
            name: 'orders_placed_total',
            help: 'Total orders placed',
            labelNames: ['side', 'orderType', 'mode'],
        });
        this.ordersFilled = new client.Counter({
            name: 'orders_filled_total',
            help: 'Total orders filled',
            labelNames: ['side', 'mode'],
        });
        this.ordersRejected = new client.Counter({
            name: 'orders_rejected_total',
            help: 'Total orders rejected',
            labelNames: ['reason'],
        });
        this.riskViolations = new client.Counter({
            name: 'risk_violations_total',
            help: 'Total risk rule violations',
            labelNames: ['ruleType'],
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
            labelNames: ['method', 'route'],
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
    static getInstance() {
        if (!MetricsService.instance) {
            MetricsService.instance = new MetricsService();
        }
        return MetricsService.instance;
    }
    async getMetrics() {
        return client.register.metrics();
    }
    getContentType() {
        return client.register.contentType;
    }
    setGaugeProvider(provider) {
        this.gaugeProvider = provider;
    }
    startCollecting() {
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
                }).catch(() => { });
            }
        }, 10_000);
        log.info('Metrics collection started');
    }
    stopCollecting() {
        if (this.collectInterval) {
            clearInterval(this.collectInterval);
            this.collectInterval = null;
        }
        log.info('Metrics collection stopped');
    }
    recordOrderPlaced(side, orderType, mode) {
        this.ordersPlaced.labels(side, orderType, mode).inc();
    }
    recordOrderFilled(side, mode) {
        this.ordersFilled.labels(side, mode).inc();
    }
    recordOrderRejected(reason) {
        this.ordersRejected.labels(reason).inc();
    }
    recordRiskViolation(ruleType) {
        this.riskViolations.labels(ruleType).inc();
    }
    recordCircuitBreakerActivation() {
        this.circuitBreakerActivations.inc();
    }
    recordLatency(ms) {
        this.orderLatency.observe(ms);
    }
    recordApiDuration(method, route, ms) {
        this.apiRequestDuration.labels(method, route).observe(ms);
    }
    recordSummaryFetchDuration(ms) {
        this.summaryFetchDuration.observe(ms);
    }
    setOpenPositions(n) {
        this.openPositionsGauge.set(n);
    }
    setNav(n) {
        this.portfolioNavGauge.set(n);
    }
    setWsConnections(n) {
        this.wsConnectionsGauge.set(n);
    }
    setPrismaPoolUtilization(ratio) {
        this.prismaPoolGauge.set(ratio);
    }
}
//# sourceMappingURL=metrics.service.js.map