import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';

let app: FastifyInstance;
let mockPrisma: any;

vi.mock('../../src/lib/prisma.js', () => {
  const mock = {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    breezeCredential: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    portfolio: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    $disconnect: vi.fn(),
    $connect: vi.fn(),
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ 1: 1 }]),
  };

  return {
    getPrisma: vi.fn(() => mock),
    disconnectPrisma: vi.fn(),
    __mockPrisma: mock,
  };
});

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js');
  const prismaModule = await import('../../src/lib/prisma.js');
  mockPrisma = (prismaModule as any).__mockPrisma;
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('Auth Routes Integration', () => {
  describe('POST /api/auth/register', () => {
    it('should register a new user and return JWT', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: 'new-user-id',
        email: 'newuser@example.com',
        fullName: 'New User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'newuser@example.com',
          password: 'SecurePass123!',
          fullName: 'New User',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.access_token).toBeTruthy();
      expect(body.token_type).toBe('bearer');
      expect(body.user.email).toBe('newuser@example.com');
      expect(body.user.fullName).toBe('New User');
    });

    it('should return 409 for duplicate email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'existing@example.com',
          password: 'SecurePass123!',
          fullName: 'Existing User',
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Email already registered');
    });

    it('should return 400 for invalid email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'not-an-email',
          password: 'SecurePass123!',
          fullName: 'User',
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('Validation failed');
    });

    it('should return 400 for short password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'user@example.com',
          password: 'short',
          fullName: 'User',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should return 400 for missing fullName', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'user@example.com',
          password: 'SecurePass123!',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should accept custom riskAppetite and virtualCapital', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: 'new-id',
        email: 'custom@example.com',
        fullName: 'Custom User',
        riskAppetite: 'AGGRESSIVE',
        virtualCapital: 5000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'custom@example.com',
          password: 'SecurePass123!',
          fullName: 'Custom User',
          riskAppetite: 'AGGRESSIVE',
          virtualCapital: 5000000,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().user.riskAppetite).toBe('AGGRESSIVE');
    });
  });

  describe('POST /api/auth/login', () => {
    const hashedPassword = bcrypt.hashSync('CorrectPass123!', 12);

    it('should login with valid credentials and return JWT', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-id-123',
        email: 'user@example.com',
        passwordHash: hashedPassword,
        fullName: 'Test User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'user@example.com',
          password: 'CorrectPass123!',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.access_token).toBeTruthy();
      expect(body.token_type).toBe('bearer');
      expect(body.user.email).toBe('user@example.com');
    });

    it('should return 401 for wrong password', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-id-123',
        email: 'user@example.com',
        passwordHash: hashedPassword,
        fullName: 'Test User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'user@example.com',
          password: 'WrongPassword!',
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Invalid email or password');
    });

    it('should return 401 for non-existent email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'nonexistent@example.com',
          password: 'SomePass123!',
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for deactivated account', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-id-123',
        email: 'deactivated@example.com',
        passwordHash: hashedPassword,
        fullName: 'Deactivated User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          email: 'deactivated@example.com',
          password: 'CorrectPass123!',
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it('should return 400 for missing email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          password: 'Pass123!',
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should return success', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('Logged out successfully');
    });
  });

  describe('GET /api/auth/me', () => {
    it('should return profile for authenticated user', async () => {
      const token = app.jwt.sign({ sub: 'user-id-for-me' });

      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-id-for-me',
        email: 'me@example.com',
        fullName: 'Me User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe('user-id-for-me');
      expect(body.email).toBe('me@example.com');
    });

    it('should return 401 without token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
      });

      expect(res.statusCode).toBe(401);
    });

    it('should return 401 with invalid token', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: {
          authorization: 'Bearer invalid-token-here',
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /api/auth/me', () => {
    it('should update profile fields', async () => {
      const token = app.jwt.sign({ sub: 'user-id-update' });

      mockPrisma.user.update.mockResolvedValue({
        id: 'user-id-update',
        email: 'update@example.com',
        fullName: 'Updated Name',
        riskAppetite: 'AGGRESSIVE',
        virtualCapital: 2000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          fullName: 'Updated Name',
          riskAppetite: 'AGGRESSIVE',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().fullName).toBe('Updated Name');
    });

    it('should return 401 without authentication', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/auth/me',
        payload: { fullName: 'Hack' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/auth/breeze-credentials', () => {
    it('should save Breeze credentials', async () => {
      const token = app.jwt.sign({ sub: 'user-id-breeze' });

      mockPrisma.breezeCredential.upsert.mockResolvedValue({
        id: 'cred-id',
        userId: 'user-id-breeze',
        updatedAt: new Date('2025-06-01'),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/breeze-credentials',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          api_key: 'my-breeze-key',
          secret_key: 'my-breeze-secret',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.configured).toBe(true);
      expect(body.updated_at).toBeTruthy();
    });

    it('should return 400 for missing api_key', async () => {
      const token = app.jwt.sign({ sub: 'user-id-breeze' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/breeze-credentials',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          secret_key: 'my-breeze-secret',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should return 401 without authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/breeze-credentials',
        payload: {
          api_key: 'key',
          secret_key: 'secret',
        },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/auth/breeze-credentials/status', () => {
    it('should return credential status when configured', async () => {
      const token = app.jwt.sign({ sub: 'user-id-status' });

      mockPrisma.breezeCredential.findUnique.mockResolvedValue({
        userId: 'user-id-status',
        totpSecret: 'totp-secret',
        updatedAt: new Date('2025-06-01'),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/breeze-credentials/status',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.configured).toBe(true);
      expect(body.has_totp).toBe(true);
      expect(body.updated_at).toBeTruthy();
    });

    it('should return not configured when no credentials', async () => {
      const token = app.jwt.sign({ sub: 'user-id-no-creds' });

      mockPrisma.breezeCredential.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/breeze-credentials/status',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.configured).toBe(false);
      expect(body.has_totp).toBe(false);
      expect(body.updated_at).toBeNull();
    });
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(['ok', 'degraded']).toContain(body.status);
      expect(body.timestamp).toBeTruthy();
    });
  });

  describe('JWT token lifecycle', () => {
    it('should be able to register then immediately use the token', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: 'lifecycle-user',
        email: 'lifecycle@example.com',
        fullName: 'Lifecycle User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const registerRes = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'lifecycle@example.com',
          password: 'LifecyclePass123!',
          fullName: 'Lifecycle User',
        },
      });

      expect(registerRes.statusCode).toBe(201);
      const { access_token } = registerRes.json();

      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'lifecycle-user',
        email: 'lifecycle@example.com',
        fullName: 'Lifecycle User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${access_token}` },
      });

      expect(meRes.statusCode).toBe(200);
      expect(meRes.json().email).toBe('lifecycle@example.com');
    });
  });
});
