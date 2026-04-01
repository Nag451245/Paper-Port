import bcrypt from 'bcryptjs';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import https from 'https';
import * as OTPAuth from 'otpauth';
import { env } from '../config.js';
const SALT_ROUNDS = 12;
function httpsRequestWithBody(options, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.setTimeout(15_000, () => { req.destroy(new Error('Timeout')); });
        if (body)
            req.write(body);
        req.end();
    });
}
/**
 * Make an HTTP(S) request with full control over redirects and cookies.
 * Returns the raw response including headers (for cookie/redirect tracking).
 */
function httpRequest(url, opts = {}) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const reqOpts = {
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
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString();
                const hdrs = {};
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
        if (opts.body)
            req.write(opts.body);
        req.end();
    });
}
function toProfile(user) {
    return {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        riskAppetite: user.riskAppetite,
        virtualCapital: Number(user.virtualCapital),
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
    };
}
function deriveEncryptionKey(secret) {
    return createHash('sha256').update(secret).digest();
}
function encrypt(text, secret) {
    const key = deriveEncryptionKey(secret);
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + encrypted;
}
function decrypt(encryptedText, secret) {
    const key = deriveEncryptionKey(secret);
    const [ivHex, encrypted] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}
export class AuthService {
    prisma;
    jwtSecret;
    encKey;
    constructor(prisma, jwtSecret) {
        this.prisma = prisma;
        this.jwtSecret = jwtSecret;
        this.encKey = env.ENCRYPTION_KEY;
    }
    async register(input) {
        const existing = await this.prisma.user.findUnique({ where: { email: input.email } });
        if (existing) {
            throw new AuthError('Email already registered', 409);
        }
        const passwordHash = await bcrypt.hash(input.password, SALT_ROUNDS);
        const user = await this.prisma.user.create({
            data: {
                email: input.email,
                passwordHash,
                fullName: input.fullName,
                riskAppetite: input.riskAppetite ?? 'MODERATE',
                virtualCapital: input.virtualCapital ?? 1000000,
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
        return { user: toProfile(user), userId: user.id };
    }
    loginAttempts = new Map();
    MAX_LOGIN_ATTEMPTS = 5;
    LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes
    checkLockout(email) {
        const record = this.loginAttempts.get(email);
        if (record && record.lockedUntil > Date.now()) {
            const remainingMs = record.lockedUntil - Date.now();
            const remainingMin = Math.ceil(remainingMs / 60_000);
            throw new AuthError(`Account temporarily locked. Try again in ${remainingMin} minute(s).`, 429);
        }
        if (record && record.lockedUntil <= Date.now()) {
            this.loginAttempts.delete(email);
        }
    }
    recordFailedAttempt(email) {
        const record = this.loginAttempts.get(email) || { count: 0, lockedUntil: 0 };
        record.count += 1;
        if (record.count >= this.MAX_LOGIN_ATTEMPTS) {
            record.lockedUntil = Date.now() + this.LOCKOUT_DURATION_MS;
            console.warn(`[SECURITY] Account locked for ${email} after ${record.count} failed attempts`);
        }
        this.loginAttempts.set(email, record);
    }
    clearFailedAttempts(email) {
        this.loginAttempts.delete(email);
    }
    async login(input) {
        this.checkLockout(input.email);
        const user = await this.prisma.user.findUnique({ where: { email: input.email } });
        if (!user) {
            this.recordFailedAttempt(input.email);
            throw new AuthError('Invalid email or password', 401);
        }
        if (!user.isActive) {
            throw new AuthError('Account is deactivated', 403);
        }
        const valid = await bcrypt.compare(input.password, user.passwordHash);
        if (!valid) {
            this.recordFailedAttempt(input.email);
            throw new AuthError('Invalid email or password', 401);
        }
        this.clearFailedAttempts(input.email);
        return { user: toProfile(user), userId: user.id };
    }
    async getProfile(userId) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) {
            throw new AuthError('User not found', 404);
        }
        return toProfile(user);
    }
    async updateProfile(userId, data) {
        const user = await this.prisma.user.update({
            where: { id: userId },
            data,
        });
        return toProfile(user);
    }
    async saveBreezeCredentials(userId, input) {
        const existing = await this.prisma.breezeCredential.findUnique({ where: { userId } });
        const encryptedApiKey = input.apiKey ? encrypt(input.apiKey, this.encKey) : undefined;
        const encryptedSecret = input.secretKey ? encrypt(input.secretKey, this.encKey) : undefined;
        const encTotp = input.totpSecret ? encrypt(input.totpSecret, this.encKey) : undefined;
        const encSession = input.sessionToken ? encrypt(input.sessionToken, this.encKey) : undefined;
        const encLoginId = input.loginId ? encrypt(input.loginId, this.encKey) : undefined;
        const encLoginPwd = input.loginPassword ? encrypt(input.loginPassword, this.encKey) : undefined;
        if (!existing && (!encryptedApiKey || !encryptedSecret)) {
            throw new AuthError('API Key and Secret Key are required for first-time setup.', 400);
        }
        const updateData = {};
        if (encryptedApiKey)
            updateData.encryptedApiKey = encryptedApiKey;
        if (encryptedSecret)
            updateData.encryptedSecret = encryptedSecret;
        if (encTotp)
            updateData.totpSecret = encTotp;
        if (encSession) {
            updateData.sessionToken = encSession;
            updateData.sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        }
        if (encLoginId)
            updateData.encryptedLoginId = encLoginId;
        if (encLoginPwd)
            updateData.encryptedLoginPassword = encLoginPwd;
        const credential = await this.prisma.breezeCredential.upsert({
            where: { userId },
            create: {
                userId,
                encryptedApiKey: encryptedApiKey,
                encryptedSecret: encryptedSecret,
                totpSecret: encTotp ?? null,
                sessionToken: encSession ?? null,
                sessionExpiresAt: encSession ? new Date(Date.now() + 24 * 60 * 60 * 1000) : null,
                ...(encLoginId ? { encryptedLoginId: encLoginId } : {}),
                ...(encLoginPwd ? { encryptedLoginPassword: encLoginPwd } : {}),
            },
            update: updateData,
        });
        return { configured: true, updatedAt: credential.updatedAt };
    }
    async saveSessionToken(userId, apiSession) {
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
            const bridgeResult = await bridgeRes.json();
            console.log(`[Breeze Bridge] Init result: ${JSON.stringify(bridgeResult)}`);
            bridgeConsumedToken = bridgeResult.success === true;
            if (bridgeConsumedToken && bridgeResult.session_key) {
                realSessionToken = bridgeResult.session_key;
                console.log(`[Breeze] Using session_key from bridge (length: ${realSessionToken.length})`);
            }
        }
        catch (err) {
            console.log(`[Breeze Bridge] Init failed: ${err instanceof Error ? err.message : err}`);
        }
        // Fall back to exchanging the token via ICICI CustomerDetails API
        if (!bridgeConsumedToken) {
            console.log(`[Breeze] Bridge init failed, falling back to CustomerDetails exchange`);
            try {
                const exchangeBody = JSON.stringify({ SessionToken: apiSession, AppKey: apiKey });
                const exchangeResult = await new Promise((resolve, reject) => {
                    const req = https.request({
                        hostname: 'api.icicidirect.com',
                        path: '/breezeapi/api/v1/customerdetails',
                        method: 'GET',
                        headers: {
                            'Content-Type': 'application/json',
                            'Content-Length': String(Buffer.byteLength(exchangeBody)),
                        },
                    }, (res) => {
                        const chunks = [];
                        res.on('data', (c) => chunks.push(c));
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
            }
            catch (err) {
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
    async getBreezeCredentialStatus(userId) {
        const credential = await this.prisma.breezeCredential.findUnique({ where: { userId } });
        if (!credential) {
            return {
                configured: false, hasTotp: false, hasSession: false,
                hasLoginCredentials: false, canAutoLogin: false,
                sessionExpiry: null, lastAutoLoginAt: null, autoLoginError: null, updatedAt: null,
            };
        }
        const hasSession = !!credential.sessionToken && (!credential.sessionExpiresAt || credential.sessionExpiresAt > new Date());
        const hasLoginCredentials = !!credential.encryptedLoginId && !!credential.encryptedLoginPassword;
        const canAutoLogin = hasLoginCredentials && !!credential.totpSecret;
        return {
            configured: true,
            hasTotp: !!credential.totpSecret,
            hasSession,
            hasLoginCredentials,
            canAutoLogin,
            sessionExpiry: credential.sessionExpiresAt?.toISOString() ?? null,
            lastAutoLoginAt: credential.lastAutoLoginAt?.toISOString() ?? null,
            autoLoginError: credential.autoLoginError ?? null,
            updatedAt: credential.updatedAt.toISOString(),
        };
    }
    async deleteBreezeCredentials(userId) {
        await this.prisma.breezeCredential.deleteMany({ where: { userId } });
    }
    async getDecryptedBreezeCredentials(userId) {
        const credential = await this.prisma.breezeCredential.findUnique({ where: { userId } });
        if (!credential)
            return null;
        const hasValidSession = !!credential.sessionToken && (!credential.sessionExpiresAt || credential.sessionExpiresAt > new Date());
        let sessionToken = null;
        if (hasValidSession && credential.sessionToken) {
            try {
                sessionToken = decrypt(credential.sessionToken, this.encKey);
            }
            catch {
                sessionToken = credential.sessionToken;
            }
        }
        return {
            apiKey: decrypt(credential.encryptedApiKey, this.encKey),
            secretKey: decrypt(credential.encryptedSecret, this.encKey),
            sessionToken,
        };
    }
    async createBreezeLoginUrl(userId, state) {
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
    async autoGenerateSession(userId) {
        const credential = await this.prisma.breezeCredential.findUnique({ where: { userId } });
        if (!credential) {
            throw new AuthError('Breeze credentials not configured. Save API key and secret first.', 400);
        }
        if (!credential.totpSecret) {
            throw new AuthError('TOTP secret not configured. Add it in Settings before using auto session.', 400);
        }
        const apiKey = decrypt(credential.encryptedApiKey, this.encKey);
        const secretKey = decrypt(credential.encryptedSecret, this.encKey);
        let rawTotp;
        try {
            rawTotp = decrypt(credential.totpSecret, this.encKey);
        }
        catch {
            rawTotp = credential.totpSecret;
        }
        let loginId = null;
        let loginPassword = null;
        if (credential.encryptedLoginId && credential.encryptedLoginPassword) {
            try {
                loginId = decrypt(credential.encryptedLoginId, this.encKey);
            }
            catch { /* */ }
            try {
                loginPassword = decrypt(credential.encryptedLoginPassword, this.encKey);
            }
            catch { /* */ }
        }
        let sessionToken = null;
        let method = 'unknown';
        const errors = [];
        // Strategy 1: Full browser-flow simulation (login page → credentials → TOTP → session)
        if (loginId && loginPassword) {
            try {
                sessionToken = await this.browserFlowLogin(apiKey, loginId, loginPassword, rawTotp);
                if (sessionToken)
                    method = 'browser_flow';
            }
            catch (err) {
                const msg = err.message;
                console.error('[Breeze Auto-Login] Browser flow failed:', msg);
                errors.push(`Browser flow: ${msg}`);
            }
        }
        else {
            errors.push('Browser flow: Login ID or Password not provided');
        }
        // Strategy 2: Direct /tradelogin API call (works on some accounts)
        if (!sessionToken) {
            try {
                const totp = this.generateTotpCode(rawTotp);
                const timeStamp = new Date().toISOString();
                const checksum = createHash('sha256').update(`${apiKey}${timeStamp}${secretKey}`).digest('hex');
                sessionToken = await this.directTradeLogin({ apiKey, secretKey, timeStamp, checksum, totp });
                if (sessionToken)
                    method = 'direct_api';
                else
                    errors.push('Direct API: No session token in response');
            }
            catch (err) {
                const msg = err.message;
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
            throw new AuthError(`Auto session failed. ${errors.join(' | ')}. Use "Generate Session Popup" fallback.`, 502);
        }
        await this.saveSessionToken(userId, sessionToken);
        return {
            success: true,
            method,
            sessionExpiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        };
    }
    async renewExpiringSessions() {
        const soon = new Date(Date.now() + 2 * 60 * 60 * 1000);
        const credentials = await this.prisma.breezeCredential.findMany({
            where: {
                totpSecret: { not: null },
                OR: [
                    { sessionExpiresAt: null },
                    { sessionExpiresAt: { lte: soon } },
                ],
            },
            select: { userId: true },
        });
        let refreshed = 0;
        const errors = [];
        for (const row of credentials) {
            try {
                const result = await this.autoGenerateSession(row.userId);
                if (result.success)
                    refreshed += 1;
                console.log(`[Breeze Auto-Renew] User ${row.userId}: success via ${result.method}`);
            }
            catch (err) {
                const msg = `User ${row.userId}: ${err.message}`;
                errors.push(msg);
                console.error(`[Breeze Auto-Renew] ${msg}`);
            }
        }
        return { attempted: credentials.length, refreshed, errors };
    }
    generateTotpCode(rawSecret) {
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
    async waitForFreshTotp() {
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
    async browserFlowLogin(apiKey, loginId, loginPassword, totpRawSecret) {
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
                if (apiSession)
                    break;
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
    async directTradeLogin(input) {
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
                if (token)
                    return token;
            }
            catch {
                // try next payload format
            }
        }
        return null;
    }
    extractSessionFromText(text) {
        if (!text)
            return null;
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
            if (match?.[1])
                return decodeURIComponent(match[1]);
        }
        return null;
    }
    extractCookies(headers) {
        const setCookie = headers['set-cookie'] ?? '';
        const cookies = [];
        for (const part of setCookie.split(/,(?=[A-Za-z])/)) {
            const name_val = part.split(';')[0]?.trim();
            if (name_val && name_val.includes('=')) {
                cookies.push(name_val);
            }
        }
        return cookies.join('; ');
    }
    mergeCookies(existing, incoming) {
        const map = new Map();
        for (const c of [...existing.split('; '), ...incoming.split('; ')]) {
            const [name] = c.split('=', 1);
            if (name?.trim())
                map.set(name.trim(), c);
        }
        return [...map.values()].join('; ');
    }
    extractFormAction(html) {
        const match = html.match(/<form[^>]*action\s*=\s*["']([^"']+)["']/i);
        if (match?.[1]) {
            const action = match[1];
            if (action.startsWith('http'))
                return action;
            return `https://api.icicidirect.com${action.startsWith('/') ? '' : '/'}${action}`;
        }
        return null;
    }
    extractHiddenFields(html) {
        const fields = {};
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
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'AuthError';
    }
}
//# sourceMappingURL=auth.service.js.map