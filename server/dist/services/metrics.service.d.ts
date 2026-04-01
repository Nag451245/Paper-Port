export declare class MetricsService {
    private static instance;
    private ordersPlaced;
    private ordersFilled;
    private ordersRejected;
    private riskViolations;
    private circuitBreakerActivations;
    private orderLatency;
    private apiRequestDuration;
    private summaryFetchDuration;
    private openPositionsGauge;
    private portfolioNavGauge;
    private heapUsedGauge;
    private eventLoopLagGauge;
    private wsConnectionsGauge;
    private prismaPoolGauge;
    private collectInterval;
    private gaugeProvider?;
    private constructor();
    static getInstance(): MetricsService;
    getMetrics(): Promise<string>;
    getContentType(): string;
    setGaugeProvider(provider: () => Promise<{
        openPositions: number;
        nav: number;
        wsConnections: number;
    }>): void;
    startCollecting(): void;
    stopCollecting(): void;
    recordOrderPlaced(side: string, orderType: string, mode: string): void;
    recordOrderFilled(side: string, mode: string): void;
    recordOrderRejected(reason: string): void;
    recordRiskViolation(ruleType: string): void;
    recordCircuitBreakerActivation(): void;
    recordLatency(ms: number): void;
    recordApiDuration(method: string, route: string, ms: number): void;
    recordSummaryFetchDuration(ms: number): void;
    setOpenPositions(n: number): void;
    setNav(n: number): void;
    setWsConnections(n: number): void;
    setPrismaPoolUtilization(ratio: number): void;
}
//# sourceMappingURL=metrics.service.d.ts.map