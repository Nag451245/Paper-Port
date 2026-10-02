/**
 * The brokers a user can choose between in Settings, and what each one can do
 * in this app today. "marketData" brokers can be made the active source of
 * quotes and candles; the rest can have their API keys saved ahead of support.
 *
 * Rule for every broker: this app never asks for a broker password or 2FA
 * code. Logins happen on the broker's own website (OAuth), and only the API
 * key/secret and the resulting access token are stored, encrypted.
 */
export type BrokerId = 'breeze' | 'upstox' | 'zerodha' | 'fyers' | 'dhan';
export type CredentialField = 'apiKey' | 'apiSecret' | 'clientId' | 'accessToken';

export interface BrokerInfo {
  id: BrokerId;
  name: string;
  /** Fields the Settings form asks for (Breeze keeps its own form). */
  fields: { key: CredentialField; label: string; secret: boolean }[];
  /** How a session is obtained. */
  login: 'breeze' | 'oauth' | 'token' | 'none';
  /** Can be the active source of quotes and candles. */
  marketData: boolean;
  note: string;
  docsUrl: string;
}

export const BROKERS: BrokerInfo[] = [
  {
    id: 'breeze',
    name: 'ICICI Direct (Breeze)',
    fields: [],
    login: 'breeze',
    marketData: true,
    note: 'Quotes, candles, option chains and F&O history.',
    docsUrl: 'https://api.icicidirect.com',
  },
  {
    id: 'upstox',
    name: 'Upstox',
    fields: [
      { key: 'apiKey', label: 'API key', secret: false },
      { key: 'apiSecret', label: 'API secret', secret: true },
    ],
    login: 'oauth',
    marketData: true,
    note: 'Quotes and candles for stocks and indices. Log in with Upstox once a day (Upstox tokens expire at 3:30 AM).',
    docsUrl: 'https://account.upstox.com/developer/apps',
  },
  {
    id: 'zerodha',
    name: 'Zerodha (Kite Connect)',
    fields: [
      { key: 'apiKey', label: 'API key', secret: false },
      { key: 'apiSecret', label: 'API secret', secret: true },
    ],
    login: 'none',
    marketData: false,
    note: 'Keys can be saved; using Kite for data is not built yet. Kite market data needs the paid Kite Connect plan.',
    docsUrl: 'https://developers.kite.trade',
  },
  {
    id: 'fyers',
    name: 'FYERS',
    fields: [
      { key: 'apiKey', label: 'App ID', secret: false },
      { key: 'apiSecret', label: 'Secret ID', secret: true },
    ],
    login: 'none',
    marketData: false,
    note: 'Keys can be saved; using FYERS for data is not built yet.',
    docsUrl: 'https://myapi.fyers.in/dashboard',
  },
  {
    id: 'dhan',
    name: 'Dhan',
    fields: [
      { key: 'clientId', label: 'Client ID', secret: false },
      { key: 'accessToken', label: 'Access token (from web.dhan.co → DhanHQ Trading APIs)', secret: true },
    ],
    login: 'token',
    marketData: false,
    note: 'Token can be saved; using Dhan for data is not built yet. Dhan market data APIs are a paid add-on.',
    docsUrl: 'https://dhanhq.co/docs/latest/',
  },
];

export const brokerInfo = (id: string): BrokerInfo | undefined => BROKERS.find((b) => b.id === id);
