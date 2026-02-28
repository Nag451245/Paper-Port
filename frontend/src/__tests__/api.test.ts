import { describe, it, expect, vi } from 'vitest';

vi.mock('axios', () => {
  const mockAxios = {
    create: vi.fn(() => mockAxios),
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    defaults: { headers: { common: {} } },
  };
  return { default: mockAxios };
});

describe('API Module', () => {
  it('exports required API namespaces', async () => {
    const api = await import('../services/api');
    expect(api.authApi).toBeDefined();
    expect(api.portfolioApi).toBeDefined();
    expect(api.tradingApi).toBeDefined();
    expect(api.marketApi).toBeDefined();
    expect(api.botsApi).toBeDefined();
  });

  it('authApi has login and register methods', async () => {
    const { authApi } = await import('../services/api');
    expect(typeof authApi.login).toBe('function');
    expect(typeof authApi.register).toBe('function');
    expect(typeof authApi.me).toBe('function');
  });

  it('portfolioApi has list and summary methods', async () => {
    const { portfolioApi } = await import('../services/api');
    expect(typeof portfolioApi.list).toBe('function');
    expect(typeof portfolioApi.summary).toBe('function');
    expect(typeof portfolioApi.updateCapital).toBe('function');
  });

  it('tradingApi has order methods', async () => {
    const { tradingApi } = await import('../services/api');
    expect(typeof tradingApi.placeOrder).toBe('function');
    expect(typeof tradingApi.listOrders).toBe('function');
    expect(typeof tradingApi.positions).toBe('function');
  });

  it('botsApi has bot management methods', async () => {
    const { botsApi } = await import('../services/api');
    expect(typeof botsApi.list).toBe('function');
    expect(typeof botsApi.create).toBe('function');
    expect(typeof botsApi.start).toBe('function');
    expect(typeof botsApi.stop).toBe('function');
  });

  it('marketApi has market data methods', async () => {
    const { marketApi } = await import('../services/api');
    expect(typeof marketApi.indices).toBe('function');
    expect(typeof marketApi.quote).toBe('function');
  });
});
