import { createServer, type Server } from 'net';
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

/**
 * Claim the port with a raw TCP server to prevent races during heavy init.
 * Retries with progressive delays and force-kills stale holders after 3 failures.
 */
async function reservePort(port: number, host: string): Promise<Server> {
  const maxAttempts = 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const guard = createServer();
      await new Promise<void>((resolve, reject) => {
        guard.once('error', reject);
        guard.once('listening', () => resolve());
        guard.listen(port, host);
      });
      return guard;
    } catch (err: any) {
      if (err.code !== 'EADDRINUSE') throw err;

      const delaySec = Math.min(attempt * 2, 10);
      console.warn(`[Startup] Port ${port} in use — retry ${attempt}/${maxAttempts} in ${delaySec}s`);

      if (attempt >= 3 && process.platform === 'linux') {
        try {
          const { execSync } = await import('child_process');
          execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { timeout: 5000 });
          console.log(`[Startup] Sent kill to process on port ${port}`);
        } catch { /* best effort */ }
      }

      await new Promise(r => setTimeout(r, delaySec * 1000));
    }
  }

  console.error(`[FATAL] Cannot bind port ${port} after ${maxAttempts} attempts — exiting`);
  process.exit(1);
}

async function main(): Promise<void> {
  const portGuard = await reservePort(env.PORT, env.HOST);
  console.log(`[Startup] Port ${env.PORT} reserved — initializing app...`);

  let app;
  try {
    app = await buildApp({ logger: false });
  } catch (err) {
    portGuard.close();
    console.error('[FATAL] App init failed:', err);
    process.exit(1);
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM', app));
  process.on('SIGINT', () => gracefulShutdown('SIGINT', app));

  portGuard.close();
  await new Promise<void>(r => portGuard.once('close', r));

  for (let retry = 0; retry < 3; retry++) {
    try {
      await app.listen({ host: env.HOST, port: env.PORT });
      console.log(`Capital Guard backend running on ${env.HOST}:${env.PORT}`);
      const mem = process.memoryUsage();
      console.log(`[MEMORY] Startup: Heap ${Math.round(mem.heapUsed / 1024 / 1024)}MB | RSS ${Math.round(mem.rss / 1024 / 1024)}MB`);
      return;
    } catch (err: any) {
      if (err.code === 'EADDRINUSE' && retry < 2) {
        console.warn(`[Startup] Port ${env.PORT} briefly contested — retry ${retry + 1}/3`);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  }
}

main();
