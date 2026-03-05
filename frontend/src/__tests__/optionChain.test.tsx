import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

const MOCK_STRIKES = [
  { strike: 23400, callOI: 500, callOIChange: 10, callVolume: 200, callIV: 12, callLTP: 150, callNetChange: 5, callBidPrice: 149, callAskPrice: 151, callDelta: 0.6, callGamma: 0.002, callTheta: -3, callVega: 8, putOI: 300, putOIChange: -5, putVolume: 100, putIV: 13, putLTP: 50, putNetChange: -2, putBidPrice: 49, putAskPrice: 51, putDelta: -0.4, putGamma: 0.002, putTheta: -2.5, putVega: 7 },
  { strike: 23500, callOI: 800, callOIChange: 20, callVolume: 400, callIV: 11, callLTP: 100, callNetChange: 3, callBidPrice: 99, callAskPrice: 101, callDelta: 0.5, callGamma: 0.003, callTheta: -4, callVega: 9, putOI: 600, putOIChange: 15, putVolume: 300, putIV: 12, putLTP: 90, putNetChange: -1, putBidPrice: 89, putAskPrice: 91, putDelta: -0.5, putGamma: 0.003, putTheta: -3.5, putVega: 8 },
  { strike: 23600, callOI: 400, callOIChange: 5, callVolume: 150, callIV: 13, callLTP: 60, callNetChange: 1, callBidPrice: 59, callAskPrice: 61, callDelta: 0.4, callGamma: 0.002, callTheta: -2, callVega: 7, putOI: 900, putOIChange: 30, putVolume: 500, putIV: 14, putLTP: 140, putNetChange: 4, putBidPrice: 139, putAskPrice: 141, putDelta: -0.6, putGamma: 0.002, putTheta: -4, putVega: 9 },
];

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
  },
  marketApi: {
    optionsChain: vi.fn().mockResolvedValue({
      data: { symbol: 'NIFTY', strikes: MOCK_STRIKES, expiry: '2026-03-12', underlyingValue: 23500, spotPrice: 23500, source: 'test' },
    }),
    optionsExpiries: vi.fn().mockResolvedValue({
      data: { symbol: 'NIFTY', expiries: ['2026-03-12', '2026-03-19'] },
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
    await waitFor(() => {
      expect(screen.getByText('Max Pain')).toBeDefined();
    });
  });

  it('should render Support and Resistance sections', async () => {
    await renderPage();
    await waitFor(() => {
      const supportElements = screen.getAllByText(/Support/i);
      expect(supportElements.length).toBeGreaterThan(0);
      const resistanceElements = screen.getAllByText(/Resistance/i);
      expect(resistanceElements.length).toBeGreaterThan(0);
    });
  });

  it('should render strike rows when demo data is loaded', async () => {
    await renderPage();
    await waitFor(() => {
      const rows = screen.getAllByRole('row');
      expect(rows.length).toBeGreaterThan(1);
    });
  });
});
