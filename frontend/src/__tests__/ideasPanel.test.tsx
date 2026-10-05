import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const idea = {
  id: 'iron_condor:B22000PE-S22200PE-S22800CE-B23000CE', name: 'Iron Condor', family: 'iron_condor', view: 'neutral', kind: 'credit',
  legs: [
    { type: 'PE', action: 'BUY', strike: 22000, qty: 65, premium: 12, iv: 20, priced: 'ask' },
    { type: 'PE', action: 'SELL', strike: 22200, qty: 65, premium: 30, iv: 20, priced: 'bid' },
    { type: 'CE', action: 'SELL', strike: 22800, qty: 65, premium: 28, iv: 20, priced: 'bid' },
    { type: 'CE', action: 'BUY', strike: 23000, qty: 65, premium: 11, iv: 20, priced: 'ask' },
  ],
  netPremium: 2275, maxProfit: 2150, maxLoss: -10850, breakevens: [22167, 22833], pop: 71.2, expectedPnl: 640, margin: 42000,
  returnOnMargin: 1.5, rewardToRisk: 0.2, charges: 125, fit: 'with',
  why: ['Keeps the whole credit if NIFTY is between 22,200 and 22,800 at expiry.'], warnings: ['The worst case is 1.1% of your net worth.'],
  payoff: [{ spot: 22000, pnl: -10850 }, { spot: 22500, pnl: 2150 }, { spot: 23000, pnl: -10850 }],
};
const result = (over: Record<string, unknown> = {}) => ({
  read: { symbol: 'NIFTY', spot: 22500, days: 6, atmIv: 20, rv20: 10, verdict: 'expensive', trend: 'sideways', expectedMove: 577, vixPercentile: 60, summary: ['Options look expensive.'] },
  ideas: [idea], nearMisses: [], considered: 31, rejected: { 'the credit is too small for the risk taken': 4 }, message: null,
  expiry: '2026-10-13', lotSize: 65, qty: 65, ...over,
});

const ideas = vi.fn();
const executeStrategy = vi.fn();
vi.mock('../services/api', () => ({
  optionsApi: { ideas: (...a: unknown[]) => ideas(...a) },
  tradingApi: { executeStrategy: (...a: unknown[]) => executeStrategy(...a) },
}));
vi.mock('recharts', () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const None = () => null;
  return { ResponsiveContainer: Box, AreaChart: Box, Area: None, XAxis: None, YAxis: None, Tooltip: None, ReferenceLine: None };
});

import IdeasPanel from '../components/strategies/IdeasPanel';

describe('Ideas for today', () => {
  beforeEach(() => { ideas.mockReset(); executeStrategy.mockReset(); });

  it('shows the market read, the idea with its worst case, and what was turned down', async () => {
    ideas.mockResolvedValue({ data: result() });
    render(<IdeasPanel portfolioId="pf" netWorth={1_000_400} open={[]} onPlaced={() => {}} />);
    await waitFor(() => expect(screen.getByText('Iron Condor')).toBeTruthy());
    expect(screen.getByText('Options look expensive.')).toBeTruthy();
    expect(screen.getByText("Suits today's market")).toBeTruthy();
    expect(screen.getByText(/Sell 22200 put at 30/)).toBeTruthy();
    expect(screen.getByText(/31 combinations were checked/)).toBeTruthy();
    expect(screen.getByText(/4 because the credit is too small/)).toBeTruthy();
    // Net worth is sent rounded, so small changes do not trigger new requests.
    expect(ideas).toHaveBeenCalledWith('NIFTY', { lots: 1, maxLoss: undefined, netWorth: 1_000_000 });
  });

  it('places an idea only after the user confirms, with the same legs', async () => {
    ideas.mockResolvedValue({ data: result() });
    executeStrategy.mockResolvedValue({ data: { results: [] } });
    const onPlaced = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<IdeasPanel portfolioId="pf" netWorth={null} open={[]} onPlaced={onPlaced} />);
    await waitFor(() => expect(screen.getByText('Place this strategy')).toBeTruthy());

    fireEvent.click(screen.getByText('Place this strategy'));
    expect(executeStrategy).not.toHaveBeenCalled();                        // declined

    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByText('Place this strategy'));
    await waitFor(() => expect(onPlaced).toHaveBeenCalled());
    expect(executeStrategy).toHaveBeenCalledWith({
      portfolio_id: 'pf', symbol: 'NIFTY', expiry: '2026-10-13', strategy_name: 'Iron Condor',
      legs: idea.legs.map((l) => ({ type: l.type, strike: l.strike, action: l.action, qty: l.qty, premium: l.premium })),
    });
    confirm.mockRestore();
  });

  it('says nothing clears the checks, and near misses cannot be placed', async () => {
    ideas.mockResolvedValue({ data: result({ ideas: [], nearMisses: [{ ...idea, blocked: 'the expected result after charges is not positive' }], message: 'Nothing clears the checks right now. Not trading is a position too.' }) });
    render(<IdeasPanel portfolioId="pf" netWorth={null} open={[]} onPlaced={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Nothing clears the checks/)).toBeTruthy());
    expect(screen.getByText(/Turned down because the expected result after charges is not positive/)).toBeTruthy();
    expect(screen.queryByText('Place this strategy')).toBeNull();
  });

  it('shows the server message when there is no option data', async () => {
    ideas.mockRejectedValue({ response: { data: { error: 'No option data source is connected.' } } });
    render(<IdeasPanel portfolioId="pf" netWorth={null} open={[]} onPlaced={() => {}} />);
    await waitFor(() => expect(screen.getByText('No option data source is connected.')).toBeTruthy());
  });
});
