import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Globe, Trophy, Users, Star, Award,
  Crown, Medal, Target,
} from 'lucide-react';
import { edgeApi } from '@/services/api';

interface LeaderboardEntry {
  rank: number;
  name: string;
  totalReturn: number;
  winRate: number;
  trades: number;
  sharpe: number;
  badge: string;
  streak: number;
}

const MOCK_LEADERBOARD: LeaderboardEntry[] = [
  { rank: 1, name: 'AlphaTrader', totalReturn: 34.5, winRate: 72, trades: 156, sharpe: 2.1, badge: 'Diamond', streak: 12 },
  { rank: 2, name: 'QuantMaster', totalReturn: 28.2, winRate: 68, trades: 203, sharpe: 1.8, badge: 'Platinum', streak: 8 },
  { rank: 3, name: 'RiskKing', totalReturn: 22.8, winRate: 65, trades: 89, sharpe: 1.9, badge: 'Gold', streak: 5 },
  { rank: 4, name: 'TrendRider', totalReturn: 19.4, winRate: 61, trades: 178, sharpe: 1.5, badge: 'Gold', streak: 3 },
  { rank: 5, name: 'ValueHunter', totalReturn: 17.1, winRate: 58, trades: 134, sharpe: 1.3, badge: 'Silver', streak: 7 },
  { rank: 6, name: 'ScalpBot', totalReturn: 15.3, winRate: 73, trades: 412, sharpe: 1.1, badge: 'Silver', streak: 2 },
  { rank: 7, name: 'SwingPro', totalReturn: 12.7, winRate: 55, trades: 67, sharpe: 1.4, badge: 'Bronze', streak: 4 },
  { rank: 8, name: 'MomentumAce', totalReturn: 10.2, winRate: 52, trades: 198, sharpe: 0.9, badge: 'Bronze', streak: 1 },
];

const STRATEGIES = [
  { name: 'EMA Crossover', author: 'AlphaTrader', rating: 4.5, users: 234, returnPct: 18.2, description: 'Classic EMA 9/21 crossover with volume confirmation' },
  { name: 'SuperTrend Momentum', author: 'QuantMaster', rating: 4.3, users: 189, returnPct: 15.7, description: 'SuperTrend indicator combined with momentum filter' },
  { name: 'RSI Mean Reversion', author: 'RiskKing', rating: 4.1, users: 156, returnPct: 12.4, description: 'RSI oversold bounces with ATR-based stop loss' },
  { name: 'Opening Range Breakout', author: 'TrendRider', rating: 3.9, users: 98, returnPct: 22.1, description: 'First 15-min range breakout with trailing stop' },
  { name: 'VWAP Reversal', author: 'ScalpBot', rating: 4.2, users: 167, returnPct: 14.8, description: 'Mean reversion to VWAP with volume profile confirmation' },
];

const CHALLENGES = [
  { title: '30-Day Sprint', description: 'Best return in 30 days with max 20% drawdown', prize: 'Diamond Badge', participants: 89, daysLeft: 18, color: 'from-purple-500 to-indigo-500' },
  { title: 'Risk Master', description: 'Highest Sharpe ratio over 60 trades', prize: 'Risk Master Badge', participants: 45, daysLeft: 24, color: 'from-emerald-500 to-teal-500' },
  { title: 'Win Streak', description: 'Longest consecutive winning trade streak', prize: 'Streak Champion', participants: 120, daysLeft: 7, color: 'from-amber-500 to-orange-500' },
];

function RankBadge({ rank }: { rank: number }) {
  if (rank === 1) return <Crown className="w-5 h-5 text-amber-500" />;
  if (rank === 2) return <Medal className="w-5 h-5 text-slate-400" />;
  if (rank === 3) return <Award className="w-5 h-5 text-amber-700" />;
  return <span className="w-5 h-5 flex items-center justify-center text-xs font-bold text-slate-400">{rank}</span>;
}

function BadgeColor(badge: string) {
  switch (badge) {
    case 'Diamond': return 'bg-purple-100 text-purple-700';
    case 'Platinum': return 'bg-indigo-100 text-indigo-700';
    case 'Gold': return 'bg-amber-100 text-amber-700';
    case 'Silver': return 'bg-slate-100 text-slate-600';
    default: return 'bg-orange-100 text-orange-700';
  }
}

