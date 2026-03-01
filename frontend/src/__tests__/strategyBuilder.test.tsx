import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../services/api', () => {
  const mockApi = {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn().mockResolvedValue({
      data: {
        payoffCurve: [{ spotPrice: 100, pnl: -5 }, { spotPrice: 110, pnl: 5 }],
        greeks: { delta: 0.5, gamma: 0.03, theta: -2, vega: 8, rho: 0.01, netPremium: -5, maxProfit: 100, maxLoss: -5, breakevens: [105] },
      },
    }),
    interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
  };
  return {
    default: mockApi,
    marketApi: { quote: vi.fn().mockResolvedValue({ data: { ltp: 23500 } }) },
  };
});

vi.mock('../stores/auth', () => ({
  useAuthStore: Object.assign(
    () => ({ user: { id: '1', email: 'test@test.com', fullName: 'Test User', virtualCapital: 1000000 }, isAuthenticated: true }),
    { getState: () => ({ token: 'test-token', user: { id: '1' }, isAuthenticated: true }) },
  ),
}));

vi.mock('recharts', () => ({
  AreaChart: ({ children }: any) => <div data-testid="area-chart">{children}</div>,
  Area: () => <div data-testid="area" />,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  CartesianGrid: () => null,
  ReferenceLine: () => null,
}));

const renderPage = async () => {
  const { default: StrategyBuilder } = await import('../pages/StrategyBuilder');
  return render(
    <BrowserRouter>
      <StrategyBuilder />
    </BrowserRouter>,
  );
};

describe('StrategyBuilder Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render strategy template cards', async () => {
    await renderPage();
    expect(screen.getByText('Strategy Templates')).toBeDefined();
  });

  it('should render Bull Call Spread template', async () => {
    await renderPage();
    expect(screen.getByText('Bull Call Spread')).toBeDefined();
  });

  it('should render the All filter button', async () => {
    await renderPage();
    const allButtons = screen.getAllByText('All');
    expect(allButtons.length).toBeGreaterThan(0);
  });

  it('should render the legs table', async () => {
    await renderPage();
    expect(screen.getByText('Strategy Legs')).toBeDefined();
  });

  it('should render payoff chart section', async () => {
    await renderPage();
    expect(screen.getByText('Payoff Diagram')).toBeDefined();
  });

  it('should have an Add Leg button', async () => {
    await renderPage();
    expect(screen.getByText('Add Leg')).toBeDefined();
  });

  it('should render the Scenario Simulator section', async () => {
    await renderPage();
    expect(screen.getByText('Scenario Simulator')).toBeDefined();
  });
});
