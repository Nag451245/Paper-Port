import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const leg = (over: Record<string, unknown>) => ({
  positionId: 'p1', symbol: 'NIFTY2026100622550CE', kind: 'CE', strike: 22550, side: 'SHORT', qty: 65, entry: 70.39, last: 98.45,
  pnl: -1824, iv: 19.9, ivAssumed: false, marginBlocked: 160000, expiry: '2026-10-06', ...over,
});
const card = (over: Record<string, unknown> = {}) => ({
  strategyTag: 'STRAT:Custom 2-Leg Strategy · 05 Oct, 11:26:57', name: 'Custom 2-Leg Strategy · 05 Oct, 11:26:57', owner: 'user',
  underlying: 'NIFTY', expiry: '2026-10-06', expiries: ['2026-10-06'], daysToExpiry: 1.1, spot: 22551, deployedAt: '2026-10-05T05:56:57.000Z',
  legs: [leg({}), leg({ positionId: 'p2', symbol: 'NIFTY2026100622350PE', kind: 'PE', strike: 22350, entry: 48.04, last: 27.1, pnl: 1361 })],
  openPnl: -463, marginBlocked: 192649,
  payoff: { curve: [{ spot: 22000, atExpiry: -15000, today: -14000 }, { spot: 22500, atExpiry: 7698, today: 2000 }, { spot: 23000, atExpiry: -20000, today: -19000 }],
    maxProfit: 7698, maxLoss: -90000, unlimitedProfit: false, unlimitedLoss: true, breakevens: [22231.57, 22668.43], pop: 0.59, margin: 192649 },
  greeks: { delta: -20.33, gamma: -0.182, theta: 5201, vega: -530 }, reading: ['Expires tomorrow.'], note: null,
  netPnl: -514, chargesPaid: 0, exitChargesEstimate: 51, exitPlan: null, ...over,
});

const optionsExpiries = vi.fn();
const optionsChain = vi.fn();
const previewStrategyLegs = vi.fn();
const executeStrategy = vi.fn();
vi.mock('../services/api', () => ({
  marketApi: { optionsExpiries: (...a: unknown[]) => optionsExpiries(...a), optionsChain: (...a: unknown[]) => optionsChain(...a) },
  tradingApi: {
    previewStrategyLegs: (...a: unknown[]) => previewStrategyLegs(...a), executeStrategy: (...a: unknown[]) => executeStrategy(...a),
    exitAllLegs: vi.fn(), exitLegs: vi.fn(), setExitPlan: vi.fn(), cancelExitPlan: vi.fn(),
  },
}));
vi.mock('recharts', () => {
  const Box = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const None = () => null;
  return { ResponsiveContainer: Box, ComposedChart: Box, Area: None, Line: None, XAxis: None, YAxis: None, Tooltip: None, ReferenceLine: None, CartesianGrid: None };
});

import StrategyCard from '../components/strategies/StrategyCard';

const strikes = (base: number) => [22500, 22550, 22600, 22800].map((strike, i) => ({
  strike, callLTP: base - i * 10, putLTP: base / 2 + i * 10, callBidPrice: base - i * 10 - 0.5, callAskPrice: base - i * 10 + 0.5,
  putBidPrice: base / 2 + i * 10 - 0.5, putAskPrice: base / 2 + i * 10 + 0.5,
}));

