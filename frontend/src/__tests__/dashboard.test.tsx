import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';

// --- Mocks ---

vi.mock('../services/api', () => ({
    default: {
        post: vi.fn(), get: vi.fn(), delete: vi.fn(),
        interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
    },
    authApi: { login: vi.fn(), register: vi.fn(), me: vi.fn() },
    portfolioApi: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        summary: vi.fn().mockResolvedValue({ data: null }),
    },
    tradingApi: {
        positions: vi.fn().mockResolvedValue({ data: [] }),
        listOrders: vi.fn().mockResolvedValue({ data: [] }),
        listTrades: vi.fn().mockResolvedValue({ data: [] }),
    },
    marketApi: {
        indices: vi.fn().mockResolvedValue({ data: [] }),
        vix: vi.fn().mockResolvedValue({ data: { value: 14.32, change: -0.5, changePercent: -3.38 } }),
        fiiDii: vi.fn().mockResolvedValue({ data: {} }),
    },
    watchlistApi: {
        list: vi.fn().mockResolvedValue({ data: [] }),
    },
    aiAgentApi: {
        status: vi.fn().mockResolvedValue({ data: { isActive: false, mode: 'advisory', uptime: 0 } }),
        preMarketBriefing: vi.fn().mockResolvedValue({ data: null }),
        getConfig: vi.fn(),
        signals: vi.fn(),
        strategies: vi.fn(),
        capitalRules: vi.fn(),
    },
    botsApi: { list: vi.fn(), create: vi.fn() },
}));

vi.mock('../services/websocket', () => ({
    priceFeed: { subscribe: vi.fn(), unsubscribe: vi.fn() },
}));

vi.mock('../stores/auth', () => ({
    useAuthStore: Object.assign(
        () => ({ user: { id: '1', email: 'test@test.com', fullName: 'Test', virtualCapital: 1000000 }, isAuthenticated: true }),
        { getState: () => ({ token: 'test-token', user: { id: '1' }, isAuthenticated: true }) },
    ),
}));

const renderWithRouter = (component: React.ReactNode) =>
    render(<BrowserRouter>{component}</BrowserRouter>);

// --- Dashboard Tests ---

describe('Dashboard Component Integration', () => {
    let Dashboard: React.ComponentType;

    beforeEach(async () => {
        vi.clearAllMocks();
        const mod = await import('../pages/Dashboard');
        Dashboard = mod.default;
    });

    it('renders the dashboard title', () => {
        renderWithRouter(<Dashboard />);
        expect(screen.getByText('Dashboard')).toBeInTheDocument();
    });

    it('renders global indices strip', () => {
        renderWithRouter(<Dashboard />);
        expect(screen.getByText('S&P 500')).toBeInTheDocument();
        expect(screen.getByText('Nasdaq')).toBeInTheDocument();
        expect(screen.getByText('SGX Nifty')).toBeInTheDocument();
    });

    it('renders portfolio section with empty state when no portfolios', async () => {
        renderWithRouter(<Dashboard />);
        expect(screen.getByText(/portfolio summary/i)).toBeInTheDocument();
        // Wait for async fetchPortfolios to resolve and render empty state
        await waitFor(() => {
            expect(screen.getByText(/no portfolios yet/i)).toBeInTheDocument();
        });
    });

    it('renders AI Agent section with inactive status', () => {
        renderWithRouter(<Dashboard />);
        expect(screen.getByText(/ai agent/i)).toBeInTheDocument();
        expect(screen.getByText('Inactive')).toBeInTheDocument();
    });

    it('renders Pre-Market Briefing section with empty state', () => {
        renderWithRouter(<Dashboard />);
        expect(screen.getAllByText(/pre-market briefing/i).length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText(/no briefing available yet/i)).toBeInTheDocument();
    });

    it('renders India VIX section with default values', () => {
        renderWithRouter(<Dashboard />);
        expect(screen.getByText(/india vix/i)).toBeInTheDocument();
        // Default VIX ~14.32 should show "low volatility" message
        expect(screen.getByText(/low volatility/i)).toBeInTheDocument();
    });

    it('renders watchlist section with empty state', () => {
        renderWithRouter(<Dashboard />);
        expect(screen.getAllByText(/watchlist/i).length).toBeGreaterThanOrEqual(1);
        expect(screen.getByText(/no watchlist items yet/i)).toBeInTheDocument();
    });

    it("renders today's trades section", () => {
        renderWithRouter(<Dashboard />);
        expect(screen.getByText(/today's trades/i)).toBeInTheDocument();
        expect(screen.getByText(/no trades today yet/i)).toBeInTheDocument();
    });
});
