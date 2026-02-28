import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Rocket,
  Shield,
  Wallet,
  Key,
  ChevronRight,
  ChevronLeft,
  Check,
  ExternalLink,
} from 'lucide-react';

const STEPS = [
  { icon: Rocket, title: 'Welcome' },
  { icon: Wallet, title: 'Capital' },
  { icon: Key, title: 'API Setup' },
  { icon: Shield, title: 'Strategies' },
];

const RISK_QUESTIONS = [
  {
    question: 'How would you react to a 10% portfolio drop in a single day?',
    options: [
      { value: 1, label: 'Sell everything immediately' },
      { value: 2, label: 'Sell some positions to reduce risk' },
      { value: 3, label: 'Hold and wait for recovery' },
      { value: 4, label: 'Buy more at lower prices' },
    ],
  },
  {
    question: 'What is your primary trading goal?',
    options: [
      { value: 1, label: 'Capital preservation' },
      { value: 2, label: 'Steady income with moderate growth' },
      { value: 3, label: 'Long-term wealth creation' },
      { value: 4, label: 'Maximum returns regardless of risk' },
    ],
  },
  {
    question: 'How long can you hold a losing position?',
    options: [
      { value: 1, label: 'Not even a day — strict stop loss' },
      { value: 2, label: 'A few days if conviction is strong' },
      { value: 3, label: 'Weeks, with hedging' },
      { value: 4, label: 'Months — I average down aggressively' },
    ],
  },
];

const STRATEGIES = [
  { id: 'momentum', name: 'Momentum Scalping', desc: 'Quick intraday trades based on momentum indicators', color: 'from-amber-500 to-yellow-500' },
  { id: 'mean_reversion', name: 'Mean Reversion', desc: 'Trade instruments that deviate from their average', color: 'from-blue-500 to-cyan-500' },
  { id: 'options_selling', name: 'Options Selling', desc: 'Premium collection through options writing', color: 'from-emerald-500 to-teal-500' },
  { id: 'trend_following', name: 'Trend Following', desc: 'Ride established trends with trailing stops', color: 'from-amber-500 to-orange-500' },
  { id: 'pair_trading', name: 'Pair Trading', desc: 'Market-neutral strategy trading correlated pairs', color: 'from-pink-500 to-rose-500' },
  { id: 'event_driven', name: 'Event-Driven', desc: 'Trade around earnings, news, and corporate actions', color: 'from-indigo-500 to-purple-500' },
];

