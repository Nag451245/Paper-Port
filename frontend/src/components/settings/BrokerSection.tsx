import { useEffect, useState } from 'react';
import { Building2, CheckCircle, AlertCircle, Loader2, ExternalLink, Copy, Trash2, LogIn, Radio, Smartphone } from 'lucide-react';
import { brokersApi, type BrokerId, type BrokerList, type BrokerStatus, type BrokerField } from '@/services/api';

const errorText = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

function statusChip(b: BrokerStatus, active: boolean) {
  if (active) return { text: 'Active', cls: 'bg-indigo-600 text-white' };
  if (b.connected) return { text: 'Connected', cls: 'bg-emerald-50 text-emerald-700' };
  if (b.saved) return { text: 'Keys saved', cls: 'bg-slate-100 text-slate-600' };
  return { text: 'Not set up', cls: 'bg-slate-50 text-slate-400' };
}

/**
 * Pick a broker, save or change its API keys, log in on the broker's own
 * site, and choose which broker supplies market data. Broker passwords are
 * never typed here.
 */
/** Read once: the return from a broker's login page, /settings?broker=upstox&status=connected. */
function readReturn() {
  const params = new URLSearchParams(window.location.search);
  return { broker: params.get('broker') as BrokerId | null, status: params.get('status'), message: params.get('message') };
}

