import { buildApp } from './app.js';
import { env } from './config.js';
import net from 'net';
import { execSync } from 'child_process';

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

function killOrphanedRustDaemons(): void {
  try {
    const isWindows = process.platform === 'win32';
    if (isWindows) {
      execSync('taskkill /F /IM capital-guard-engine.exe 2>NUL', { stdio: 'ignore' });
    } else {
      execSync('pkill -f capital-guard-engine 2>/dev/null || true', { stdio: 'ignore' });
    }
  } catch { /* no orphans found */ }
}

function forceKillPortHolder(port: number): void {
  try {
    if (process.platform !== 'win32') {
      execSync(`fuser -k ${port}/tcp 2>/dev/null || true`, { stdio: 'ignore' });
    }
  } catch { /* nothing on port */ }
}

function claimPort(port: number, host: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const sentinel = net.createServer();
    sentinel.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[Startup] Port ${port} in use — killing holder and retrying...`);
        forceKillPortHolder(port);
        setTimeout(() => {
          const retry = net.createServer();
          retry.once('error', (err2: NodeJS.ErrnoException) => {
            console.error(`[Startup] Port ${port} still in use after kill — aborting`);
            reject(err2);
          });
          retry.once('listening', () => resolve(retry));
          retry.listen(port, host);
        }, 2000);
      } else {
        reject(err);
      }
    });
    sentinel.once('listening', () => resolve(sentinel));
    sentinel.listen(port, host);
  });
}

async function main(): Promise<void> {
  killOrphanedRustDaemons();

  console.log(`[Startup] Claiming port ${env.PORT}...`);
  const sentinel = await claimPort(env.PORT, env.HOST);
  console.log(`[Startup] Port ${env.PORT} claimed — initializing app...`);

  const app = await buildApp({ logger: false });

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM', app));
  process.on('SIGINT', () => gracefulShutdown('SIGINT', app));
  process.on('exit', () => {
    try { killOrphanedRustDaemons(); } catch { /* best effort */ }
  });

  sentinel.close(() => {
    app.listen({ host: env.HOST, port: env.PORT }).then(() => {
      console.log(`Capital Guard backend running on ${env.HOST}:${env.PORT}`);
      const mem = process.memoryUsage();
      console.log(`[MEMORY] Startup: Heap ${Math.round(mem.heapUsed / 1024 / 1024)}MB | RSS ${Math.round(mem.rss / 1024 / 1024)}MB`);
    }).catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
  });
}

main();