export default function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [riskAnswers, setRiskAnswers] = useState<Record<number, number>>({});
  const [virtualCapital, setVirtualCapital] = useState(1000000);
  const [selectedStrategies, setSelectedStrategies] = useState<string[]>(['momentum', 'trend_following']);

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      navigate('/dashboard');
    }
  };

  const handleBack = () => {
    if (step > 0) setStep(step - 1);
  };

  const toggleStrategy = (id: string) => {
    setSelectedStrategies((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-white via-teal-50/30 to-amber-50/20 flex flex-col items-center justify-center px-4 py-8">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-teal-200/15 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-blue-200/15 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-2xl">
        {/* Progress bar */}
        <div className="flex items-center justify-center gap-2 mb-8">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <div key={i} className="flex items-center gap-2">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-all ${
                    i < step
                      ? 'bg-gradient-to-br from-amber-400 via-teal-500 to-red-500 border-transparent shadow-md shadow-teal-500/20'
                      : i === step
                      ? 'border-teal-400 bg-teal-50'
                      : 'border-slate-300 bg-white'
                  }`}
                >
                  {i < step ? (
                    <Check className="w-5 h-5 text-white" />
                  ) : (
                    <Icon className={`w-5 h-5 ${i === step ? 'text-teal-600' : 'text-slate-400'}`} />
                  )}
                </div>
                {i < STEPS.length - 1 && (
                  <div className={`w-12 h-0.5 rounded-full ${i < step ? 'bg-gradient-to-r from-amber-400 via-teal-500 to-red-500' : 'bg-slate-300'}`} />
                )}
              </div>
            );
          })}
        </div>

        <div className="bg-white/80 backdrop-blur-sm border border-slate-200/60 rounded-2xl p-8 shadow-xl shadow-slate-200/50">
          {/* Step 0: Welcome + Risk Quiz */}
          {step === 0 && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-xl shadow-[#4a6b52]/25" style={{ background: 'linear-gradient(135deg, #5a7d63, #3d5a47)' }}>
                  <svg viewBox="0 0 120 100" className="w-10 h-8" fill="none">
                    <path d="M15 65 L60 85 L105 65 L95 70 L60 78 L25 70 Z" fill="#fff" opacity="0.9" />
                    <path d="M20 62 L60 80 L100 62 L105 65 L60 85 L15 65 Z" fill="#fff" />
                    <path d="M58 20 L58 65 L28 65 Z" fill="#fff" opacity="0.85" />
                    <path d="M62 20 L62 65 L92 65 Z" fill="#fff" opacity="0.7" />
                    <path d="M72 35 L80 18 L76 22 M80 18 L84 22" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
                  </svg>
                </div>
                <h2 className="text-2xl font-bold text-slate-900">
                  Welcome to{' '}
                  <span className="text-[#4a6b52] font-bold">PaperPort</span>
                </h2>
                <p className="text-sm text-slate-500 mt-2">
                  Let's customize your trading experience. Answer a few questions about your risk tolerance.
                </p>
              </div>
              <div className="space-y-5">
                {RISK_QUESTIONS.map((q, qi) => (
                  <div key={qi}>
                    <p className="text-sm font-medium text-slate-800 mb-2">{q.question}</p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {q.options.map((opt) => (
                        <button
                          key={opt.value}
                          onClick={() => setRiskAnswers({ ...riskAnswers, [qi]: opt.value })}
                          className={`p-3 rounded-xl border text-left text-xs transition-all ${
                            riskAnswers[qi] === opt.value
                              ? 'bg-teal-50 border-teal-300 text-teal-700 shadow-sm'
                              : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
                          }`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Step 1: Virtual Capital */}
          {step === 1 && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center mx-auto mb-3 shadow-lg shadow-emerald-500/20">
                  <Wallet className="w-8 h-8 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-slate-900">Set Your Virtual Capital</h2>
                <p className="text-sm text-slate-500 mt-2">
                  Start with virtual money to practice and test strategies risk-free.
                </p>
              </div>

              <div className="space-y-4">
                <div className="text-center">
                  <p className="text-4xl font-bold font-mono bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-transparent">
                    ₹{virtualCapital.toLocaleString('en-IN')}
                  </p>
                  <p className="text-sm text-slate-400 mt-1">
                    {virtualCapital >= 10000000
                      ? '₹1 Crore'
                      : `₹${(virtualCapital / 100000).toFixed(0)} Lakhs`}
                  </p>
                </div>

                <input
                  type="range"
                  min={1000000}
                  max={10000000}
                  step={100000}
                  value={virtualCapital}
                  onChange={(e) => setVirtualCapital(Number(e.target.value))}
                  className="w-full h-2 bg-slate-200 rounded-full appearance-none cursor-pointer accent-teal-600"
                />

                <div className="flex justify-between text-xs text-slate-400">
                  <span>₹10 Lakhs</span>
                  <span>₹50 Lakhs</span>
                  <span>₹1 Crore</span>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {[1000000, 2500000, 5000000].map((amount) => (
                    <button
                      key={amount}
                      onClick={() => setVirtualCapital(amount)}
                      className={`py-2 rounded-xl text-xs font-medium border transition-all ${
                        virtualCapital === amount
                          ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white border-transparent shadow-md'
                          : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
                      }`}
                    >
                      ₹{(amount / 100000).toFixed(0)}L
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 2: Breeze API Setup */}
          {step === 2 && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center mx-auto mb-3 shadow-lg shadow-amber-500/20">
                  <Key className="w-8 h-8 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-slate-900">Connect Breeze API</h2>
                <p className="text-sm text-slate-500 mt-2">
                  Connect your ICICI Direct Breeze API for live market data and trading. You can skip this for now.
                </p>
              </div>

              <div className="bg-gradient-to-br from-slate-50 to-amber-50/30 rounded-xl p-5 space-y-4 border border-slate-200/60">
                <h3 className="text-sm font-semibold text-slate-800">How to get your API credentials:</h3>
                <ol className="space-y-2 text-xs text-slate-500">
                  <li className="flex gap-2">
                    <span className="w-5 h-5 rounded-full bg-gradient-to-br from-amber-400 via-teal-500 to-red-500 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">1</span>
                    Login to your ICICI Direct account
                  </li>
                  <li className="flex gap-2">
                    <span className="w-5 h-5 rounded-full bg-gradient-to-br from-amber-400 via-teal-500 to-red-500 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">2</span>
                    Go to API section under Profile settings
                  </li>
                  <li className="flex gap-2">
                    <span className="w-5 h-5 rounded-full bg-gradient-to-br from-amber-400 via-teal-500 to-red-500 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">3</span>
                    Generate a new API key and secret
                  </li>
                  <li className="flex gap-2">
                    <span className="w-5 h-5 rounded-full bg-gradient-to-br from-amber-400 via-teal-500 to-red-500 text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0">4</span>
                    Enter the credentials in Settings after onboarding
                  </li>
                </ol>
                <a
                  href="https://api.icicidirect.com"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-teal-600 hover:text-teal-500 font-medium"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Open ICICI Direct API Portal
                </a>
              </div>

              <p className="text-xs text-slate-400 text-center">
                You can configure this later from Settings. Virtual trading works without API credentials.
              </p>
            </div>
          )}

          {/* Step 3: Strategy Selection */}
          {step === 3 && (
            <div className="space-y-6">
              <div className="text-center">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-pink-500 to-rose-500 flex items-center justify-center mx-auto mb-3 shadow-lg shadow-pink-500/20">
                  <Shield className="w-8 h-8 text-white" />
                </div>
                <h2 className="text-2xl font-bold text-slate-900">Choose Your Strategies</h2>
                <p className="text-sm text-slate-500 mt-2">
                  Select the trading strategies you want the AI agent to use.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {STRATEGIES.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => toggleStrategy(s.id)}
                    className={`p-4 rounded-xl border text-left transition-all ${
                      selectedStrategies.includes(s.id)
                        ? 'bg-gradient-to-br ' + s.color + ' text-white border-transparent shadow-lg'
                        : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <p className={`text-sm font-semibold ${selectedStrategies.includes(s.id) ? 'text-white' : 'text-slate-800'}`}>
                          {s.name}
                        </p>
                        <p className={`text-xs mt-1 ${selectedStrategies.includes(s.id) ? 'text-white/80' : 'text-slate-400'}`}>{s.desc}</p>
                      </div>
                      {selectedStrategies.includes(s.id) && (
                        <div className="w-5 h-5 rounded-full bg-white/25 flex items-center justify-center flex-shrink-0 mt-0.5">
                          <Check className="w-3.5 h-3.5 text-white" />
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Navigation buttons */}
          <div className="flex items-center justify-between mt-8 pt-6 border-t border-slate-200/60">
            <button
              onClick={handleBack}
              disabled={step === 0}
              className="flex items-center gap-1.5 px-4 py-2 text-sm text-slate-500 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>
            <div className="flex items-center gap-1.5">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className={`h-2 rounded-full transition-all ${i === step ? 'bg-gradient-to-r from-amber-400 via-teal-500 to-red-500 w-6' : 'bg-slate-300 w-2'}`}
                />
              ))}
            </div>
            <button
              onClick={handleNext}
              className="flex items-center gap-1.5 px-5 py-2 bg-gradient-to-r from-amber-500 via-teal-600 to-red-500 hover:from-amber-400 hover:via-teal-500 hover:to-red-400 text-white text-sm font-semibold rounded-xl transition-all shadow-lg shadow-teal-600/20"
            >
              {step === STEPS.length - 1 ? 'Get Started' : 'Next'}
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