describe('My Strategies: add a leg', () => {
  beforeEach(() => {
    [optionsExpiries, optionsChain, previewStrategyLegs, executeStrategy].forEach((m) => m.mockReset());
    optionsExpiries.mockResolvedValue({ data: { symbol: 'NIFTY', expiries: ['2026-10-06', '2026-10-13', '2026-10-20'] } });
    optionsChain.mockImplementation((_s: string, expiry: string) => Promise.resolve({ data: { strikes: strikes(expiry === '2026-10-13' ? 200 : 100) } }));
  });

  it('offers every contract week and the strikes of the chosen week with their prices', async () => {
    render(<StrategyCard card={card() as never} portfolioId="pf" onChanged={() => {}} />);
    const week = await screen.findByLabelText('Contract week') as HTMLSelectElement;
    await waitFor(() => expect(week.options.length).toBe(3));
    expect(week.value).toBe('2026-10-06');                                   // starts on the strategy's own week
    const strike = screen.getByLabelText('Strike and price') as HTMLSelectElement;
    await waitFor(() => expect(strike.options.length).toBe(4));
    expect(strike.value).toBe('22550');                                      // nearest to the price
    expect(strike.options[1].textContent).toBe('22550 — ₹90.50');            // buying a call: the ask

    fireEvent.change(screen.getByLabelText('Side'), { target: { value: 'SELL' } });
    expect((screen.getByLabelText('Strike and price') as HTMLSelectElement).options[1].textContent).toBe('22550 — ₹89.50');   // selling: the bid

    fireEvent.change(week, { target: { value: '2026-10-13' } });
    await waitFor(() => expect(optionsChain).toHaveBeenCalledWith('NIFTY', '2026-10-13'));
    await waitFor(() => expect((screen.getByLabelText('Strike and price') as HTMLSelectElement).options[1].textContent).toBe('22550 — ₹189.50'));
  });

  it('previews the leg in its own week, and places it only on the second click', async () => {
    const withLeg = card({ expiries: ['2026-10-06', '2026-10-13'], legs: [...card().legs, leg({ positionId: null, symbol: 'NIFTY 22800 CE', strike: 22800, side: 'LONG', entry: 170.5, last: 170.5, pnl: 0, expiry: '2026-10-13', proposed: true })] });
    previewStrategyLegs.mockResolvedValue({ data: withLeg });
    executeStrategy.mockResolvedValue({ data: { results: [] } });
    const onChanged = vi.fn();
    render(<StrategyCard card={card() as never} portfolioId="pf" onChanged={onChanged} />);

    const week = await screen.findByLabelText('Contract week') as HTMLSelectElement;
    await waitFor(() => expect(week.options.length).toBe(3));
    fireEvent.change(week, { target: { value: '2026-10-13' } });
    await waitFor(() => expect((screen.getByLabelText('Strike and price') as HTMLSelectElement).options[3]?.textContent).toBe('22800 — ₹170.50'));
    fireEvent.change(screen.getByLabelText('Strike and price'), { target: { value: '22800' } });

    fireEvent.click(screen.getByText('See the effect'));
    await waitFor(() => expect(previewStrategyLegs).toHaveBeenCalledWith(card().strategyTag,
      [{ type: 'CE', strike: 22800, action: 'BUY', qty: 65, premium: 170.5, expiry: '2026-10-13' }]));
    expect(executeStrategy).not.toHaveBeenCalled();                          // a preview places nothing
    await waitFor(() => expect(screen.getByText('not placed yet')).toBeTruthy());
    expect(screen.getByText('Week')).toBeTruthy();                           // legs now show their week

    fireEvent.click(screen.getByText('Buy it at about ₹170.5'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(executeStrategy).toHaveBeenCalledWith({
      portfolio_id: 'pf', symbol: 'NIFTY', expiry: '2026-10-13', add_to: card().strategyTag,
      legs: [{ type: 'CE', strike: 22800, action: 'BUY', qty: 65, premium: 170.5 }],
    });
  });

  it('keeps the own week of the strategy available when the list of weeks cannot be loaded', async () => {
    optionsExpiries.mockRejectedValue(new Error('down'));
    render(<StrategyCard card={card() as never} portfolioId="pf" onChanged={() => {}} />);
    const week = await screen.findByLabelText('Contract week') as HTMLSelectElement;
    await waitFor(() => expect((screen.getByLabelText('Strike and price') as HTMLSelectElement).options.length).toBe(4));
    expect(week.options.length).toBe(1);
  });
});