function LeaderboardPanel() {
  const { data } = useQuery({
    queryKey: ['track-record'],
    queryFn: () => edgeApi.getTrackRecord(),
  });
  const myRecord = data as any;

  return (
    <div className="space-y-6">
      {myRecord?.summary && (
        <div className="bg-gradient-to-r from-emerald-500 to-teal-500 rounded-2xl p-6 text-white shadow-lg">
          <p className="text-sm opacity-80 mb-1">Your Performance</p>
          <div className="flex items-end gap-6">
            <div>
              <p className="text-3xl font-bold">{myRecord.summary.totalReturn > 0 ? '+' : ''}{myRecord.summary.totalReturn}%</p>
              <p className="text-sm opacity-80">Total Return</p>
            </div>
            <div>
              <p className="text-xl font-bold">{myRecord.summary.winRate}%</p>
              <p className="text-sm opacity-80">Win Rate</p>
            </div>
            <div>
              <p className="text-xl font-bold">{myRecord.summary.totalTrades}</p>
              <p className="text-sm opacity-80">Trades</p>
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200/60 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex items-center gap-2">
          <Trophy className="w-5 h-5 text-amber-500" />
          <h3 className="text-sm font-semibold text-slate-700">Global Leaderboard</h3>
          <span className="ml-auto text-xs text-slate-400">Paper Trading Rankings</span>
        </div>
        <div className="divide-y divide-slate-100">
          {MOCK_LEADERBOARD.map((entry) => (
            <div key={entry.rank} className="flex items-center gap-4 px-4 py-3 hover:bg-slate-50 transition-colors">
              <RankBadge rank={entry.rank} />
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-700">{entry.name}</p>
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${BadgeColor(entry.badge)}`}>{entry.badge}</span>
                  <span>{entry.trades} trades</span>
                  {entry.streak > 3 && <span className="text-amber-500">🔥 {entry.streak} streak</span>}
                </div>
              </div>
              <div className="text-right">
                <p className="text-sm font-bold text-emerald-600">+{entry.totalReturn}%</p>
                <p className="text-xs text-slate-400">{entry.winRate}% WR | SR {entry.sharpe}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function StrategyMarketplace() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">Discover and deploy community-proven strategies</p>
      {STRATEGIES.map((s, i) => (
        <div key={i} className="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm hover:shadow-md transition-shadow">
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-500 flex items-center justify-center flex-shrink-0">
              <Target className="w-5 h-5 text-white" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-semibold text-slate-700">{s.name}</h4>
                <div className="flex items-center gap-0.5 text-amber-400">
                  <Star className="w-3 h-3 fill-current" />
                  <span className="text-xs">{s.rating}</span>
                </div>
              </div>
              <p className="text-xs text-slate-500 mt-1">{s.description}</p>
              <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
                <span>by {s.author}</span>
                <span>{s.users} users</span>
                <span className="text-emerald-600 font-medium">+{s.returnPct}% avg return</span>
              </div>
            </div>
            <button className="px-3 py-1.5 text-xs font-medium text-white bg-gradient-to-r from-blue-500 to-indigo-500 rounded-lg hover:shadow-md transition-shadow">
              Deploy
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function ChallengesPanel() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {CHALLENGES.map((c, i) => (
        <div key={i} className="bg-white rounded-xl border border-slate-200/60 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
          <div className={`bg-gradient-to-r ${c.color} p-4 text-white`}>
            <h4 className="text-sm font-bold">{c.title}</h4>
            <p className="text-xs opacity-80 mt-1">{c.description}</p>
          </div>
          <div className="p-4">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <span className="flex items-center gap-1"><Users className="w-3 h-3" />{c.participants} participants</span>
              <span className="text-amber-600 font-medium">{c.daysLeft}d left</span>
            </div>
            <p className="text-xs text-slate-400 mt-2">Prize: <span className="font-medium text-slate-600">{c.prize}</span></p>
            <button className="mt-3 w-full py-2 text-xs font-medium text-white bg-gradient-to-r from-slate-700 to-slate-800 rounded-lg hover:shadow-md transition-shadow">
              Join Challenge
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

const COMMUNITY_TABS = [
  { id: 'leaderboard', label: 'Leaderboard', icon: Trophy },
  { id: 'strategies', label: 'Strategy Market', icon: Target },
  { id: 'challenges', label: 'Challenges', icon: Award },
] as const;

type CommunityTabId = typeof COMMUNITY_TABS[number]['id'];

export default function CommunityTab() {
  const [activeTab, setActiveTab] = useState<CommunityTabId>('leaderboard');

  return (
    <div className="max-w-7xl mx-auto space-y-6 p-4 md:p-6">
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-green-500 to-emerald-500 flex items-center justify-center shadow-lg shadow-green-500/20">
          <Globe className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Community</h1>
          <p className="text-sm text-slate-500">Leaderboard, strategy marketplace & trading challenges</p>
        </div>
      </div>

      <div className="flex gap-2 bg-white rounded-xl p-1.5 border border-slate-200/60 shadow-sm">
        {COMMUNITY_TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === id
                ? 'bg-gradient-to-r from-green-500 to-emerald-500 text-white shadow-md'
                : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'leaderboard' && <LeaderboardPanel />}
      {activeTab === 'strategies' && <StrategyMarketplace />}
      {activeTab === 'challenges' && <ChallengesPanel />}
    </div>
  );
}
