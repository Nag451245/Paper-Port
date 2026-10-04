import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService, AuthError } from '../services/auth.service.js';
import { AdminService } from '../services/admin.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { createBreezeState, consumeBreezeState } from '../lib/oauth-state.js';
import { env } from '../config.js';
import { appBaseUrl } from '../lib/app-url.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: z.string().min(1, 'Full name is required'),
  riskAppetite: z.enum(['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE']).optional(),
  virtualCapital: z.number().positive().max(1_00_00_000).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const updateProfileSchema = z.object({
  fullName: z.string().min(1).optional(),
  riskAppetite: z.enum(['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE']).optional(),
  virtualCapital: z.number().positive().max(1_00_00_000).optional(),
});

// The ICICI login ID, password and TOTP secret are deliberately NOT accepted
// here; they are server configuration (BREEZE_LOGIN_ID etc. in server/.env).
// Unknown keys are stripped, so an old client that still sends them is ignored.
const breezeCredentialSchema = z.object({
  api_key: z.string().optional(),
  secret_key: z.string().optional(),
  session_token: z.string().optional(),
});

const sessionTokenSchema = z.object({
  session_token: z.string().min(1, 'Session token is required'),
});

const breezeCallbackQuerySchema = z.object({
  state: z.string().optional(),
  api_session: z.string().optional(),
  session_token: z.string().optional(),
  apisession: z.string().optional(),
  API_Session: z.string().optional(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

const AUTH_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const authService = new AuthService(getPrisma(), env.JWT_SECRET);

  app.post('/register', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const { user, userId, pending } = await authService.register(parsed.data);
      if (pending) {
        // No sign-in until the administrator approves the account.
        new AdminService(getPrisma()).notifyNewSignup(user).catch(() => {});
        return reply.code(202).send({
          pending: true,
          message: "Thanks for signing up. Your account is waiting for the administrator's approval; you can sign in once it is approved.",
        });
      }
      const token = app.jwt.sign({ sub: userId });
      return reply.code(201).send({ user, access_token: token, token_type: 'bearer' });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/login', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const { user, userId } = await authService.login(parsed.data);
      const token = app.jwt.sign({ sub: userId });
      return reply.code(200).send({ user, access_token: token, token_type: 'bearer' });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  // Tighter than sign-in: each accepted request can send an email.
  const RESET_RATE_LIMIT = { max: 10, timeWindow: '15 minutes' };

  app.post('/forgot-password', { config: { rateLimit: RESET_RATE_LIMIT } }, async (request, reply) => {
    const parsed = forgotPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    await authService.requestPasswordReset(parsed.data.email);
    // The same answer whether or not the address has an account.
    return reply.code(200).send({
      message: 'If an account exists for that email, a password reset link is on its way. It works for 30 minutes.',
    });
  });

  app.post('/reset-password', { config: { rateLimit: RESET_RATE_LIMIT } }, async (request, reply) => {
    const parsed = resetPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    try {
      await authService.resetPassword(parsed.data.token, parsed.data.password);
      return reply.code(200).send({ message: 'Password changed. Please sign in with your new password.' });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/logout', async (_request, reply) => {
    return reply.code(200).send({ message: 'Logged out successfully' });
  });

  app.get('/me', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const profile = await authService.getProfile(userId);
      return reply.send(profile);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.put('/me', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = updateProfileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const profile = await authService.updateProfile(userId, parsed.data as any);
      return reply.send(profile);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/breeze-credentials', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = breezeCredentialSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const result = await authService.saveBreezeCredentials(userId, {
        apiKey: parsed.data.api_key || '',
        secretKey: parsed.data.secret_key || '',
        sessionToken: parsed.data.session_token,
      });
      return reply.send({
        configured: result.configured,
        has_session: !!parsed.data.session_token,
        updated_at: result.updatedAt.toISOString(),
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.delete('/breeze-credentials', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      await authService.deleteBreezeCredentials(userId);
      return reply.send({ success: true });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/breeze-credentials/status', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const status = await authService.getBreezeCredentialStatus(userId);

      return reply.send({
        configured: status.configured,
        has_totp: status.hasTotp,
        has_session: status.hasSession,
        has_login_credentials: status.hasLoginCredentials,
        can_auto_login: status.canAutoLogin,
        session_expiry: status.sessionExpiry,
        last_auto_login_at: status.lastAutoLoginAt,
        auto_login_error: status.autoLoginError,
        updated_at: status.updatedAt,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/breeze-session', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = sessionTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const result = await authService.saveSessionToken(userId, parsed.data.session_token);
      return reply.send(result);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/breeze-session/auto', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      const result = await authService.autoGenerateSession(userId);
      return reply.send(result);
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/breeze-session/login-url', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      const userId = getUserId(request);
      // Opaque single-use nonce, NOT a JWT — this value is handed to ICICI and
      // ends up in their logs, browser history and Referer headers.
      const state = await createBreezeState(userId);
      const payload = await authService.createBreezeLoginUrl(userId, state);
      return reply.send({
        login_url: payload.loginUrl,
        callback_url: payload.callbackUrl,
      });
    } catch (err) {
      if (err instanceof AuthError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  const TOKEN_PATTERN = /^[a-zA-Z0-9_\-]{8,256}$/;

  const handleBreezeCallback = async (request: any, reply: any) => {
    const queryParams = breezeCallbackQuerySchema.safeParse(request.query);
    const bodyParams = breezeCallbackQuerySchema.safeParse(request.body ?? {});
    const params = queryParams.success ? queryParams.data : bodyParams.success ? bodyParams.data : null;

    if (!params) {
      return reply.code(400).type('text/html').send('<html><body><h3>Invalid callback</h3></body></html>');
    }

    const token =
      params.api_session ??
      params.session_token ??
      params.apisession ??
      params.API_Session;

    if (!token) {
      return reply.code(400).type('text/html').send('<html><body><h3>Missing session token</h3></body></html>');
    }

    if (!TOKEN_PATTERN.test(token)) {
      return reply.code(400).type('text/html').send('<html><body><h3>Invalid session token format</h3></body></html>');
    }

    // Back to the Settings page, which shows the result. (An inline-script page
    // here never ran: the site's security policy blocks inline scripts, and
    // after ICICI's pages the popup has no link back to the window that opened it.)
    const back = new URL(`${appBaseUrl()}/settings`);
    const state = params.state;
    let saved = false;
    if (state) {
      try {
        const stateUserId = await consumeBreezeState(state);
        if (stateUserId) {
          await authService.saveSessionToken(stateUserId, token);
          saved = true;
        }
      } catch {
        // state lookup failed; the signed-in Settings page saves it instead
      }
    }
    // ICICI does not pass `state` back, so usually the Settings page (signed in,
    // same browser) saves the token. It is our own site and the URL is cleaned at once.
    if (saved) back.searchParams.set('breeze', 'saved');
    else back.searchParams.set('breeze_session', token);
    return reply.redirect(back.toString());
  };

  app.get('/breeze-callback', handleBreezeCallback);
  app.post('/breeze-callback', handleBreezeCallback);
}
