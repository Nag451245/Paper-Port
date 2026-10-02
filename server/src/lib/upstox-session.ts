/**
 * The live Upstox access token to fetch market data with, shared by every
 * service that reads Upstox (quotes, candles, option chains, F&O analytics).
 * Null unless a user made Upstox their active broker and is logged in.
 */
import { getPrisma } from './prisma.js';
import { createChildLogger } from './logger.js';
import { BrokerAccountsService } from '../services/broker-accounts.service.js';
import { getUpstox } from '../services/upstox.service.js';

const log = createChildLogger('UpstoxSession');
let accounts: BrokerAccountsService | null = null;

export async function activeUpstoxToken(userId?: string): Promise<string | null> {
  try {
    if (!accounts) {
      const created = new BrokerAccountsService(getPrisma());
      accounts = created;
      // When Upstox refuses a token, stop presenting the login as live.
      getUpstox().onAuthFailure ??= (token) => {
        log.warn('Upstox rejected the access token; marking the Upstox login as expired');
        created.expireUpstoxToken(token).catch(() => {});
      };
    }
    return await accounts.upstoxToken(userId);
  } catch {
    return null;                                    // no database (tests, startup): skip Upstox
  }
}
