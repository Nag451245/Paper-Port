import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AuthService, AuthError } from '../services/auth.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { env } from '../config.js';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  fullName: z.string().min(1, 'Full name is required'),
  riskAppetite: z.enum(['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE']).optional(),
  virtualCapital: z.number().positive().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const updateProfileSchema = z.object({
  fullName: z.string().min(1).optional(),
  riskAppetite: z.enum(['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE']).optional(),
  virtualCapital: z.number().positive().optional(),
});

const breezeCredentialSchema = z.object({
  api_key: z.string().min(1, 'API key is required'),
  secret_key: z.string().min(1, 'Secret key is required'),
  totp_secret: z.string().optional(),
  session_token: z.string().optional(),
  login_id: z.string().optional(),
  login_password: z.string().optional(),
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

const AUTH_RATE_LIMIT = { max: 20, timeWindow: '1 minute' };

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const authService = new AuthService(getPrisma(), env.JWT_SECRET);

  app.post('/register', { config: { rateLimit: AUTH_RATE_LIMIT } }, async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const { user, userId } = await authService.register(parsed.data);
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
        apiKey: parsed.data.api_key,
        secretKey: parsed.data.secret_key,
        totpSecret: parsed.data.totp_secret,
        sessionToken: parsed.data.session_token,
        loginId: parsed.data.login_id,
        loginPassword: parsed.data.login_password,
      });
      return reply.send({
        configured: result.configured,
        has_totp: !!parsed.data.totp_secret,
        has_session: !!parsed.data.session_token,
        has_login_credentials: !!parsed.data.login_id && !!parsed.data.login_password,
        updated_at: result.updatedAt.toISOString(),
      });
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
      const state = app.jwt.sign({ sub: userId, type: 'breeze_session_state' }, { expiresIn: '15m' });
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

    const state = params.state;

    if (state) {
      try {
        const payload = app.jwt.verify<{ sub: string; type?: string }>(state);
        if (payload?.sub && payload.type === 'breeze_session_state') {
          await authService.saveSessionToken(payload.sub, token);
          return reply.type('text/html').send(
            '<html><body><script>window.opener&&window.opener.postMessage({type:"breeze_session_saved"},"*");window.close();</script><h3>Session saved! You can close this tab.</h3></body></html>',
          );
        }
      } catch {
        // state verification failed, fall through to manual save page
      }
    }

    // No state or invalid state — show a page that saves via postMessage to the app
    return reply.type('text/html').send(
      `<html><body>
<h3>Session token received: ${token.substring(0, 4)}****</h3>
<p>Saving to your account...</p>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: 'breeze_session_saved', token: '${token}' }, '*');
    document.querySelector('p').textContent = 'Saved! You can close this tab.';
    setTimeout(() => window.close(), 1500);
  } else {
    document.querySelector('p').textContent = 'Copy this token and paste it in Settings > Session Token: ${token}';
  }
</script>
</body></html>`,
    );
  };

  app.get('/breeze-callback', handleBreezeCallback);
  app.post('/breeze-callback', handleBreezeCallback);
}
