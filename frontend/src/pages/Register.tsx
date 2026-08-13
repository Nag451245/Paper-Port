import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { User, Mail, Lock, Loader2, Eye, EyeOff, IndianRupee } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';

const RISK_OPTIONS = [
  { value: 'CONSERVATIVE', label: 'Conservative', desc: 'Low risk, steady returns. Max 2% per trade.', color: 'from-emerald-600 to-teal-600' },
  { value: 'MODERATE', label: 'Moderate', desc: 'Balanced approach. Max 5% per trade.', color: 'from-amber-600 to-orange-500' },
  { value: 'AGGRESSIVE', label: 'Aggressive', desc: 'Higher risk for higher returns. Max 10% per trade.', color: 'from-rose-500 to-pink-500' },
];

function PaperBoatLogo({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 100" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M15 65 L60 85 L105 65 L95 70 L60 78 L25 70 Z" fill="#3d5a47" />
      <path d="M20 62 L60 80 L100 62 L105 65 L60 85 L15 65 Z" fill="#4a6b52" />
      <path d="M58 20 L58 65 L28 65 Z" fill="#5a7d63" />
      <path d="M62 20 L62 65 L92 65 Z" fill="#4a6b52" />
      <path d="M58 20 L45 50" stroke="#3d5a47" strokeWidth="0.8" opacity="0.5" />
      <path d="M62 20 L75 50" stroke="#3d5a47" strokeWidth="0.8" opacity="0.5" />
      <path d="M72 35 L80 18 L76 22 M80 18 L84 22" stroke="#3d5a47" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M82 45 L90 28 L86 32 M90 28 L94 32" stroke="#4a6b52" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 75 Q20 70 35 75 Q50 80 65 75 Q80 70 95 75 Q110 80 115 75" stroke="#4a6b52" strokeWidth="1.5" opacity="0.3" fill="none" />
    </svg>
  );
}

export default function Register() {
  const navigate = useNavigate();
  const { register, isLoading, error, clearError } = useAuthStore();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [riskAppetite, setRiskAppetite] = useState('MODERATE');
  const [virtualCapital, setVirtualCapital] = useState(1000000);
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError('');
    if (password !== confirmPassword) { setValidationError('Passwords do not match'); return; }
    if (password.length < 8) { setValidationError('Password must be at least 8 characters'); return; }
    try {
      await register({ fullName, email, password, riskAppetite, virtualCapital });
      navigate('/onboarding');
    } catch { /* error is set in store */ }
  };

  const inputClass = "w-full pl-11 pr-4 py-3 bg-white/80 border border-stone-200 rounded-xl text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-[#4a6b52]/25 focus:border-[#4a6b52]/50 transition-all";

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-8 relative overflow-hidden"
      style={{ background: 'linear-gradient(145deg, #f5f0e8 0%, #ede8df 30%, #e8e4dc 60%, #f0ece4 100%)' }}
    >
      <div className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage: `linear-gradient(#6b7b6e 1px, transparent 1px), linear-gradient(90deg, #6b7b6e 1px, transparent 1px)`,
          backgroundSize: '28px 28px',
        }}
      />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-gradient-to-br from-amber-100/40 to-green-100/20 rounded-full blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-lg">
        <div className="rounded-3xl p-8 pt-10 shadow-2xl shadow-stone-400/20"
          style={{
            background: 'linear-gradient(160deg, rgba(255,253,248,0.95) 0%, rgba(248,244,237,0.92) 50%, rgba(242,238,230,0.9) 100%)',
            border: '1px solid rgba(200, 190, 175, 0.3)',
          }}
        >
          <div className="flex justify-center mb-4">
            <PaperBoatLogo className="w-20 h-16" />
          </div>

          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-stone-800 tracking-tight">
              Create your <span className="text-[#4a6b52]">PaperPort</span> account
            </h1>
            <p className="text-sm text-stone-500 mt-1.5">Start your practice trading journey</p>
          </div>

          {(error || validationError) && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 flex items-center gap-2">
              <span>{validationError || error}</span>
              <button onClick={() => { clearError(); setValidationError(''); }} className="ml-auto text-red-400 hover:text-red-600 text-lg leading-none">&times;</button>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Full Name" required className={inputClass} />
            </div>

            <div className="relative">
              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" required className={inputClass} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
                <input
                  type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)}
                  placeholder="Password (min 8)" required minLength={8}
                  className="w-full pl-11 pr-10 py-3 bg-white/80 border border-stone-200 rounded-xl text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-[#4a6b52]/25 focus:border-[#4a6b52]/50 transition-all"
                />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600">
                  {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
              <div className="relative">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="Confirm" required className={inputClass} />
              </div>
            </div>

            <div>
              <label className="text-xs text-stone-500 mb-2 block font-medium">Risk Appetite</label>
              <div className="grid grid-cols-3 gap-2">
                {RISK_OPTIONS.map((opt) => (
                  <button
                    key={opt.value} type="button" onClick={() => setRiskAppetite(opt.value)}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      riskAppetite === opt.value
                        ? 'bg-gradient-to-br ' + opt.color + ' text-white border-transparent shadow-md'
                        : 'bg-white/80 border-stone-200 hover:border-stone-300'
                    }`}
                  >
                    <p className={`text-xs font-semibold ${riskAppetite === opt.value ? 'text-white' : 'text-stone-700'}`}>{opt.label}</p>
                    <p className={`text-[10px] mt-0.5 ${riskAppetite === opt.value ? 'text-white/80' : 'text-stone-400'}`}>{opt.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-stone-500 mb-1.5 block font-medium">Initial Virtual Capital</label>
              <div className="relative">
                <IndianRupee className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
                <input type="number" value={virtualCapital} onChange={(e) => setVirtualCapital(Number(e.target.value))} min={100000} max={10000000} step={100000} className={inputClass} />
              </div>
              <p className="text-[11px] text-stone-400 mt-1">₹{virtualCapital.toLocaleString('en-IN')} — Range: ₹1 Lakh to ₹1 Crore</p>
            </div>

            <button
              type="submit" disabled={isLoading}
              className="w-full py-3 text-white text-sm font-bold rounded-xl transition-all shadow-lg disabled:opacity-50 flex items-center justify-center gap-2"
              style={{ background: 'linear-gradient(135deg, #5a7d63 0%, #3d6b5a 40%, #2d5a4a 100%)', boxShadow: '0 8px 24px rgba(74, 107, 82, 0.3)' }}
            >
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              Create Account
            </button>
          </form>

          <p className="text-center text-sm text-stone-500 mt-5">
            Already have an account?{' '}
            <Link to="/login" className="text-[#4a6b52] hover:text-[#3d5a47] font-semibold">Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
