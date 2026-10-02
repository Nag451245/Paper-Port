import { env } from '../config.js';

/**
 * The public address of the app, for links in emails and broker login
 * redirects. From config only (APP_BASE_URL, else the first CORS origin) —
 * never from a request's Host header, which the caller controls.
 */
export function appBaseUrl(): string {
  const base = env.APP_BASE_URL || env.CORS_ORIGINS.split(',')[0].trim();
  return base.replace(/\/+$/, '');
}