export default function BrokerSection() {
  // Read in a pure initialiser and cleaned up in an effect: development mode runs
  // both twice, and reading must not depend on the cleanup having happened.
  const [returned] = useState(readReturn);
  useEffect(() => {
    if (returned.broker) window.history.replaceState(null, '', window.location.pathname);
  }, [returned.broker]);
  const [list, setList] = useState<BrokerList | null>(null);
  const [selected, setSelected] = useState<BrokerId>(returned.broker ?? 'breeze');
  const [form, setForm] = useState<Partial<Record<BrokerField, string>>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(
    returned.status === 'error' ? returned.message || 'Broker login failed.' : null,
  );
  const [success, setSuccess] = useState<string | null>(
    returned.status === 'connected' ? 'Logged in with Upstox. It now supplies your market data.' : null,
  );

  useEffect(() => {
    brokersApi.list()
      .then(({ data }) => { setList(data); if (!returned.broker) setSelected(data.active); })
      .catch(() => setError('Could not load brokers.'));
  }, [returned.broker]);

  const run = async (label: string, action: () => Promise<{ data: BrokerList } | void>, done?: string) => {
    setBusy(label); setError(null); setSuccess(null);
    try {
      const res = await action();
      if (res) setList(res.data);
      if (done) setSuccess(done);
    } catch (err) {
      setError(errorText(err, 'Something went wrong.'));
    } finally {
      setBusy(null);
    }
  };

  if (!list) {
    return (
      <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          {error ? <><AlertCircle className="w-4 h-4 text-red-500" /> {error}</> : <><Loader2 className="w-4 h-4 animate-spin" /> Loading brokers…</>}
        </div>
      </section>
    );
  }

  const broker = list.brokers.find((b) => b.id === selected) ?? list.brokers[0];
  const isActive = list.active === broker.id;
  const select = (id: BrokerId) => { setSelected(id); setForm({}); setError(null); setSuccess(null); };

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-6 shadow-sm">
      <div className="flex items-center gap-2 mb-1">
        <Building2 className="w-5 h-5 text-indigo-500" />
        <h2 className="text-lg font-semibold text-slate-900">Broker</h2>
      </div>
      <p className="text-xs text-slate-500 mb-4">
        Choose which broker supplies quotes and charts. You can change it, or change any broker&apos;s API keys, at any time.
        This app never asks for your broker password: you log in on the broker&apos;s own website.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mb-4">
        {list.brokers.map((b) => {
          const chip = statusChip(b, list.active === b.id);
          return (
            <button key={b.id} onClick={() => select(b.id)}
              className={`text-left rounded-lg border p-3 transition-all ${selected === b.id ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-slate-200 hover:border-slate-300'}`}>
              <p className="text-sm font-semibold text-slate-800 leading-tight">{b.name}</p>
              <span className={`inline-block mt-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded ${chip.cls}`}>{chip.text}</span>
              <p className="text-[10px] text-slate-400 mt-1">{b.marketData ? 'Market data: yes' : 'Market data: not yet'}</p>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="mb-3 p-3 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-600 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 shrink-0" /> {success}
        </div>
      )}

      <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-slate-800">{broker.name}</p>
          <a href={broker.docsUrl} target="_blank" rel="noreferrer" className="text-xs text-indigo-600 hover:text-indigo-500 flex items-center gap-1">
            Broker developer page <ExternalLink className="w-3 h-3" />
          </a>
        </div>
        <p className="text-xs text-slate-500">{broker.note}</p>

        {broker.id === 'breeze' && (
          <p className="text-xs text-slate-500">ICICI keys and the daily session are managed in the <strong>Breeze API Credentials</strong> section below.</p>
        )}

        {broker.id === 'upstox' && (
          <div className="text-xs text-slate-600 space-y-1">
            <p>1. On the Upstox developer page, create an app and set its <strong>Redirect URL</strong> to:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded bg-white border border-slate-200 px-2 py-1 font-mono text-[11px]">{list.redirectUris.upstox}</code>
              <button onClick={() => navigator.clipboard?.writeText(list.redirectUris.upstox).then(() => setSuccess('Redirect URL copied.'))}
                className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-100" title="Copy">
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
            <p>2. Save the app&apos;s API key and secret below. 3. Log in with Upstox once in the browser.</p>
            <p className="pt-2 font-medium text-slate-700">Daily login from your phone (optional)</p>
            <p>
              Upstox logins expire at 3:30 AM. Instead of logging in here each morning, set the app&apos;s
              <strong> Notifier Webhook Endpoint</strong> to the address below. Every weekday at 8:00 AM the app sends
              you an approval request in the Upstox app and on WhatsApp; one tap and today&apos;s login is done.
              No password, PIN or 2FA code is stored.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded bg-white border border-slate-200 px-2 py-1 font-mono text-[11px]">{list.notifierUris.upstox}</code>
              <button onClick={() => navigator.clipboard?.writeText(list.notifierUris.upstox).then(() => setSuccess('Notifier address copied.'))}
                className="p-1.5 rounded border border-slate-200 bg-white hover:bg-slate-100" title="Copy">
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {broker.fields.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {broker.fields.map((f) => (
              <label key={f.key} className="text-xs text-slate-500">
                {f.label}
                <input
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  value={form[f.key] ?? ''}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder={broker.fieldsSaved.includes(f.key) ? 'Saved — type to replace' : `Enter ${f.label.split(' (')[0]}`}
                  className="mt-1 w-full px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </label>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 pt-1">
          {broker.fields.length > 0 && (
            <button
              disabled={!!busy || !Object.values(form).some((v) => v?.trim())}
              onClick={() => run('save', async () => { const r = await brokersApi.save(broker.id, form); setForm({}); return r; }, `${broker.name} keys saved.`)}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold rounded-lg disabled:opacity-50">
              {busy === 'save' ? <Loader2 className="w-4 h-4 animate-spin inline" /> : broker.saved ? 'Update keys' : 'Save keys'}
            </button>
          )}

          {broker.login === 'oauth' && (
            <button
              disabled={!!busy || !broker.saved}
              title={broker.saved ? '' : 'Save the API key and secret first'}
              onClick={() => run('login', async () => {
                const { data } = await brokersApi.upstoxLogin();
                window.location.href = data.loginUrl;            // Upstox's own login page
              })}
              className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-sm font-semibold rounded-lg disabled:opacity-50 flex items-center gap-1.5">
              {busy === 'login' ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
              {broker.connected ? 'Log in again' : `Log in with ${broker.name}`}
            </button>
          )}

          {broker.id === 'upstox' && broker.autoSessionReady && !broker.connected && (
            <button
              disabled={!!busy}
              onClick={() => run('approve', async () => {
                const { data } = await brokersApi.upstoxRequestToken();
                setSuccess(data.message);
              })}
              className="px-4 py-2 bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 text-sm font-semibold rounded-lg disabled:opacity-50 flex items-center gap-1.5">
              {busy === 'approve' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Smartphone className="w-4 h-4" />}
              Send approval to my phone
            </button>
          )}

          {broker.marketData && !isActive && (
            <button
              disabled={!!busy}
              onClick={() => run('active', () => brokersApi.setActive(broker.id), `${broker.name} now supplies your market data.`)}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg disabled:opacity-50 flex items-center gap-1.5">
              {busy === 'active' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Radio className="w-4 h-4" />}
              Use for market data
            </button>
          )}
          {isActive && <span className="text-xs font-medium text-indigo-600">Supplying your market data</span>}

          {broker.id !== 'breeze' && broker.saved && (
            <button
              disabled={!!busy}
              onClick={() => run('remove', () => brokersApi.remove(broker.id), `${broker.name} removed.`)}
              className="ml-auto px-3 py-2 text-xs text-red-600 hover:bg-red-50 rounded-lg flex items-center gap-1">
              <Trash2 className="w-3.5 h-3.5" /> Remove
            </button>
          )}
        </div>

        {broker.connected && broker.tokenExpiresAt && broker.id !== 'breeze' && (
          <p className="text-[11px] text-slate-400">Logged in until {new Date(broker.tokenExpiresAt).toLocaleString('en-IN')}.</p>
        )}
      </div>
    </section>
  );
}
