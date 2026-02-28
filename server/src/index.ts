import { buildApp } from './app.js';
import { env } from './config.js';

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason instanceof Error ? reason.message : reason);
});

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
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

async function main(): Promise<void> {
  const app = await buildApp({ logger: false });

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    console.log(`Capital Guard backend running on ${env.HOST}:${env.PORT}`);
    const mem = process.memoryUsage();
    console.log(`[MEMORY] Startup: Heap ${Math.round(mem.heapUsed / 1024 / 1024)}MB | RSS ${Math.round(mem.rss / 1024 / 1024)}MB`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
