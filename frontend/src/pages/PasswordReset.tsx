import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Mail, Lock, Loader2, CheckCircle } from 'lucide-react';
import { authApi } from '@/services/api';
import { PaperBoatLogo } from '@/pages/Login';

const INPUT =
  'w-full pl-11 pr-4 py-3 bg-white/80 border border-stone-200 rounded-xl text-sm text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-[#4a6b52]/25 focus:border-[#4a6b52]/50 transition-all';
const BUTTON =
  'w-full py-3 text-white text-sm font-bold rounded-xl transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2';
const BUTTON_STYLE = {
  background: 'linear-gradient(135deg, #5a7d63 0%, #3d6b5a 40%, #2d5a4a 100%)',
  boxShadow: '0 8px 24px rgba(74, 107, 82, 0.3)',
};

function errorText(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: unknown; details?: Record<string, string[]> } } })?.response?.data;
  const detail = data?.details && Object.values(data.details).flat()[0];
  return detail || (typeof data?.error === 'string' ? data.error : fallback);
}

/** Same paper-grid card as the sign-in page. */
function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative overflow-hidden"
      style={{ background: 'linear-gradient(145deg, #f5f0e8 0%, #ede8df 30%, #e8e4dc 60%, #f0ece4 100%)' }}>
      <div className="absolute inset-0 opacity-[0.08]"
        style={{
          backgroundImage: 'linear-gradient(#6b7b6e 1px, transparent 1px), linear-gradient(90deg, #6b7b6e 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }} />
      <div className="relative w-full max-w-sm">
        <div className="rounded-3xl p-8 pt-10 shadow-2xl shadow-stone-400/20"
          style={{
            background: 'linear-gradient(160deg, rgba(255,253,248,0.95) 0%, rgba(248,244,237,0.92) 50%, rgba(242,238,230,0.9) 100%)',
            border: '1px solid rgba(200, 190, 175, 0.3)',
          }}>
          <div className="flex justify-center mb-6"><PaperBoatLogo className="w-24 h-20" /></div>
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-stone-800 tracking-tight">{title}</h1>
            <p className="text-sm text-stone-500 mt-2 leading-relaxed">{subtitle}</p>
          </div>
          {children}
          <p className="text-center text-sm text-stone-500 mt-6">
            <Link to="/login" className="text-[#4a6b52] hover:text-[#3d5a47] font-semibold">Back to sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { data } = await authApi.forgotPassword(email.trim());
      setSent(data.message);
    } catch (err) {
      setError(errorText(err, 'Could not send the reset email. Please try again in a few minutes.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard title="Forgot your password?" subtitle="Enter your account email and we'll send you a link to choose a new one.">
      {sent ? (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700 flex gap-2">
          <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{sent} Check your spam folder if it doesn't arrive.</span>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">{error}</div>}
          <div className="relative">
            <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="Email" required autoComplete="email" className={INPUT} />
          </div>
          <button type="submit" disabled={busy} className={BUTTON} style={BUTTON_STYLE}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Send reset link
          </button>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    setError(null);
    try {
      await authApi.resetPassword(token, password);
      setDone(true);
      setTimeout(() => navigate('/login'), 2500);
    } catch (err) {
      setError(errorText(err, 'Could not change the password. The link may have expired.'));
    } finally {
      setBusy(false);
    }
  };

  if (!token) {
    return (
      <AuthCard title="Link incomplete" subtitle="This reset link is missing its code. Open the link from the email again, or request a new one.">
        <Link to="/forgot-password" className={BUTTON} style={BUTTON_STYLE}>Request a new link</Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard title="Choose a new password" subtitle="At least 8 characters. Every device signed in to your account will be signed out.">
      {done ? (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700 flex gap-2">
          <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Password changed. Taking you to sign in…</span>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-600">
              {error}{' '}
              <Link to="/forgot-password" className="font-semibold underline">Request a new link</Link>
            </div>
          )}
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder="New password" required minLength={8} autoComplete="new-password" className={INPUT} />
          </div>
          <div className="relative">
            <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat new password" required minLength={8} autoComplete="new-password" className={INPUT} />
          </div>
          {mismatch && <p className="text-xs text-red-500 -mt-2">The two passwords don't match.</p>}
          <button type="submit" disabled={busy || mismatch || password.length < 8} className={BUTTON} style={BUTTON_STYLE}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Change password
          </button>
        </form>
      )}
    </AuthCard>
  );
}
