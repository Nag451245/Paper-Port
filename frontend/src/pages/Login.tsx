import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, Loader2, Eye, EyeOff } from 'lucide-react';
import { useAuthStore } from '@/stores/auth';

function PaperBoatLogo({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 100" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Boat body */}
      <path d="M15 65 L60 85 L105 65 L95 70 L60 78 L25 70 Z" fill="#3d5a47" />
      <path d="M20 62 L60 80 L100 62 L105 65 L60 85 L15 65 Z" fill="#4a6b52" />
      {/* Sail - main */}
      <path d="M58 20 L58 65 L28 65 Z" fill="#5a7d63" />
      <path d="M62 20 L62 65 L92 65 Z" fill="#4a6b52" />
      {/* Fold lines */}
      <path d="M58 20 L45 50" stroke="#3d5a47" strokeWidth="0.8" opacity="0.5" />
      <path d="M62 20 L75 50" stroke="#3d5a47" strokeWidth="0.8" opacity="0.5" />
      {/* Arrows going up */}
      <path d="M72 35 L80 18 L76 22 M80 18 L84 22" stroke="#3d5a47" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M82 45 L90 28 L86 32 M90 28 L94 32" stroke="#4a6b52" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {/* Water line */}
      <path d="M5 75 Q20 70 35 75 Q50 80 65 75 Q80 70 95 75 Q110 80 115 75" stroke="#4a6b52" strokeWidth="1.5" opacity="0.3" fill="none" />
      <path d="M0 82 Q15 77 30 82 Q45 87 60 82 Q75 77 90 82 Q105 87 120 82" stroke="#4a6b52" strokeWidth="1" opacity="0.2" fill="none" />
    </svg>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const { login, isLoading, error, clearError } = useAuthStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(email, password);
      navigate('/dashboard');
    } catch {
      /* error is set in store */
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden"
      style={{ background: 'linear-gradient(145deg, #f5f0e8 0%, #ede8df 30%, #e8e4dc 60%, #f0ece4 100%)' }}
    >
      {/* Grid paper background */}
      <div className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage: `
            linear-gradient(#6b7b6e 1px, transparent 1px),
            linear-gradient(90deg, #6b7b6e 1px, transparent 1px)
          `,
          backgroundSize: '28px 28px',
        }}
      />

      {/* Soft warm glow */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[500px] h-[500px] bg-gradient-to-br from-amber-100/40 to-green-100/20 rounded-full blur-3xl pointer-events-none" />

      <div className="relative w-full max-w-sm">
        {/* Card */}
        <div className="rounded-3xl p-8 pt-10 shadow-2xl shadow-stone-400/20"
          style={{
            background: 'linear-gradient(160deg, rgba(255,253,248,0.95) 0%, rgba(248,244,237,0.92) 50%, rgba(242,238,230,0.9) 100%)',
            border: '1px solid rgba(200, 190, 175, 0.3)',
          }}
        >
          {/* Logo */}
          <div className="flex justify-center mb-6">
            <PaperBoatLogo className="w-24 h-20" />
          </div>

          {/* Title */}
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold text-stone-800 tracking-tight">
              Welcome back to{' '}
              <span className="text-[#4a6b52]">PaperPort</span>
            </h1>
            <p className="text-sm text-stone-500 mt-2 leading-relaxed">
              Sign in to your practice trading account for<br />learning and growth.
            </p>
          </div>

          {/* Error */}
          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600 flex items-center gap-2">
              <span>{error}</span>
              <button onClick={clearError} className="ml-auto text-red-400 hover:text-red-600 text-lg leading-none">&times;</button>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="relative">
              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                required
                className="w-full pl-11 pr-4 py-3 bg-white/80 border border-stone-200 rounded-xl text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-[#4a6b52]/25 focus:border-[#4a6b52]/50 transition-all"
              />
            </div>

            <div className="relative">
              <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Password"
                required
                className="w-full pl-11 pr-10 py-3 bg-white/80 border border-stone-200 rounded-xl text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-[#4a6b52]/25 focus:border-[#4a6b52]/50 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 text-white text-sm font-bold rounded-xl transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              style={{
                background: 'linear-gradient(135deg, #5a7d63 0%, #3d6b5a 40%, #2d5a4a 100%)',
                boxShadow: '0 8px 24px rgba(74, 107, 82, 0.3)',
              }}
            >
              {isLoading && <Loader2 className="w-4 h-4 animate-spin" />}
              Sign In
            </button>
          </form>

          {/* Divider */}
          <div className="flex items-center gap-3 my-6">
            <div className="flex-1 h-px bg-stone-200/80" />
            <span className="text-xs text-stone-400 font-medium">or continue with</span>
            <div className="flex-1 h-px bg-stone-200/80" />
          </div>

          {/* Google */}
          <button className="w-full py-2.5 bg-white hover:bg-stone-50 border border-stone-200 text-stone-600 text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2.5 shadow-sm">
            <svg className="w-4 h-4" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
            Google
          </button>

          {/* Sign up link */}
          <p className="text-center text-sm text-stone-500 mt-6">
            Don't have an account?{' '}
            <Link to="/register" className="text-[#4a6b52] hover:text-[#3d5a47] font-semibold">
              Sign up
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
