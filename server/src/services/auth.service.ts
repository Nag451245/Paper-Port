import bcrypt from 'bcryptjs';
import { PrismaClient, type User } from '@prisma/client';
type RiskAppetite = string;
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import https from 'https';
import * as OTPAuth from 'otpauth';
import { env } from '../config.js';
import { getRedis } from '../lib/redis.js';
import { sendMail } from '../lib/mailer.js';
import { appBaseUrl } from '../lib/app-url.js';
import { notePasswordChanged } from '../lib/token-revocation.js';

const SALT_ROUNDS = 12;
const RESET_TTL_MS = 30 * 60 * 1000;
const RESET_MAX_PER_HOUR = 3;

const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);


function httpsRequestWithBody(options: https.RequestOptions, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(new Error('Timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  location?: string;
}

/**
 * Make an HTTP(S) request with full control over redirects and cookies.
 * Returns the raw response including headers (for cookie/redirect tracking).
 */
function httpRequest(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: opts.method ?? 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...opts.headers,
      },
    };

    const req = https.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        const hdrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          hdrs[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : (v ?? '');
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: hdrs,
          body,
          location: res.headers.location ?? undefined,
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(opts.timeoutMs ?? 15_000, () => req.destroy(new Error('Timeout')));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

export interface RegisterInput {
  email: string;
  password: string;
  fullName: string;
  riskAppetite?: RiskAppetite;
  virtualCapital?: number;
}

export interface LoginInput {
  email: string;
  password: string;
}

// No ICICI login ID, password or TOTP secret here: those are server config
// (BREEZE_LOGIN_ID / BREEZE_LOGIN_PASSWORD / BREEZE_TOTP_SECRET), never request data.
export interface BreezeCredentialInput {
  apiKey: string;
  secretKey: string;
  sessionToken?: string;
}

export interface UserProfile {
  id: string;
  email: string;
  fullName: string;
  riskAppetite: string;
  virtualCapital: number;
  role: string;
  isActive: boolean;
  status: string;
  createdAt: Date;
}

function toProfile(user: User): UserProfile {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    riskAppetite: user.riskAppetite,
    virtualCapital: Number(user.virtualCapital),
    role: user.role,
    isActive: user.isActive,
    status: user.status ?? 'ACTIVE',
    createdAt: user.createdAt,
  };
}

function deriveEncryptionKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/**
 * Credential encryption.
 *
 * Writes AES-256-GCM as `v2:<iv>:<authTag>:<ciphertext>`. GCM is authenticated,
 * so tampering with a stored credential fails loudly instead of decrypting to
 * attacker-influenced plaintext.
 *
 * Reads still accept the legacy unauthenticated `aes-256-cbc` format
 * (`<iv>:<ciphertext>`) so existing rows keep working; they are upgraded to v2
 * the next time the credential is written.
 */
const CIPHER_V2 = 'v2';

export function encrypt(text: string, secret: string): string {
  const key = deriveEncryptionKey(secret);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${CIPHER_V2}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decrypt(encryptedText: string, secret: string): string {
  const key = deriveEncryptionKey(secret);
  const parts = encryptedText.split(':');

  if (parts[0] === CIPHER_V2) {
    if (parts.length !== 4) throw new Error('Malformed v2 ciphertext');
    const [, ivHex, tagHex, dataHex] = parts;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  }

  // Legacy AES-256-CBC — unauthenticated, read-only for migration
  if (parts.length !== 2) throw new Error('Malformed ciphertext');
  const [ivHex, encrypted] = parts;
  const decipher = createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

export class AuthService {
  private readonly encKey: string;

  constructor(
    private prisma: PrismaClient,
    private jwtSecret: string,
  ) {
    this.encKey = env.ENCRYPTION_KEY;
  }

  async register(input: RegisterInput): Promise<{ user: UserProfile; userId: string; pending: boolean }> {
    const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) {
      throw new AuthError('Email already registered', 409);
    }
    // New accounts wait for the administrator; the administrator's own account does not.
    const isAdmin = input.email.trim().toLowerCase() === env.ADMIN_EMAIL.toLowerCase();

    const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);

    const user = await this.prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        fullName: input.fullName,
        riskAppetite: input.riskAppetite ?? 'MODERATE',
        virtualCapital: input.virtualCapital ?? 1000000,
        role: isAdmin ? 'ADMIN' : 'LEARNER',
        status: isAdmin ? 'ACTIVE' : 'PENDING',
        isActive: isAdmin,
        portfolios: {
          create: {
            name: 'Default Portfolio',
            isDefault: true,
            initialCapital: input.virtualCapital ?? 1000000,
            currentNav: input.virtualCapital ?? 1000000,
          },
        },
      },
    });

    return { user: toProfile(user), userId: user.id, pending: !isAdmin };
  }

  /**
   * Failed-login throttling.
   *
   * Backed by Redis when configured, so the counter survives a restart and is
   * shared across PM2/container instances — an in-process Map is trivially
   * defeated by either. The Map remains as a single-instance fallback; it is
   * swept on write so attacker-supplied emails cannot grow it without bound.
   */
  private loginAttempts = new Map<string, { count: number; lockedUntil: number; seenAt: number }>();
  private readonly MAX_LOGIN_ATTEMPTS = 5;
  private readonly LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
  private readonly ATTEMPT_WINDOW_MS = 60 * 60 * 1000; // forget stale counters after 1h
  private readonly MAX_TRACKED_EMAILS = 10_000;

  private attemptKey(email: string): string {
    return `login_attempts:${email.toLowerCase()}`;
  }

  private sweepLoginAttempts(): void {
    const now = Date.now();
    for (const [key, rec] of this.loginAttempts) {
      if (rec.lockedUntil <= now && now - rec.seenAt > this.ATTEMPT_WINDOW_MS) {
        this.loginAttempts.delete(key);
      }
    }
    if (this.loginAttempts.size > this.MAX_TRACKED_EMAILS) {
      const oldest = [...this.loginAttempts.entries()]
        .sort((a, b) => a[1].seenAt - b[1].seenAt)
        .slice(0, this.loginAttempts.size - this.MAX_TRACKED_EMAILS);
      for (const [key] of oldest) this.loginAttempts.delete(key);
    }
  }

  private async checkLockout(email: string): Promise<void> {
    const key = this.attemptKey(email);
    const redis = getRedis();

    if (redis) {
      try {
        const lockedUntil = await redis.get(`${key}:locked`);
        if (lockedUntil && Number(lockedUntil) > Date.now()) {
          const remainingMin = Math.ceil((Number(lockedUntil) - Date.now()) / 60_000);
          throw new AuthError(`Account temporarily locked. Try again in ${remainingMin} minute(s).`, 429);
        }
        return;
      } catch (err) {
        if (err instanceof AuthError) throw err;
        // Redis unreachable — fall through to the in-process counter
      }
    }

    const record = this.loginAttempts.get(key);
    if (record && record.lockedUntil > Date.now()) {
      const remainingMin = Math.ceil((record.lockedUntil - Date.now()) / 60_000);
      throw new AuthError(`Account temporarily locked. Try again in ${remainingMin} minute(s).`, 429);
    }
    if (record && record.lockedUntil <= Date.now()) {
      this.loginAttempts.delete(key);
    }
  }

  private async recordFailedAttempt(email: string): Promise<void> {
    const key = this.attemptKey(email);
    const redis = getRedis();

    if (redis) {
      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.pexpire(key, this.ATTEMPT_WINDOW_MS);
        }
        if (count >= this.MAX_LOGIN_ATTEMPTS) {
          const until = Date.now() + this.LOCKOUT_DURATION_MS;
          await redis.set(`${key}:locked`, String(until), 'PX', this.LOCKOUT_DURATION_MS);
          console.warn(`[SECURITY] Account locked for ${email} after ${count} failed attempts`);
        }
        return;
      } catch {
        // Redis unreachable — fall through to the in-process counter
      }
    }

    this.sweepLoginAttempts();
    const record = this.loginAttempts.get(key) ?? { count: 0, lockedUntil: 0, seenAt: Date.now() };
    record.count += 1;
    record.seenAt = Date.now();
    if (record.count >= this.MAX_LOGIN_ATTEMPTS) {
      record.lockedUntil = Date.now() + this.LOCKOUT_DURATION_MS;
      console.warn(`[SECURITY] Account locked for ${email} after ${record.count} failed attempts`);
    }
    this.loginAttempts.set(key, record);
  }

  private async clearFailedAttempts(email: string): Promise<void> {
    const key = this.attemptKey(email);
    const redis = getRedis();
    if (redis) {
      try {
        await redis.del(key, `${key}:locked`);
      } catch { /* fall through */ }
    }
    this.loginAttempts.delete(key);
  }

  async login(input: LoginInput): Promise<{ user: UserProfile; userId: string }> {
    await this.checkLockout(input.email);

    const user = await this.prisma.user.findUnique({ where: { email: input.email } });
    if (!user) {
      await this.recordFailedAttempt(input.email);
      throw new AuthError('Invalid email or password', 401);
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      await this.recordFailedAttempt(input.email);
      throw new AuthError('Invalid email or password', 401);
    }

    // Checked only after the password verifies — reporting "deactivated" to an
    // unauthenticated caller would confirm which emails have accounts.
    if (user.status === 'PENDING') {
      throw new AuthError("Your account is waiting for the administrator's approval. You can sign in once it is approved.", 403);
    }
    if (user.status === 'BLOCKED') {
      throw new AuthError('This account has been blocked by the administrator.', 403);
    }
    if (!user.isActive) {
      throw new AuthError('Account is deactivated', 403);
    }

    await this.clearFailedAttempts(input.email);

    return { user: toProfile(user), userId: user.id };
  }

  // ── Password reset by email ──────────────────────────────────────────

  /**
   * Start a reset. Always completes the same way whether or not the address has
   * an account, and the email is sent in the background, so neither the answer
   * nor the response time tells a caller which emails are registered.
   */
  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } })
      ?? (email !== email.toLowerCase()
        ? await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } })
        : null);
    if (!user || !user.isActive) return;

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.prisma.passwordResetToken.count({ where: { userId: user.id, createdAt: { gt: since } } });
    if (recent >= RESET_MAX_PER_HOUR) return;

    // A new link supersedes any earlier unused one.
    const now = new Date();
    await this.prisma.passwordResetToken.updateMany({ where: { userId: user.id, usedAt: null }, data: { usedAt: now } });

    const token = randomBytes(32).toString('base64url');
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256Hex(token), expiresAt: new Date(now.getTime() + RESET_TTL_MS) },
    });

    const link = `${appBaseUrl()}/reset-password?token=${token}`;
    void sendMail({
      to: user.email,
      subject: 'Reset your PaperPort password',
      text:
        `Hi ${user.fullName},\n\nSomeone asked to reset the password for your PaperPort account.\n` +
        `To choose a new password, open this link within ${RESET_TTL_MS / 60000} minutes:\n\n${link}\n\n` +
        `If it wasn't you, ignore this email — your password stays the same.\n`,
      html:
        `<p>Hi ${escapeHtml(user.fullName)},</p>` +
        `<p>Someone asked to reset the password for your PaperPort account.</p>` +
        `<p><a href="${link}">Choose a new password</a> — the link works for ${RESET_TTL_MS / 60000} minutes, once.</p>` +
        `<p>If it wasn't you, ignore this email. Your password stays the same.</p>`,
    }).then((sent) => {
      // Without SMTP a developer still needs the link; never print it in production.
      if (!sent && env.NODE_ENV !== 'production') console.log(`[Password reset] link for ${user.email}: ${link}`);
    });
  }

  /** Finish a reset: one use, before expiry; ends every existing session. */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    if (newPassword.length < 8) throw new AuthError('Password must be at least 8 characters', 400);

    const invalid = new AuthError('This reset link is invalid or has expired. Please request a new one.', 400);
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    if (!row || row.usedAt || row.expiresAt <= new Date() || !row.user.isActive) throw invalid;

    // Claim the token first, so two submissions of the same link cannot both win.
    const now = new Date();
    const claimed = await this.prisma.passwordResetToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: now },
    });
    if (claimed.count !== 1) throw invalid;

    await this.prisma.user.update({
      where: { id: row.userId },
      data: { passwordHash: await bcrypt.hash(newPassword, SALT_ROUNDS), passwordChangedAt: now },
    });
    notePasswordChanged(row.userId, now);
    await this.clearFailedAttempts(row.user.email);

    void sendMail({
      to: row.user.email,
      subject: 'Your PaperPort password was changed',
      text:
        `Hi ${row.user.fullName},\n\nThe password for your PaperPort account was just changed, and every ` +
        `device that was signed in has been signed out.\n\nIf this wasn't you, reset it again now and ` +
        `check who has access to this email account.\n`,
    });
  }

  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AuthError('User not found', 404);
    }
    return toProfile(user);
  }

  async updateProfile(
    userId: string,
    data: Partial<Pick<User, 'fullName' | 'riskAppetite' | 'virtualCapital'>>,
  ): Promise<UserProfile> {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data,
    });
    return toProfile(user);
  }

  async saveBreezeCredentials(userId: string, input: BreezeCredentialInput): Promise<{ configured: boolean; updatedAt: Date }> {
    const existing = await this.prisma.breezeCredential.findUnique({ where: { userId } });

    const encryptedApiKey = input.apiKey ? encrypt(input.apiKey, this.encKey) : undefined;
    const encryptedSecret = input.secretKey ? encrypt(input.secretKey, this.encKey) : undefined;
    const encSession = input.sessionToken ? encrypt(input.sessionToken, this.encKey) : undefined;

    if (!existing && (!encryptedApiKey || !encryptedSecret)) {
      throw new AuthError('API Key and Secret Key are required for first-time setup.', 400);
    }

    const updateData: Record<string, unknown> = {};
    if (encryptedApiKey) updateData.encryptedApiKey = encryptedApiKey;
    if (encryptedSecret) updateData.encryptedSecret = encryptedSecret;
    if (encSession) {
      updateData.sessionToken = encSession;
      updateData.sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    }

    const credential = await this.prisma.breezeCredential.upsert({
      where: { userId },
      create: {
        userId,
        encryptedApiKey: encryptedApiKey!,
        encryptedSecret: encryptedSecret!,
        sessionToken: encSession ?? null,
        sessionExpiresAt: encSession ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
      },
      update: updateData,
    });

    return { configured: true, updatedAt: credential.updatedAt };
  }

  async saveSessionToken(userId: string, apiSession: string): Promise<{ success: boolean }> {
    const credential = await this.prisma.breezeCredential.findUnique({ where: { userId } });
    if (!credential) {
      throw new AuthError('Breeze credentials not configured. Save API key and secret first.', 400);
    }

    const apiKey = decrypt(credential.encryptedApiKey, this.encKey);
    const secretKey = decrypt(credential.encryptedSecret, this.encKey);

    // Send the raw API session token to the Python Breeze Bridge.
    // The bridge calls generate_session() which exchanges the single-use token.
    // If the bridge succeeds, it returns the exchanged session_key for us to store.
    let bridgeConsumedToken = false;
    let realSessionToken = apiSession;
    const bridgeUrl = env.BREEZE_BRIDGE_URL.replace(/\/$/, '');
    try {
      const bridgeBody = JSON.stringify({ api_key: apiKey, api_secret: secretKey, session_token: apiSession });
      console.log(`[Breeze Bridge] Attempting init at ${bridgeUrl}/init`);
      const bridgeRes = await fetch(`${bridgeUrl}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bridgeBody,
        signal: AbortSignal.timeout(30_000),
      });
      const bridgeResult = await bridgeRes.json() as { success: boolean; error?: string; session_key?: string };
      console.log(`[Breeze Bridge] Init result: ${JSON.stringify(bridgeResult)}`);
      bridgeConsumedToken = bridgeResult.success === true;
      if (bridgeConsumedToken && bridgeResult.session_key) {
        realSessionToken = bridgeResult.session_key;
        console.log(`[Breeze] Using session_key from bridge (length: ${realSessionToken.length})`);
      }
    } catch (err) {
      console.log(`[Breeze Bridge] Init failed: ${err instanceof Error ? err.message : err}`);
    }

    // Fall back to exchanging the token via ICICI CustomerDetails API
    if (!bridgeConsumedToken) {
      console.log(`[Breeze] Bridge init failed, falling back to CustomerDetails exchange`);
      try {
        const exchangeBody = JSON.stringify({ SessionToken: apiSession, AppKey: apiKey });
        const exchangeResult = await new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = https.request({
            hostname: 'api.icicidirect.com',
            path: '/breezeapi/api/v1/customerdetails',
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': String(Buffer.byteLength(exchangeBody)),
            },
          }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
          });
          req.on('error', reject);
          req.setTimeout(20_000, () => req.destroy(new Error('Timeout')));
          req.write(exchangeBody);
          req.end();
        });

        const data = JSON.parse(exchangeResult.body);
        console.log(`[Breeze] CustomerDetails response HTTP=${exchangeResult.status}, apiStatus=${data?.Status}`);
        if (data?.Success?.session_token) {
          realSessionToken = data.Success.session_token;
          console.log(`[Breeze] Session token exchanged successfully (length: ${realSessionToken.length})`);
        }
      } catch (err: any) {
        console.log(`[Breeze] CustomerDetails exchange failed: ${err.message} — storing raw token`);
      }
    }

    await this.prisma.breezeCredential.update({
      where: { userId },
      data: {
        sessionToken: encrypt(realSessionToken, this.encKey),
        sessionExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    return { success: true };
  }

  async getBreezeCredentialStatus(userId: string): Promise<{
    configured: boolean;
    hasTotp: boolean;
    hasSession: boolean;
    hasLoginCredentials: boolean;
    canAutoLogin: boolean;
    sessionExpiry: string | null;
    lastAutoLoginAt: string | null;
    autoLoginError: string | null;
    updatedAt: string | null;
  }> {
    const credential = await this.prisma.breezeCredential.findUnique({ where: { userId } });
    if (!credential) {
      return {
        configured: false, hasTotp: false, hasSession: false,
        hasLoginCredentials: false, canAutoLogin: false,
        sessionExpiry: null, lastAutoLoginAt: null, autoLoginError: null, updatedAt: null,
      };
    }
    const hasSession = !!credential.sessionToken && (
      !credential.sessionExpiresAt || credential.sessionExpiresAt > new Date()
    );
    const hasLoginCredentials = (!!env.BREEZE_LOGIN_ID && !!env.BREEZE_LOGIN_PASSWORD)
      || (!!credential.encryptedLoginId && !!credential.encryptedLoginPassword);
    const hasTotp = !!env.BREEZE_TOTP_SECRET || !!credential.totpSecret;
    const canAutoLogin = hasLoginCredentials && hasTotp;
    return {
      configured: true,
      hasTotp,
      hasSession,
      hasLoginCredentials,
      canAutoLogin,
      sessionExpiry: credential.sessionExpiresAt?.toISOString() ?? null,
      lastAutoLoginAt: credential.lastAutoLoginAt?.toISOString() ?? null,
      autoLoginError: credential.autoLoginError ?? null,
      updatedAt: credential.updatedAt.toISOString(),
    };
  }

  async deleteBreezeCredentials(userId: string): Promise<void> {
    await this.prisma.breezeCredential.deleteMany({ where: { userId } });
  }

  async getDecryptedBreezeCredentials(userId: string): Promise<{ apiKey: string; secretKey: string; sessionToken: string | null } | null> {
    const credential = await this.prisma.breezeCredential.findUnique({ where: { userId } });
    if (!credential) return null;
    const hasValidSession = !!credential.sessionToken && (
      !credential.sessionExpiresAt || credential.sessionExpiresAt > new Date()
    );
    let sessionToken: string | null = null;
    if (hasValidSession && credential.sessionToken) {
      try {
        sessionToken = decrypt(credential.sessionToken, this.encKey);
      } catch (err) {
        // Never fall back to the raw ciphertext — that ships garbage to the
        // broker and hides key-rotation or corruption problems.
        console.error(`[Breeze] Session token decrypt failed for user ${userId}: ${(err as Error).message}`);
        sessionToken = null;
      }
    }
    return {
      apiKey: decrypt(credential.encryptedApiKey, this.encKey),
      secretKey: decrypt(credential.encryptedSecret, this.encKey),
      sessionToken,
    };
  }

  async createBreezeLoginUrl(userId: string, state?: string): Promise<{ loginUrl: string; callbackUrl: string }> {
    const credential = await this.prisma.breezeCredential.findUnique({ where: { userId } });
    if (!credential) {
      throw new AuthError('Breeze credentials not configured. Save API key and secret first.', 400);
    }
    const apiKey = decrypt(credential.encryptedApiKey, this.encKey);
    const callbackUrl = process.env.BREEZE_CALLBACK_URL
      || (env.NODE_ENV === 'production'
        ? `https://${process.env.RENDER_EXTERNAL_HOSTNAME || 'paper-port.onrender.com'}/api/auth/breeze-callback`
        : `http://localhost:${env.PORT}/api/auth/breeze-callback`);
    const url = new URL('https://api.icicidirect.com/apiuser/login');
    url.searchParams.set('api_key', apiKey);
    url.searchParams.set('redirect_url', callbackUrl);
    if (state) {
      url.searchParams.set('state', state);
    }
    return { loginUrl: url.toString(), callbackUrl };
  }

  async autoGenerateSession(userId: string): Promise<{ success: boolean; sessionExpiry: string; method: string }> {
    const credential = await this.prisma.breezeCredential.findUnique({ where: { userId } });
    if (!credential) {
      throw new AuthError('Breeze credentials not configured. Save API key and secret first.', 400);
    }
    // server/.env is the place for these now (see config.ts). Values saved in the
    // database by older versions are still honoured until they are cleared.
    if (!credential.totpSecret && !env.BREEZE_TOTP_SECRET) {
      throw new AuthError('TOTP secret not configured. Set BREEZE_TOTP_SECRET in server/.env on the server.', 400);
    }

    const apiKey = decrypt(credential.encryptedApiKey, this.encKey);
    const secretKey = decrypt(credential.encryptedSecret, this.encKey);
    let rawTotp: string;
    try {
      rawTotp = env.BREEZE_TOTP_SECRET || decrypt(credential.totpSecret!, this.encKey);
    } catch (err) {
      throw new AuthError(
        `Stored TOTP secret could not be decrypted (${(err as Error).message}). ` +
        'Set BREEZE_TOTP_SECRET in server/.env instead — this usually means ENCRYPTION_KEY changed.',
        500,
      );
    }

    let loginId: string | null = env.BREEZE_LOGIN_ID || null;
    let loginPassword: string | null = env.BREEZE_LOGIN_PASSWORD || null;
    if (!(loginId && loginPassword) && credential.encryptedLoginId && credential.encryptedLoginPassword) {
      try {
        loginId = decrypt(credential.encryptedLoginId, this.encKey);
        loginPassword = decrypt(credential.encryptedLoginPassword, this.encKey);
      } catch (err) {
        // Leave both null so we fall through to the direct-API strategy rather
        // than POSTing undecryptable bytes to ICICI as a password.
        loginId = null;
        loginPassword = null;
        console.error(`[Breeze] Login credential decrypt failed for user ${userId}: ${(err as Error).message}`);
      }
    }

    let sessionToken: string | null = null;
    let method = 'unknown';

    const errors: string[] = [];

    // Strategy 1: Full browser-flow simulation (login page → credentials → TOTP → session)
    if (loginId && loginPassword) {
      try {
        sessionToken = await this.browserFlowLogin(apiKey, loginId, loginPassword, rawTotp);
        if (sessionToken) method = 'browser_flow';
      } catch (err) {
        const msg = (err as Error).message;
        console.error('[Breeze Auto-Login] Browser flow failed:', msg);
        errors.push(`Browser flow: ${msg}`);
      }
    } else {
      errors.push('Browser flow: Login ID or Password not provided');
    }

    // Strategy 2: Direct /tradelogin API call (works on some accounts)
    if (!sessionToken) {
      try {
        const totp = this.generateTotpCode(rawTotp);
        const timeStamp = new Date().toISOString();
        const checksum = createHash('sha256').update(`${apiKey}${timeStamp}${secretKey}`).digest('hex');
        sessionToken = await this.directTradeLogin({ apiKey, secretKey, timeStamp, checksum, totp });
        if (sessionToken) method = 'direct_api';
        else errors.push('Direct API: No session token in response');
      } catch (err) {
        const msg = (err as Error).message;
        console.error('[Breeze Auto-Login] Direct API failed:', msg);
        errors.push(`Direct API: ${msg}`);
      }
    }

    // Record the attempt
    const errorMsg = sessionToken ? null : `Failed: ${errors.join(' | ')}`;
    await this.prisma.breezeCredential.update({
      where: { userId },
      data: {
        lastAutoLoginAt: new Date(),
        autoLoginError: errorMsg,
      },
    });

    if (!sessionToken) {
      throw new AuthError(
        `Auto session failed. ${errors.join(' | ')}. Use "Generate Session Popup" fallback.`,
        502,
      );
    }

    await this.saveSessionToken(userId, sessionToken);
    return {
      success: true,
      method,
      sessionExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    };
  }

  async renewExpiringSessions(): Promise<{ attempted: number; refreshed: number; errors: string[] }> {
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const credentials = await this.prisma.breezeCredential.findMany({
      where: {
        ...(env.BREEZE_TOTP_SECRET ? {} : { totpSecret: { not: null } }),
        OR: [
          { sessionExpiresAt: null },
          { sessionExpiresAt: { lte: soon } },
        ],
      },
      select: { userId: true },
    });

    let refreshed = 0;
    const errors: string[] = [];
    for (const row of credentials) {
      try {
        const result = await this.autoGenerateSession(row.userId);
        if (result.success) refreshed += 1;
        console.log(`[Breeze Auto-Renew] User ${row.userId}: success via ${result.method}`);
      } catch (err) {
        const msg = `User ${row.userId}: ${(err as Error).message}`;
        errors.push(msg);
        console.error(`[Breeze Auto-Renew] ${msg}`);
      }
    }

    return { attempted: credentials.length, refreshed, errors };
  }

  private generateTotpCode(rawSecret: string): string {
    const normalized = rawSecret.replace(/\s+/g, '').replace(/-/g, '').toUpperCase();
    const totp = new OTPAuth.TOTP({
      issuer: 'ICICI',
      label: 'CapitalGuard',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(normalized),
    });
    return totp.generate();
  }

  /**
   * Wait for the current TOTP window to be fresh (at least 5s remaining)
   * to avoid submitting a code that expires mid-request.
   */
  private async waitForFreshTotp(): Promise<void> {
    const secondsInWindow = Math.floor(Date.now() / 1000) % 30;
    const remaining = 30 - secondsInWindow;
    if (remaining < 5) {
      await new Promise(r => setTimeout(r, (remaining + 1) * 1000));
    }
  }

  /**
   * Strategy 1: Full browser-flow simulation.
   * Replicates what happens when a user logs in via the ICICI Breeze login page:
   *  1. GET login page → extract form fields, cookies, form action
   *  2. POST credentials → get TOTP/2FA page
   *  3. POST TOTP → follow redirect to get apisession
   *  4. Exchange apisession via CustomerDetails API
   */
  private async browserFlowLogin(
    apiKey: string,
    loginId: string,
    loginPassword: string,
    totpRawSecret: string,
  ): Promise<string | null> {
    const loginPageUrl = `https://api.icicidirect.com/apiuser/login?api_key=${encodeURIComponent(apiKey)}`;
    console.log('[Breeze Auto-Login] Step 1: Loading login page...');

    // Step 1: GET the login page
    const page1 = await httpRequest(loginPageUrl, { method: 'GET', timeoutMs: 15_000 });
    const cookies = this.extractCookies(page1.headers);
    const formAction1 = this.extractFormAction(page1.body) || 'https://api.icicidirect.com/apiuser/login';

    // Extract any hidden fields (CSRF, ViewState, etc.)
    const hiddenFields = this.extractHiddenFields(page1.body);

    // Step 2: POST credentials
    console.log('[Breeze Auto-Login] Step 2: Submitting credentials...');
    const credBody = new URLSearchParams({
      ...hiddenFields,
      userid: loginId,
      user_id: loginId,
      password: loginPassword,
      passwd: loginPassword,
    });

    const page2 = await httpRequest(formAction1, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookies,
        Referer: loginPageUrl,
      },
      body: credBody.toString(),
      timeoutMs: 15_000,
    });

    // Check if we got a redirect with session already (some flows skip TOTP)
    const sessionFromStep2 = this.extractSessionFromText(page2.location ?? '') ||
                              this.extractSessionFromText(page2.body);
    if (sessionFromStep2) {
      console.log('[Breeze Auto-Login] Session obtained after credentials (no TOTP needed)');
      return sessionFromStep2;
    }

    // Merge cookies from both responses
    const cookies2 = this.mergeCookies(cookies, this.extractCookies(page2.headers));
    const formAction2 = this.extractFormAction(page2.body) || formAction1;
    const hiddenFields2 = this.extractHiddenFields(page2.body);

    // Step 3: Generate and submit TOTP
    await this.waitForFreshTotp();
    const totpCode = this.generateTotpCode(totpRawSecret);
    console.log(`[Breeze Auto-Login] Step 3: Submitting TOTP (${totpCode.substring(0, 2)}****)...`);

    const totpBody = new URLSearchParams({
      ...hiddenFields2,
      otp: totpCode,
      totp: totpCode,
      OTP: totpCode,
    });

    const page3 = await httpRequest(formAction2, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: cookies2,
        Referer: formAction1,
      },
      body: totpBody.toString(),
      timeoutMs: 15_000,
    });

    // Check redirect location and body for session token
    let apiSession = this.extractSessionFromText(page3.location ?? '') ||
                     this.extractSessionFromText(page3.body);

    // Follow redirects manually (up to 5 hops)
    if (!apiSession && page3.location && (page3.status === 301 || page3.status === 302 || page3.status === 303)) {
      let redirectUrl = page3.location;
      for (let hop = 0; hop < 5 && redirectUrl && !apiSession; hop++) {
        if (!redirectUrl.startsWith('http')) {
          redirectUrl = new URL(redirectUrl, 'https://api.icicidirect.com').toString();
        }
        apiSession = this.extractSessionFromText(redirectUrl);
        if (apiSession) break;

        const rPage = await httpRequest(redirectUrl, {
          method: 'GET',
          headers: { Cookie: cookies2 },
          timeoutMs: 10_000,
        });
        apiSession = this.extractSessionFromText(rPage.location ?? '') ||
                     this.extractSessionFromText(rPage.body);
        redirectUrl = rPage.location ?? '';
      }
    }

    if (!apiSession) {
      const bodySnippet = page3.body.substring(0, 500);
      console.error(`[Breeze Auto-Login] No session after TOTP. Status: ${page3.status}, Location: ${page3.location || 'none'}, Body preview: ${bodySnippet}`);
      throw new Error(`TOTP submitted but no session returned (HTTP ${page3.status}). ICICI may require CAPTCHA or has changed login flow.`);
    }

    console.log('[Breeze Auto-Login] Got apisession, exchanging for session_token...');
    return apiSession;
  }

  /**
   * Strategy 2: Direct POST to /apiuser/tradelogin (works for some accounts).
   */
  private async directTradeLogin(input: {
    apiKey: string;
    secretKey: string;
    timeStamp: string;
    checksum: string;
    totp: string;
  }): Promise<string | null> {
    const payloads = [
      {
        body: new URLSearchParams({
          api_key: input.apiKey,
          secret_key: input.secretKey,
          timestamp: input.timeStamp,
          checksum: input.checksum,
          totp: input.totp,
        }).toString(),
        contentType: 'application/x-www-form-urlencoded',
      },
      {
        body: JSON.stringify({
          AppKey: input.apiKey,
          SecretKey: input.secretKey,
          TimeStamp: input.timeStamp,
          Checksum: input.checksum,
          Totp: input.totp,
        }),
        contentType: 'application/json',
      },
    ];

    for (const payload of payloads) {
      try {
        const res = await httpRequest('https://api.icicidirect.com/apiuser/tradelogin', {
          method: 'POST',
          headers: {
            'Content-Type': payload.contentType,
            Accept: 'application/json,text/plain,text/html',
          },
          body: payload.body,
          timeoutMs: 10_000,
        });

        const token = this.extractSessionFromText(res.location ?? '') ||
                       this.extractSessionFromText(res.body);
        if (token) return token;
      } catch {
        // try next payload format
      }
    }
    return null;
  }

  private extractSessionFromText(text: string): string | null {
    if (!text) return null;
    const patterns = [
      /apisession=([A-Za-z0-9._%-]+)/i,
      /api_session=([A-Za-z0-9._%-]+)/i,
      /API_Session=([A-Za-z0-9._%-]+)/i,
      /session_token=([A-Za-z0-9._%-]+)/i,
      /"apisession"\s*:\s*"([^"]+)"/i,
      /"api_session"\s*:\s*"([^"]+)"/i,
      /"session_token"\s*:\s*"([^"]+)"/i,
    ];
    for (const p of patterns) {
      const match = text.match(p);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    return null;
  }

  private extractCookies(headers: Record<string, string>): string {
    const setCookie = headers['set-cookie'] ?? '';
    const cookies: string[] = [];
    for (const part of setCookie.split(/,(?=[A-Za-z])/)) {
      const name_val = part.split(';')[0]?.trim();
      if (name_val && name_val.includes('=')) {
        cookies.push(name_val);
      }
    }
    return cookies.join('; ');
  }

  private mergeCookies(existing: string, incoming: string): string {
    const map = new Map<string, string>();
    for (const c of [...existing.split('; '), ...incoming.split('; ')]) {
      const [name] = c.split('=', 1);
      if (name?.trim()) map.set(name.trim(), c);
    }
    return [...map.values()].join('; ');
  }

  private extractFormAction(html: string): string | null {
    const match = html.match(/<form[^>]*action\s*=\s*["']([^"']+)["']/i);
    if (match?.[1]) {
      const action = match[1];
      if (action.startsWith('http')) return action;
      return `https://api.icicidirect.com${action.startsWith('/') ? '' : '/'}${action}`;
    }
    return null;
  }

  private extractHiddenFields(html: string): Record<string, string> {
    const fields: Record<string, string> = {};
    const regex = /<input[^>]*type\s*=\s*["']hidden["'][^>]*>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const nameMatch = match[0].match(/name\s*=\s*["']([^"']+)["']/i);
      const valueMatch = match[0].match(/value\s*=\s*["']([^"']*?)["']/i);
      if (nameMatch?.[1]) {
        fields[nameMatch[1]] = valueMatch?.[1] ?? '';
      }
    }
    return fields;
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
