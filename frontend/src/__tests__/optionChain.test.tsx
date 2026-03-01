import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
  },
  marketApi: {
    optionsChain: vi.fn().mockResolvedValue({
      data: { symbol: 'NIFTY', strikes: [], expiry: '', underlyingValue: 23500 },
    }),
    vix: vi.fn().mockResolvedValue({ data: { value: 14, change: 0, changePercent: 0 } }),
  },
}));

vi.mock('../stores/auth', () => ({
  useAuthStore: Object.assign(
    () => ({ user: { id: '1', email: 'test@test.com', fullName: 'Test User', virtualCapital: 1000000 }, isAuthenticated: true }),
    { getState: () => ({ token: 'test-token', user: { id: '1' }, isAuthenticated: true }) },
  ),
}));

vi.mock('recharts', () => ({
  BarChart: ({ children }: any) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
  CartesianGrid: () => null,
  Legend: () => null,
}));

const renderPage = async () => {
  const { default: OptionChain } = await import('../pages/OptionChain');
  return render(
    <BrowserRouter>
      <OptionChain />
    </BrowserRouter>,
  );
};

describe('OptionChain Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render the Option Chain heading', async () => {
    await renderPage();
    expect(screen.getByText('Option Chain')).toBeDefined();
  });

  it('should render Max Pain section', async () => {
    await renderPage();
    expect(screen.getByText('Max Pain')).toBeDefined();
  });

  it('should render Support and Resistance sections', async () => {
    await renderPage();
    const supportElements = screen.getAllByText(/Support/i);
    expect(supportElements.length).toBeGreaterThan(0);
    const resistanceElements = screen.getAllByText(/Resistance/i);
    expect(resistanceElements.length).toBeGreaterThan(0);
  });

  it('should render strike rows when demo data is loaded', async () => {
    await renderPage();
    await waitFor(() => {
      const rows = screen.getAllByRole('row');
      expect(rows.length).toBeGreaterThan(1);
    });
  });
});
