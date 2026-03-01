import { useState, useEffect } from 'react';
import {
  Key,
  Wallet,
  Sun,
  Bell,
  Save,
  CheckCircle,
  AlertCircle,
  Loader2,
  BookOpen,
  Settings2,
  ExternalLink,
  Clock,
  Shield,
  RefreshCw,
} from 'lucide-react';
import { breezeApi, portfolioApi } from '@/services/api';
import type { BreezeCredentialStatus } from '@/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

type SettingsTab = 'config' | 'guide';

export default function Settings() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('config');
  const [breezeStatus, setBreezeStatus] = useState<BreezeCredentialStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [virtualCapital, setVirtualCapital] = useState('1000000');
  const [portfolioId, setPortfolioId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState({
    tradeExecuted: true,
    signalGenerated: true,
    riskAlert: true,
    dailyReport: false,
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [breezeError, setBreezeError] = useState('');
  const [breezeSuccess, setBreezeSuccess] = useState('');
  const [breezeConnecting, setBreezeConnecting] = useState(false);
  const [autoGeneratingSession, setAutoGeneratingSession] = useState(false);
  const [totpSecret, setTotpSecret] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [loginId, setLoginId] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  useEffect(() => {
    breezeApi.status().then(({ data }) => setBreezeStatus(data)).catch(() => {});

    portfolioApi.list().then(({ data }) => {
      if (Array.isArray(data) && data.length > 0) {
        const p = data[0] as any;
        setPortfolioId(p.id);
        const cap = Number(p.initialCapital ?? p.initial_capital ?? p.capital ?? 1000000);
        setVirtualCapital(String(cap));
      }
    }).catch(() => {});

    const onSessionSaved = async (event: MessageEvent) => {
      if (event.data?.type !== 'breeze_session_saved') return;
      if (event.data.token) {
        try {
          await breezeApi.saveSession(event.data.token);
        } catch { /* already saved server-side if state was valid */ }
      }
      breezeApi.status().then(({ data }) => setBreezeStatus(data)).catch(() => {});
      setBreezeSuccess('Session token captured and saved from popup.');
      setTimeout(() => setBreezeSuccess(''), 4000);
    };

    window.addEventListener('message', onSessionSaved);
    return () => window.removeEventListener('message', onSessionSaved);
  }, []);

  const handleBreezeConnect = async () => {
    setBreezeConnecting(true);
    setBreezeError('');
    setBreezeSuccess('');
    try {
      const { data } = await breezeApi.connect(
        apiKey, secretKey,
        totpSecret.trim() || undefined,
        sessionToken.trim() || undefined,
        loginId.trim() || undefined,
        loginPassword.trim() || undefined,
      );
      setBreezeStatus(data);
      const hasLogin = !!(loginId.trim() && loginPassword.trim() && totpSecret.trim());
      setBreezeSuccess(
        hasLogin
          ? 'Credentials saved! Auto-login is enabled — sessions will renew automatically every day.'
          : 'Breeze API credentials saved successfully!'
      );
      setApiKey('');
      setSecretKey('');
      setTotpSecret('');
      setSessionToken('');
      setLoginId('');
      setLoginPassword('');
      setTimeout(() => setBreezeSuccess(''), 4000);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.response?.data?.detail || 'Failed to save credentials';
      setBreezeError(msg);
    }
    setBreezeConnecting(false);
  };

  const handleSessionTokenSave = async () => {
    if (!sessionToken.trim()) {
      setBreezeError('Enter a valid session token');
      return;
    }
    setBreezeConnecting(true);
    setBreezeError('');
    setBreezeSuccess('');
    try {
      await breezeApi.saveSession(sessionToken.trim());
      setBreezeSuccess('Session token saved! Historical data and charts are now available.');
      setSessionToken('');
      const { data } = await breezeApi.status();
      setBreezeStatus(data);
      setTimeout(() => setBreezeSuccess(''), 4000);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.response?.data?.detail || 'Failed to save session token';
      setBreezeError(msg);
    }
    setBreezeConnecting(false);
  };

  const handleAutoSessionGenerate = async () => {
    setAutoGeneratingSession(true);
    setBreezeError('');
    setBreezeSuccess('');
    try {
      await breezeApi.autoSession();
      const { data } = await breezeApi.status();
      setBreezeStatus(data);
      setBreezeSuccess('Session generated automatically from server-side TOTP.');
      setTimeout(() => setBreezeSuccess(''), 4000);
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.response?.data?.detail || 'Auto generation failed';
      setBreezeError(`${msg}. Use "Generate Session Popup" fallback below.`);
    }
    setAutoGeneratingSession(false);
  };

  const handleGenerateSessionPopup = async () => {
    setAutoGeneratingSession(true);
    setBreezeError('');
    setBreezeSuccess('');
    try {
      const { data } = await breezeApi.loginUrl();
      const popup = window.open(data.login_url, 'breeze-login', 'width=520,height=780');
      if (!popup) {
        setBreezeError('Popup blocked by browser. Allow popups and try again.');
      } else {
        setBreezeSuccess('Complete ICICI login in popup. Session will auto-save after redirect.');
      }
    } catch (err: any) {
      const msg = err?.response?.data?.error || err?.response?.data?.detail || 'Failed to open Breeze login';
      setBreezeError(msg);
    }
    setAutoGeneratingSession(false);
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError('');
    setSaved(false);

    try {
      const cap = Number(virtualCapital);
      if (!cap || cap <= 0 || !Number.isFinite(cap)) {
        setSaveError('Enter a valid capital amount');
        setSaving(false);
        return;
      }

      if (!portfolioId) {
        setSaveError('No portfolio found. Please reload the page.');
        setSaving(false);
        return;
      }

      await portfolioApi.updateCapital(portfolioId, cap);

      const { data } = await portfolioApi.list();
      if (Array.isArray(data) && data.length > 0) {
        const p = data[0] as any;
        const updatedCap = Number(p.initialCapital ?? p.initial_capital ?? cap);
        setVirtualCapital(String(updatedCap));
      }

      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      if (err?.response?.data) {
        const errData = err.response.data;
        const details = errData.details ? ` (${JSON.stringify(errData.details)})` : '';
        setSaveError((errData.error || errData.detail || errData.message || 'Server error') + details);
      } else if (err?.code === 'ECONNABORTED') {
        setSaveError('Request timed out. The server may be busy — try again.');
      } else {
        setSaveError(err?.message || 'Failed to save settings');
      }
    }
    setSaving(false);
  };

  const tabs: { key: SettingsTab; label: string; icon: typeof Settings2 }[] = [
    { key: 'config', label: 'Configuration', icon: Settings2 },
    { key: 'guide', label: 'Setup Guide', icon: BookOpen },
  ];

  return (
    <div className="space-y-6 max-w-3xl">
      <h1 className="text-2xl font-bold text-slate-900">Settings</h1>

      {/* Tab bar */}
      <div className="flex gap-1 bg-slate-100 p-1 rounded-xl">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
                activeTab === tab.key
                  ? 'bg-white text-indigo-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'guide' && <SetupGuide />}

      {activeTab === 'config' && (
        <>
          {/* Breeze API Credentials */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Key className="w-5 h-5 text-indigo-500" />
              <h2 className="text-lg font-semibold text-slate-900">Breeze API Credentials</h2>
            </div>
            <div className="flex items-center gap-2 mb-2">
              {breezeStatus?.isConnected ? (
                <>
                  <CheckCircle className="w-4 h-4 text-emerald-600" />
                  <span className="text-sm text-emerald-600">API Connected</span>
                  <span className="text-xs text-slate-400 ml-2">
                    Last updated: {breezeStatus.lastConnected ? new Date(breezeStatus.lastConnected).toLocaleString('en-IN') : 'N/A'}
                  </span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 text-amber-500" />
                  <span className="text-sm text-amber-600">Not Connected</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 mb-2">
              {breezeStatus?.hasSession ? (
                <>
                  <CheckCircle className="w-4 h-4 text-emerald-600" />
                  <span className="text-sm text-emerald-600">Session Active</span>
                  {breezeStatus.sessionExpiry && (
                    <span className="text-xs text-slate-400 ml-2">
                      Expires: {new Date(breezeStatus.sessionExpiry).toLocaleString('en-IN')}
                    </span>
                  )}
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4 text-amber-500" />
                  <span className="text-sm text-amber-600">No Session — enter session token below for live data & charts</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 mb-4">
              {breezeStatus?.canAutoLogin ? (
                <>
                  <RefreshCw className="w-4 h-4 text-emerald-600" />
                  <span className="text-sm text-emerald-600">Auto-Login Enabled</span>
                  {breezeStatus.lastAutoLoginAt && (
                    <span className="text-xs text-slate-400 ml-2">
                      Last: {new Date(breezeStatus.lastAutoLoginAt).toLocaleString('en-IN')}
                    </span>
                  )}
                </>
              ) : breezeStatus?.isConnected ? (
                <>
                  <AlertCircle className="w-4 h-4 text-slate-400" />
                  <span className="text-sm text-slate-500">Auto-Login Disabled — add Login ID, Password & TOTP below</span>
                </>
              ) : null}
              {breezeStatus?.autoLoginError && (
                <span className="text-xs text-red-500 ml-2">{breezeStatus.autoLoginError}</span>
              )}
            </div>
            {breezeError && (
              <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {breezeError}
              </div>
            )}
            {breezeSuccess && (
              <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-600 flex items-center gap-2">
                <CheckCircle className="w-4 h-4 shrink-0" />
                {breezeSuccess}
              </div>
            )}
            <div className="space-y-3">
              <div>
                <label className="text-xs text-slate-500 mb-1 block">API Key</label>
                <input
                  type="text"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Enter your Breeze API Key"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">Secret Key</label>
                <input
                  type="password"
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder="Enter your Breeze Secret Key"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
              <div className="pt-3 border-t border-slate-100">
                <p className="text-xs font-semibold text-slate-600 mb-2 uppercase tracking-wide flex items-center gap-1">
                  <Shield className="w-3 h-3" /> Auto-Login Credentials (Login Once & Forget)
                </p>
                <p className="text-xs text-slate-400 mb-3">
                  Enter your ICICI Direct login credentials and TOTP secret to enable fully automatic daily session generation. The server will log in on your behalf every morning — no manual steps needed.
                </p>
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">ICICI Login ID (User ID)</label>
                <input
                  type="text"
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  placeholder="Your ICICI Direct trading account user ID"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">ICICI Login Password</label>
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder="Your ICICI Direct trading account password"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 mb-1 block">TOTP Secret</label>
                <input
                  type="text"
                  value={totpSecret}
                  onChange={(e) => setTotpSecret(e.target.value)}
                  placeholder="Base32 TOTP secret from your authenticator app setup"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
                <p className="text-xs text-slate-400 mt-1">Same secret used to set up Google Authenticator / Authy for ICICI Direct</p>
              </div>
              <button
                onClick={handleBreezeConnect}
                disabled={breezeConnecting || (!breezeStatus?.isConnected && (!apiKey || !secretKey))}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {breezeConnecting ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : null}
                {breezeStatus?.isConnected ? 'Update Credentials' : 'Connect'}
              </button>

              <div className="mt-4 pt-4 border-t border-slate-200">
                <p className="text-xs font-semibold text-slate-600 mb-2 uppercase tracking-wide">Daily Session Token</p>
                <p className="text-xs text-slate-400 mb-2">
                  Preferred: Auto-generate from TOTP. If broker blocks automation, use popup fallback or paste manually.
                </p>
                <div className="flex flex-wrap gap-2 mb-3">
                  <button
                    onClick={handleAutoSessionGenerate}
                    disabled={autoGeneratingSession || breezeConnecting}
                    className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {autoGeneratingSession ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : <RefreshCw className="w-4 h-4 inline mr-1" />}
                    Auto Generate Session
                  </button>
                  <button
                    onClick={handleGenerateSessionPopup}
                    disabled={autoGeneratingSession || breezeConnecting}
                    className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {autoGeneratingSession ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : <ExternalLink className="w-4 h-4 inline mr-1" />}
                    Generate Session Popup
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={sessionToken}
                    onChange={(e) => setSessionToken(e.target.value)}
                    placeholder="Paste your daily session token from ICICI Direct"
                    className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                  />
                  <button
                    onClick={handleSessionTokenSave}
                    disabled={breezeConnecting || !sessionToken.trim()}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    {breezeConnecting ? <Loader2 className="w-4 h-4 animate-spin inline mr-2" /> : null}
                    Save Session
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Virtual Capital */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Wallet className="w-5 h-5 text-emerald-500" />
              <h2 className="text-lg font-semibold text-slate-900">Virtual Capital</h2>
            </div>
            <div>
              <label className="text-xs text-slate-500 mb-1 block">Capital Amount (₹)</label>
              <input
                type="number"
                value={virtualCapital}
                onChange={(e) => setVirtualCapital(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
              />
              <p className="text-xs text-slate-400 mt-1">
                Current: ₹{Number(virtualCapital || 0).toLocaleString('en-IN')}
              </p>
            </div>
          </section>

          {/* Theme */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sun className="w-5 h-5 text-amber-500" />
                <h2 className="text-lg font-semibold text-slate-900">Theme</h2>
              </div>
              <span className="text-sm text-indigo-600 font-medium px-3 py-1 bg-indigo-50 rounded-full">Light</span>
            </div>
            <p className="text-xs text-slate-400 mt-2">
              Bright professional theme active. Optimized for readability and modern aesthetics.
            </p>
          </section>

          {/* Notifications */}
          <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
            <div className="flex items-center gap-2 mb-4">
              <Bell className="w-5 h-5 text-amber-500" />
              <h2 className="text-lg font-semibold text-slate-900">Notification Preferences</h2>
            </div>
            <div className="space-y-3">
              {[
                { key: 'tradeExecuted' as const, label: 'Trade Executed', desc: 'Get notified when a trade is executed' },
                { key: 'signalGenerated' as const, label: 'AI Signal Generated', desc: 'Get notified when AI generates a new signal' },
                { key: 'riskAlert' as const, label: 'Risk Alerts', desc: 'Get notified when capital preservation rules trigger' },
                { key: 'dailyReport' as const, label: 'Daily Report', desc: 'Receive end-of-day performance report' },
              ].map(({ key, label, desc }) => (
                <div key={key} className="flex items-center justify-between py-2">
                  <div>
                    <p className="text-sm text-slate-800">{label}</p>
                    <p className="text-xs text-slate-400">{desc}</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={notifications[key]}
                      onChange={(e) => setNotifications({ ...notifications, [key]: e.target.checked })}
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-200 rounded-full peer peer-checked:bg-indigo-600 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
                  </label>
                </div>
              ))}
            </div>
          </section>

          {/* Save button */}
          {saveError && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {saveError}
            </div>
          )}
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-bold rounded-lg transition-colors disabled:opacity-50"
          >
            {saving ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : saved ? (
              <CheckCircle className="w-4 h-4" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {saved ? 'Saved!' : 'Save Settings'}
          </button>
        </>
      )}
    </div>
  );
}

function SetupGuide() {
  return (
    <div className="space-y-5">
      {/* Overview */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900 mb-3">Getting Started</h2>
        <p className="text-sm text-slate-600 leading-relaxed">
          PaperPort uses the <strong>ICICI Direct Breeze API</strong> to fetch live market data,
          historical charts, and execute trades. You need two things to get started:
        </p>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="p-4 bg-indigo-50 border border-indigo-100 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <Key className="w-4 h-4 text-indigo-600" />
              <span className="text-sm font-semibold text-indigo-800">API Key & Secret</span>
            </div>
            <p className="text-xs text-indigo-700">One-time setup. Never expires.</p>
          </div>
          <div className="p-4 bg-amber-50 border border-amber-100 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <RefreshCw className="w-4 h-4 text-amber-600" />
              <span className="text-sm font-semibold text-amber-800">Session Token</span>
            </div>
            <p className="text-xs text-amber-700">Auto-generate daily (preferred), popup/manual fallback.</p>
          </div>
        </div>
      </section>

      {/* Credential Validity */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Clock className="w-5 h-5 text-indigo-500" />
          <h2 className="text-lg font-semibold text-slate-900">Credential Validity & Persistence</h2>
        </div>

        <div className="space-y-4">
          <div className="flex gap-3">
            <div className="mt-0.5 w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
              <Shield className="w-4 h-4 text-emerald-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">API Key & Secret Key</p>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                These are <strong>permanent</strong> and do not expire. They are stored securely
                (encrypted with AES-256) on the server. <strong>You only need to enter them once.</strong>{' '}
                Logging out and logging back in will not require you to re-enter them.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="mt-0.5 w-8 h-8 rounded-full bg-amber-100 flex items-center justify-center shrink-0">
              <Clock className="w-4 h-4 text-amber-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">Session Token</p>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                The session token is valid for <strong>24 hours</strong> from the time you save it.
                ICICI Direct generates a new session each time you log in. You need to update this
                token <strong>once per trading day</strong> (typically at market open, 9:00 AM). The app first
                tries server-side auto-generation using your TOTP secret; if the broker rejects it, fallback
                is popup login or manual token paste.
                The token persists across app logout/login within the same day — you do not need to
                re-enter it if you log out and back in.
              </p>
            </div>
          </div>

          <div className="flex gap-3">
            <div className="mt-0.5 w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
              <BookOpen className="w-4 h-4 text-slate-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-slate-800">TOTP Secret (Optional)</p>
              <p className="text-xs text-slate-500 mt-1 leading-relaxed">
                If you provide your TOTP secret, the system can attempt server-side session generation
                automatically. This is the same secret used by your authenticator app and is required for
                auto mode. You can still use popup/manual fallback at any time.
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 p-3 bg-blue-50 border border-blue-100 rounded-lg">
          <p className="text-xs text-blue-700 leading-relaxed">
            <strong>Summary:</strong> API key & secret = enter once, forever. Session token = update once per
            trading day. All credentials are saved server-side and survive logout/login cycles.
          </p>
        </div>
      </section>

      {/* Step by step */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <BookOpen className="w-5 h-5 text-indigo-500" />
          <h2 className="text-lg font-semibold text-slate-900">Step-by-Step Setup</h2>
        </div>

        <div className="space-y-5">
          {/* Step 1 */}
          <div className="flex gap-4">
            <div className="w-7 h-7 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs font-bold shrink-0">1</div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-slate-800">Get Your API Key & Secret from ICICI Direct</p>
              <ol className="mt-2 space-y-1.5 text-xs text-slate-600 list-decimal list-inside leading-relaxed">
                <li>
                  Go to{' '}
                  <a href="https://api.icicidirect.com" target="_blank" rel="noreferrer" className="text-indigo-600 hover:underline inline-flex items-center gap-0.5">
                    api.icicidirect.com <ExternalLink className="w-3 h-3" />
                  </a>
                </li>
                <li>Log in with your ICICI Direct credentials</li>
                <li>Navigate to <strong>Apps</strong> section and create a new app (or use an existing one)</li>
                <li>Copy the <strong>API Key</strong> and <strong>Secret Key</strong> shown on the app page</li>
                <li>Come back here, paste them in the Configuration tab, and click <strong>Connect</strong></li>
              </ol>
              <div className="mt-2 p-2 bg-emerald-50 rounded text-[11px] text-emerald-700">
                These never expire. You only do this step once.
              </div>
            </div>
          </div>

          {/* Step 2 */}
          <div className="flex gap-4">
            <div className="w-7 h-7 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs font-bold shrink-0">2</div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-slate-800">Enable Auto-Login (Login Once & Forget)</p>
              <ol className="mt-2 space-y-1.5 text-xs text-slate-600 list-decimal list-inside leading-relaxed">
                <li>In the Configuration tab, fill in your <strong>ICICI Login ID</strong>, <strong>Login Password</strong>, and <strong>TOTP Secret</strong></li>
                <li>Click <strong>Connect</strong> to save all credentials</li>
                <li>The server will automatically log in every morning at 8:00 AM IST and generate a fresh session token</li>
                <li>You never need to manually enter session tokens again</li>
              </ol>
              <div className="mt-2 p-2 bg-emerald-50 rounded text-[11px] text-emerald-700">
                <strong>Fully automatic!</strong> The server handles daily login using your saved credentials. All data is AES-256 encrypted.
              </div>
              <div className="mt-2 p-2 bg-amber-50 rounded text-[11px] text-amber-700">
                <strong>Fallback:</strong> If auto-login fails (e.g., ICICI changes login flow), click <strong>Auto Generate Session</strong>, use <strong>Popup</strong>, or paste the token manually.
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div className="flex gap-4">
            <div className="w-7 h-7 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs font-bold shrink-0">3</div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-slate-800">Start Using the Platform</p>
              <p className="mt-2 text-xs text-slate-600 leading-relaxed">
                Once both the API credentials and session token are saved, you can:
              </p>
              <ul className="mt-1.5 space-y-1 text-xs text-slate-600 list-disc list-inside">
                <li><strong>Trading Terminal</strong> — search stocks, view live charts, and place orders</li>
                <li><strong>Backtesting</strong> — run strategies on real historical data</li>
                <li><strong>Intelligence</strong> — view FII/DII flows, options chain, sector data</li>
                <li><strong>Portfolio</strong> — track your positions and P&L</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900 mb-4">Frequently Asked Questions</h2>
        <div className="space-y-4">
          <FaqItem
            q="Do I need to re-enter API keys if I log out?"
            a="No. Your API Key and Secret Key are stored securely on the server (encrypted). They persist across logout/login sessions. You enter them once and they're saved permanently."
          />
          <FaqItem
            q="Do I need to re-enter the session token if I log out and log back in?"
            a="No. The session token is also stored server-side. As long as it hasn't expired (24 hours from when you saved it), it will continue to work even if you log out and log back in."
          />
          <FaqItem
            q="When do I need to update the session token?"
            a="Once per trading day, typically before 9:00 AM IST. The ICICI Direct session is valid for approximately 24 hours from the time you log in on their portal."
          />
          <FaqItem
            q="What happens if my session token expires?"
            a="Charts and backtesting will stop loading historical data. You'll see a message asking you to update the session token. Simply log into ICICI Direct again, copy the new token, and paste it here."
          />
          <FaqItem
            q="Is my API key and secret safe?"
            a="Yes. All credentials are encrypted using AES-256-CBC before storage. The encryption key is derived from the server's JWT secret and is never exposed to the frontend."
          />
          <FaqItem
            q="What is the TOTP secret?"
            a="It's the same secret your authenticator app (Google Authenticator, Authy, etc.) uses to generate 6-digit codes. If you provide it here, the platform can auto-generate sessions in the future. This field is completely optional."
          />
        </div>
      </section>
    </div>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full text-left flex items-start gap-2"
      >
        <span className={`text-indigo-500 mt-0.5 text-sm transition-transform ${open ? 'rotate-90' : ''}`}>&#9654;</span>
        <span className="text-sm font-medium text-slate-800">{q}</span>
      </button>
      {open && (
        <p className="mt-2 ml-6 text-xs text-slate-500 leading-relaxed">{a}</p>
      )}
    </div>
  );
}
