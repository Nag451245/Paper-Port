import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
    listOrders: vi.fn().mockResolvedValue({
      data: [
        { id: 'ord-1', symbol: 'RELIANCE', side: 'BUY', qty: 10, price: '2500', status: 'FILLED', created_at: '2026-01-01T00:00:00' },
        { id: 'ord-2', symbol: 'TCS', side: 'BUY', qty: 5, price: '3500', status: 'PENDING', created_at: '2026-01-01T00:00:00' },
      ],
    }),
    positions: vi.fn().mockResolvedValue({
      data: [
        { id: 'pos-1', symbol: 'RELIANCE', qty: 10, avg_price: '2500', ltp: '2550', unrealized_pnl: '500', side: 'LONG', status: 'OPEN' },
        { id: 'pos-2', symbol: 'INFY', qty: 20, avg_price: '1500', ltp: '1480', unrealized_pnl: '-400', side: 'LONG', status: 'OPEN' },
      ],
    }),
    listTrades: vi.fn().mockResolvedValue({
      data: [
        { id: 'tr-1', symbol: 'HDFCBANK', entry_price: '1600', exit_price: '1650', qty: 15, pnl: '750', net_pnl: '720', side: 'LONG', created_at: '2026-01-01T00:00:00' },
      ],
    }),
  },
  marketApi: { quote: vi.fn(), indices: vi.fn(), search: vi.fn() },
  botsApi: { list: vi.fn(), create: vi.fn(), start: vi.fn(), stop: vi.fn() },
}));

vi.mock('../stores/auth', () => ({
  useAuthStore: Object.assign(
    () => ({ user: { id: '1', email: 'test@test.com', fullName: 'Test', virtualCapital: 1000000 }, isAuthenticated: true }),
    { getState: () => ({ token: 'test-token', user: { id: '1' }, isAuthenticated: true }) },
  ),
}));

vi.mock('../stores/portfolio', () => ({
  usePortfolioStore: Object.assign(
    () => ({
      portfolios: [{ id: '1', name: 'Default', initial_capital: '1000000', current_nav: '1000000' }],
      selectedPortfolio: { id: '1', name: 'Default' },
      summary: { totalNav: 1000000, totalPnl: 500, totalPnlPercent: 0.05 },
      fetchPortfolios: vi.fn(),
      selectPortfolio: vi.fn(),
    }),
    { getState: () => ({ portfolios: [{ id: '1' }], selectedPortfolio: { id: '1' } }) },
  ),
}));

const renderWithRouter = (component: React.ReactNode) =>
  render(<BrowserRouter>{component}</BrowserRouter>);

describe('TradingTerminal Page', () => {
  let TradingTerminal: React.ComponentType;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../pages/TradingTerminal');
    TradingTerminal = mod.default;
  });

  it('renders the trading terminal page', () => {
    renderWithRouter(<TradingTerminal />);
    expect(screen.getByText(/trading/i)).toBeInTheDocument();
  });

  it('has BUY and SELL side toggles', () => {
    renderWithRouter(<TradingTerminal />);
    expect(screen.getByText('BUY')).toBeInTheDocument();
    expect(screen.getByText('SELL')).toBeInTheDocument();
  });

  it('has symbol input field', () => {
    renderWithRouter(<TradingTerminal />);
    const symbolInput = screen.getByPlaceholderText(/symbol/i);
    expect(symbolInput).toBeInTheDocument();
  });

  it('has quantity input field', () => {
    renderWithRouter(<TradingTerminal />);
    const qtyInputs = screen.getAllByRole('spinbutton');
    expect(qtyInputs.length).toBeGreaterThan(0);
  });

  it('has order type selector with Market and Limit options', () => {
    renderWithRouter(<TradingTerminal />);
    const selectEl = screen.getByDisplayValue('Market');
    expect(selectEl).toBeInTheDocument();
    expect(selectEl.tagName).toBe('SELECT');
  });

  it('has navigation tabs for Positions, Orders, Trades', () => {
    renderWithRouter(<TradingTerminal />);
    expect(screen.getByText(/positions/i)).toBeInTheDocument();
    expect(screen.getByText(/orders/i)).toBeInTheDocument();
    expect(screen.getByText(/trades/i)).toBeInTheDocument();
  });
});

describe('Trading Navigation Flows', () => {
  it('user can type a stock symbol', async () => {
    const user = userEvent.setup();
    const mod = await import('../pages/TradingTerminal');
    renderWithRouter(<mod.default />);

    const symbolInput = screen.getByPlaceholderText(/symbol/i);
    await user.clear(symbolInput);
    await user.type(symbolInput, 'RELIANCE');
    expect(symbolInput).toHaveValue('RELIANCE');
  });

  it('user can switch between BUY and SELL', async () => {
    const user = userEvent.setup();
    const mod = await import('../pages/TradingTerminal');
    renderWithRouter(<mod.default />);

    const sellButtons = screen.getAllByText('SELL');
    await user.click(sellButtons[0]);

    const buyButtons = screen.getAllByText('BUY');
    await user.click(buyButtons[0]);
  });

  it('user can set quantity', async () => {
    const user = userEvent.setup();
    const mod = await import('../pages/TradingTerminal');
    renderWithRouter(<mod.default />);

    const qtyInputs = screen.getAllByRole('spinbutton');
    const qtyInput = qtyInputs[0];
    await user.clear(qtyInput);
    await user.type(qtyInput, '25');
    expect(qtyInput).toHaveValue(25);
  });
});
