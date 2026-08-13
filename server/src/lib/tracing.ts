import { env } from '../config.js';

let tracingInitialized = false;
let tracingActive = false;

export async function initTracing(): Promise<void> {
  if (tracingInitialized) return;

  const otlpEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || '';
  if (!otlpEndpoint) {
    console.log('[Tracing] OTEL_EXPORTER_OTLP_ENDPOINT not set, tracing disabled');
    tracingInitialized = true;
    return;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const createRequire = (await import('node:module')).createRequire;
    const require = createRequire(import.meta.url);

    const { NodeSDK } = require('@opentelemetry/sdk-node') as { NodeSDK: new (opts: Record<string, unknown>) => { start(): void; shutdown(): Promise<void> } };
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node') as { getNodeAutoInstrumentations: (opts?: Record<string, unknown>) => unknown[] };
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http') as { OTLPTraceExporter: new (opts: { url: string }) => unknown };
    const { Resource } = require('@opentelemetry/resources') as { Resource: new (attrs: Record<string, string>) => unknown };

    const sdk = new NodeSDK({
      resource: new Resource({
        'service.name': 'capital-guard-api',
        'service.version': '1.0.0',
      }),
      traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
      instrumentations: [getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': { enabled: false },
      })],
    });

    sdk.start();
    tracingInitialized = true;
    tracingActive = true;
    console.log(`[Tracing] OpenTelemetry initialized, exporting to ${otlpEndpoint}`);

    process.on('SIGTERM', () => { sdk.shutdown(); });
  } catch (err) {
    console.warn(`[Tracing] OpenTelemetry packages not installed, tracing disabled: ${(err as Error).message}`);
    tracingInitialized = true;
  }
}

export function isTracingEnabled(): boolean {
  return tracingActive;
}
