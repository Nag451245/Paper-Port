/**
 * Engine availability must reflect whether the engine RUNS, not whether a file
 * exists.
 *
 * The shipped binary is built for Linux. On Windows `existsSync` is true while
 * every spawn fails with ENOENT, so `isEngineAvailable()` returned true,
 * `/health` reported `engine: ok`, and the dashboard displayed
 * "Rust Engine: Active" for a process that had never started and was producing
 * no signals. An autonomous system that misreports its own health acts
 * confidently on nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const { spawnMock, fsState } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  fsState: { exists: true },
}));

vi.mock('child_process', () => ({ spawn: spawnMock, ChildProcess: class {} }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(() => fsState.exists) },
    existsSync: vi.fn(() => fsState.exists),
  };
});

/** A fake child process that fails to spawn with the given errno. */
function spawnFailure(code: string) {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  setImmediate(() => {
    const err: any = new Error(`spawn ${code}`);
    err.code = code;
    proc.emit('error', err);
  });
  return proc;
}

/** A fake child process that answers with a JSON line then exits. */
function spawnSuccess(payload: unknown = { success: true }) {
  const proc: any = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  setImmediate(() => {
    proc.stdout.emit('data', Buffer.from(JSON.stringify(payload) + '\n'));
    proc.emit('close', 0);
  });
  return proc;
}

async function freshEngine() {
  vi.resetModules();
  return import('../../src/lib/rust-engine.js');
}

describe('engine availability reflects executability, not file presence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsState.exists = true;
  });

  it('reports not_installed when there is no binary', async () => {
    fsState.exists = false;
    const engine = await freshEngine();

    expect(engine.isEngineAvailable()).toBe(false);
    expect(engine.getEngineStatus().status).toBe('not_installed');
  });

  it('verifies a working binary and reports ok', async () => {
    spawnMock.mockImplementation(() => spawnSuccess());
    const engine = await freshEngine();

    await expect(engine.verifyEngineBinary()).resolves.toBe(true);
    expect(engine.isEngineAvailable()).toBe(true);
    expect(engine.getEngineStatus().status).toBe('ok');
  });

  it('reports UNUSABLE — not ok — when the binary exists but cannot spawn', async () => {
    // The exact Windows/Linux-binary case
    spawnMock.mockImplementation(() => spawnFailure('ENOENT'));
    const engine = await freshEngine();

    await expect(engine.verifyEngineBinary()).resolves.toBe(false);
    expect(engine.isEngineAvailable()).toBe(false);

    const status = engine.getEngineStatus();
    expect(status.status).toBe('unusable');
    expect(status.reason).toMatch(/ENOENT/);
    // The reason should point at the actual cause, not just echo the errno
    expect(status.reason).toMatch(/different OS\/architecture|execute permission/i);
  });

  it('treats a permissions failure as unusable too', async () => {
    spawnMock.mockImplementation(() => spawnFailure('EACCES'));
    const engine = await freshEngine();

    await expect(engine.verifyEngineBinary()).resolves.toBe(false);
    expect(engine.getEngineStatus().status).toBe('unusable');
  });

  it('rejects a binary that runs but does not speak the protocol', async () => {
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.kill = vi.fn();
    spawnMock.mockImplementation(() => {
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from('not json at all'));
        proc.emit('close', 0);
      });
      return proc;
    });
    const engine = await freshEngine();

    await expect(engine.verifyEngineBinary()).resolves.toBe(false);
    expect(engine.getEngineStatus().reason).toMatch(/not JSON/i);
  });

  it('rejects a binary that produces no output', async () => {
    const proc: any = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.kill = vi.fn();
    spawnMock.mockImplementation(() => {
      setImmediate(() => proc.emit('close', 0));
      return proc;
    });
    const engine = await freshEngine();

    await expect(engine.verifyEngineBinary()).resolves.toBe(false);
    expect(engine.getEngineStatus().reason).toMatch(/no output/i);
  });

  it('stays unavailable once proven unusable, even though the file is still there', async () => {
    spawnMock.mockImplementation(() => spawnFailure('ENOENT'));
    const engine = await freshEngine();
    await engine.verifyEngineBinary();

    // File presence must not resurrect a known-dead engine
    expect(fsState.exists).toBe(true);
    expect(engine.isEngineAvailable()).toBe(false);
    expect(engine.isEngineAvailable()).toBe(false);
  });

  it('ensureEngineAvailable returns false for a present-but-unusable binary', async () => {
    spawnMock.mockImplementation(() => spawnFailure('ENOEXEC'));
    const engine = await freshEngine();

    // Previously this returned true purely because the file existed
    await expect(engine.ensureEngineAvailable()).resolves.toBe(false);
  });
});
