import { buildApp } from './app.js';
import { env } from './config.js';

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.stack ?? err.message);
  process.stderr.write('', () => process.exit(1));
  setTimeout(() => process.exit(1), 3000).unref();
});

const HEAP_LIMIT_MB = 512;
let lastHeapCheck = 0;
setInterval(() => {
  const mem = process.memoryUsage();
  const heapMB = Math.round(mem.heapUsed / 1024 / 1024);
  if (heapMB > HEAP_LIMIT_MB) {
    console.warn(`[MEMORY] Heap ${heapMB}MB > ${HEAP_LIMIT_MB}MB limit — forcing GC if available`);
    if (global.gc) global.gc();
  }
  if (Date.now() - lastHeapCheck > 300_000) {
    lastHeapCheck = Date.now();
    console.log(`[MEMORY] Heap: ${heapMB}MB | RSS: ${Math.round(mem.rss / 1024 / 1024)}MB`);
  }
}, 60_000);

let isShuttingDown = false;

async function gracefulShutdown(signal: string, app: ReturnType<typeof buildApp> extends Promise<infer T> ? T : never): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[SHUTDOWN] Received ${signal} — starting graceful shutdown...`);

  const shutdownTimeout = setTimeout(() => {
    console.error('[SHUTDOWN] Timed out after 15s — forcing exit');
    process.exit(1);
  }, 15_000);

  try {
    await app.close();
    console.log('[SHUTDOWN] Fastify closed (DB, Redis, services, Rust engine stopped)');
  } catch (err) {
    console.error('[SHUTDOWN] Error during close:', err instanceof Error ? err.message : err);
  } finally {
    clearTimeout(shutdownTimeout);
    console.log('[SHUTDOWN] Goodbye.');
    process.exit(0);
  }
}

async function main(): Promise<void> {
  let app;
  try {
    app = await buildApp({ logger: false });
  } catch (err) {
    console.error('[FATAL] App init failed:', err);
    process.exit(1);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM', app));
  process.on('SIGINT', () => gracefulShutdown('SIGINT', app));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    console.log(`Capital Guard backend running on ${env.HOST}:${env.PORT}`);
    const mem = process.memoryUsage();
    console.log(`[MEMORY] Startup: Heap ${Math.round(mem.heapUsed / 1024 / 1024)}MB | RSS ${Math.round(mem.rss / 1024 / 1024)}MB`);
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      console.error(`[FATAL] Port ${env.PORT} already in use — exiting (PM2 will retry after delay)`);
    } else {
      console.error('Failed to start server:', err);
    }
    process.exit(1);
  }
}

main();
