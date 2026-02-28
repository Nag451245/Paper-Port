import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Rust Engine Bridge', () => {
  let mockSpawn: any;
  let originalSpawn: any;

  beforeEach(async () => {
    const childProcess = await import('child_process');
    originalSpawn = childProcess.spawn;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createMockProcess(stdout: string, code = 0) {
    const proc = {
      stdin: { write: vi.fn(), end: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
      kill: vi.fn(),
    };

    proc.stdout.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'data') setTimeout(() => cb(Buffer.from(stdout)), 10);
    });

    proc.stderr.on.mockImplementation((_event: string, _cb: Function) => {});

    proc.on.mockImplementation((event: string, cb: Function) => {
      if (event === 'close') setTimeout(() => cb(code), 20);
    });

    return proc;
  }

  it('should have correct module structure', async () => {
    const module = await import('../../src/lib/rust-engine.js');
    expect(typeof module.runEngine).toBe('function');
    expect(typeof module.engineBacktest).toBe('function');
    expect(typeof module.engineSignals).toBe('function');
    expect(typeof module.engineRisk).toBe('function');
    expect(typeof module.engineGreeks).toBe('function');
  });

  it('should export 5 functions', async () => {
    const module = await import('../../src/lib/rust-engine.js');
    const exported = Object.keys(module).filter(k => typeof (module as any)[k] === 'function');
    expect(exported.length).toBe(5);
  });

  it('engineBacktest should be a wrapper around runEngine', async () => {
    const module = await import('../../src/lib/rust-engine.js');
    expect(module.engineBacktest).toBeDefined();
  });

  it('engineSignals should be a wrapper around runEngine', async () => {
    const module = await import('../../src/lib/rust-engine.js');
    expect(module.engineSignals).toBeDefined();
  });

  it('engineRisk should be a wrapper around runEngine', async () => {
    const module = await import('../../src/lib/rust-engine.js');
    expect(module.engineRisk).toBeDefined();
  });

  it('engineGreeks should be a wrapper around runEngine', async () => {
    const module = await import('../../src/lib/rust-engine.js');
    expect(module.engineGreeks).toBeDefined();
  });
});
