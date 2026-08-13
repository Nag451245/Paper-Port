import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';

vi.mock('../services/api', () => ({
  default: {
    post: vi.fn().mockResolvedValue({ data: {} }),
    get: vi.fn().mockResolvedValue({ data: [] }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
    interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
  },
  authApi: { login: vi.fn(), register: vi.fn(), me: vi.fn() },
  portfolioApi: {
    list: () => Promise.resolve({ data: [{ id: '1', name: 'Default', initial_capital: '1000000', current_nav: '1000000' }] }),
    summary: vi.fn().mockResolvedValue({ data: {} }),
    updateCapital: vi.fn(),
  },
  tradingApi: {
    placeOrder: vi.fn().mockResolvedValue({ data: { id: 'ord-1', symbol: 'RELIANCE', status: 'FILLED' } }),
    cancelOrder: vi.fn().mockResolvedValue({ data: {} }),
    listOrders: vi.fn().mockResolvedValue({ data: [] }),
    positions: vi.fn().mockResolvedValue({ data: [] }),
    listTrades: vi.fn().mockResolvedValue({ data: [] }),
  },
  marketApi: {
    quote: vi.fn().mockResolvedValue({ data: { symbol: 'RELIANCE', ltp: 2500 } }),
    indices: vi.fn().mockResolvedValue({ data: [] }),
    search: vi.fn().mockResolvedValue({ data: [] }),
  },
  botsApi: { list: vi.fn(), create: vi.fn(), start: vi.fn(), stop: vi.fn() },
}));

vi.mock('../stores/auth', () => ({
  useAuthStore: Object.assign(
    () => ({ user: { id: '1', email: 'test@test.com', fullName: 'Test', virtualCapital: 1000000 }, isAuthenticated: true }),
    { getState: () => ({ token: 'test-token', user: { id: '1' }, isAuthenticated: true }) },
  ),
}));

vi.mock('lightweight-charts', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    createChart: vi.fn().mockReturnValue({
      addSeries: vi.fn().mockReturnValue({ setData: vi.fn(), applyOptions: vi.fn() }),
      addAreaSeries: vi.fn().mockReturnValue({ setData: vi.fn(), applyOptions: vi.fn() }),
      addHistogramSeries: vi.fn().mockReturnValue({ setData: vi.fn(), applyOptions: vi.fn() }),
      addCandlestickSeries: vi.fn().mockReturnValue({ setData: vi.fn(), applyOptions: vi.fn() }),
      applyOptions: vi.fn(),
      timeScale: vi.fn().mockReturnValue({ fitContent: vi.fn(), applyOptions: vi.fn() }),
      remove: vi.fn(),
      resize: vi.fn(),
    }),
  };
});

const renderPage = async () => {
  const mod = await import('../pages/TradingTerminal');
  return render(
    <BrowserRouter>
      <mod.default />
    </BrowserRouter>,
  );
};

describe('TradingTerminal Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders exchange filter buttons', async () => {
    await renderPage();
    expect(screen.getByText('All Markets')).toBeInTheDocument();
    expect(screen.getByText('NSE')).toBeInTheDocument();
  });

  it('has BUY and SELL side toggles', async () => {
    await renderPage();
    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('SELL')).toBeInTheDocument();
  });

  it('has search input field', async () => {
    await renderPage();
    const searchInput = screen.getByPlaceholderText(/Search symbol/i);
    expect(searchInput).toBeInTheDocument();
  });

  it('has quantity input field', async () => {
    await renderPage();
    const qtyInputs = screen.getAllByRole('spinbutton');
    expect(qtyInputs.length).toBeGreaterThan(0);
  });

  it('has navigation tabs for Positions, Orders, Trades', async () => {
    await renderPage();
    expect(screen.getByText(/Positions/i)).toBeInTheDocument();
    expect(screen.getByText(/Orders/i)).toBeInTheDocument();
    expect(screen.getByText(/Trades/i)).toBeInTheDocument();
  });
});

describe('Trading Navigation Flows', () => {
  it('user can type a stock symbol', async () => {
    const user = userEvent.setup();
    await renderPage();
    const searchInput = screen.getByPlaceholderText(/Search symbol/i);
    await user.clear(searchInput);
    await user.type(searchInput, 'RELIANCE');
    expect(searchInput).toHaveValue('RELIANCE');
  });

  it('user can switch between BUY and SELL', async () => {
    const user = userEvent.setup();
    await renderPage();
    const sellButtons = screen.getAllByText('SELL');
    await user.click(sellButtons[0]);
    const buyButtons = screen.getAllByText('BUY');
    await user.click(buyButtons[0]);
  });

  it('user can set quantity', async () => {
    const user = userEvent.setup();
    await renderPage();
    const qtyInputs = screen.getAllByRole('spinbutton');
    const qtyInput = qtyInputs[0];
    await user.clear(qtyInput);
    await user.type(qtyInput, '25');
    expect(qtyInput).toHaveValue(25);
  });
});
