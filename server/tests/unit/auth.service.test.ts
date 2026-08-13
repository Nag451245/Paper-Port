import { describe, it, expect, vi, beforeEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { AuthService, AuthError } from '../../src/services/auth.service.js';

function createMockPrisma() {
  return {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    breezeCredential: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
  } as any;
}

const JWT_SECRET = 'test-jwt-secret-for-unit-tests';

describe('AuthService', () => {
  let authService: AuthService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    authService = new AuthService(mockPrisma, JWT_SECRET);
    vi.clearAllMocks();
  });

  describe('register', () => {
    it('should register a new user and create a default portfolio', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      mockPrisma.user.create.mockResolvedValue({
        id: 'new-user-id',
        email: 'new@example.com',
        fullName: 'New User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await authService.register({
        email: 'new@example.com',
        password: 'SecurePass123!',
        fullName: 'New User',
      });

      expect(result.user.email).toBe('new@example.com');
      expect(result.user.fullName).toBe('New User');
      expect(result.userId).toBe('new-user-id');

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: 'new@example.com',
            fullName: 'New User',
            riskAppetite: 'MODERATE',
            portfolios: expect.objectContaining({
              create: expect.objectContaining({
                name: 'Default Portfolio',
                isDefault: true,
              }),
            }),
          }),
        }),
      );

      const createCall = mockPrisma.user.create.mock.calls[0][0];
      const passwordHash = createCall.data.passwordHash;
      const isValid = await bcrypt.compare('SecurePass123!', passwordHash);
      expect(isValid).toBe(true);
    });

    it('should throw 409 if email already exists', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 'existing-user' });

      await expect(
        authService.register({
          email: 'existing@example.com',
          password: 'Pass123!',
          fullName: 'Existing User',
        }),
      ).rejects.toThrow(AuthError);

      try {
        await authService.register({
          email: 'existing@example.com',
          password: 'Pass123!',
          fullName: 'Existing User',
        });
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).statusCode).toBe(409);
      }
    });

    it('should use custom riskAppetite and virtualCapital if provided', async () => {
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

      const result = await authService.register({
        email: 'custom@example.com',
        password: 'Pass123!',
        fullName: 'Custom User',
        riskAppetite: 'AGGRESSIVE',
        virtualCapital: 5000000,
      });

      expect(result.user.riskAppetite).toBe('AGGRESSIVE');

      const createCall = mockPrisma.user.create.mock.calls[0][0];
      expect(createCall.data.riskAppetite).toBe('AGGRESSIVE');
      expect(createCall.data.virtualCapital).toBe(5000000);
      expect(createCall.data.portfolios.create.initialCapital).toBe(5000000);
    });
  });

  describe('login', () => {
    const hashedPassword = bcrypt.hashSync('ValidPass123!', 12);

    it('should login with valid credentials', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.com',
        passwordHash: hashedPassword,
        fullName: 'User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await authService.login({
        email: 'user@example.com',
        password: 'ValidPass123!',
      });

      expect(result.user.email).toBe('user@example.com');
      expect(result.userId).toBe('user-id');
    });

    it('should throw 401 for non-existent email', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      try {
        await authService.login({ email: 'nonexistent@example.com', password: 'Pass123!' });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).statusCode).toBe(401);
        expect((err as AuthError).message).toBe('Invalid email or password');
      }
    });

    it('should throw 401 for wrong password', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.com',
        passwordHash: hashedPassword,
        fullName: 'User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      try {
        await authService.login({ email: 'user@example.com', password: 'WrongPass!' });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).statusCode).toBe(401);
      }
    });

    it('should throw 403 for deactivated account', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.com',
        passwordHash: hashedPassword,
        fullName: 'User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      try {
        await authService.login({ email: 'user@example.com', password: 'ValidPass123!' });
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).statusCode).toBe(403);
        expect((err as AuthError).message).toBe('Account is deactivated');
      }
    });
  });

  describe('getProfile', () => {
    it('should return user profile', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.com',
        fullName: 'Test User',
        riskAppetite: 'MODERATE',
        virtualCapital: 1000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const profile = await authService.getProfile('user-id');

      expect(profile.id).toBe('user-id');
      expect(profile.email).toBe('user@example.com');
      expect(profile.virtualCapital).toBe(1000000);
    });

    it('should throw 404 for non-existent user', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);

      try {
        await authService.getProfile('nonexistent-id');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).statusCode).toBe(404);
      }
    });
  });

  describe('updateProfile', () => {
    it('should update user fields', async () => {
      mockPrisma.user.update.mockResolvedValue({
        id: 'user-id',
        email: 'user@example.com',
        fullName: 'Updated Name',
        riskAppetite: 'AGGRESSIVE',
        virtualCapital: 2000000,
        role: 'LEARNER',
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await authService.updateProfile('user-id', {
        fullName: 'Updated Name',
        riskAppetite: 'AGGRESSIVE',
      });

      expect(result.fullName).toBe('Updated Name');
      expect(result.riskAppetite).toBe('AGGRESSIVE');
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-id' },
        data: { fullName: 'Updated Name', riskAppetite: 'AGGRESSIVE' },
      });
    });
  });

  describe('Breeze credentials', () => {
    it('should save encrypted credentials', async () => {
      mockPrisma.breezeCredential.upsert.mockResolvedValue({
        id: 'cred-id',
        userId: 'user-id',
        updatedAt: new Date('2025-06-01'),
      });

      const result = await authService.saveBreezeCredentials('user-id', {
        apiKey: 'my-api-key',
        secretKey: 'my-secret-key',
      });

      expect(result.configured).toBe(true);
      expect(result.updatedAt).toBeInstanceOf(Date);

      const upsertCall = mockPrisma.breezeCredential.upsert.mock.calls[0][0];
      expect(upsertCall.where.userId).toBe('user-id');
      // Encrypted values should not equal the original
      expect(upsertCall.create.encryptedApiKey).not.toBe('my-api-key');
      expect(upsertCall.create.encryptedSecret).not.toBe('my-secret-key');
    });

    it('should return credential status', async () => {
      mockPrisma.breezeCredential.findUnique.mockResolvedValue({
        userId: 'user-id',
        totpSecret: 'totp123',
        updatedAt: new Date('2025-06-01'),
      });

      const status = await authService.getBreezeCredentialStatus('user-id');

      expect(status.configured).toBe(true);
      expect(status.hasTotp).toBe(true);
      expect(status.updatedAt).toBe('2025-06-01T00:00:00.000Z');
    });

    it('should return not configured when no credentials exist', async () => {
      mockPrisma.breezeCredential.findUnique.mockResolvedValue(null);

      const status = await authService.getBreezeCredentialStatus('user-id');

      expect(status.configured).toBe(false);
      expect(status.hasTotp).toBe(false);
      expect(status.updatedAt).toBeNull();
    });

    it('should encrypt and decrypt credentials round-trip', async () => {
      let storedCreate: any = null;
      mockPrisma.breezeCredential.upsert.mockImplementation(async (args: any) => {
        storedCreate = args.create;
        return { id: 'cred-id', userId: 'user-id', updatedAt: new Date() };
      });

      await authService.saveBreezeCredentials('user-id', {
        apiKey: 'test-api-key-123',
        secretKey: 'test-secret-456',
      });

      mockPrisma.breezeCredential.findUnique.mockResolvedValue({
        userId: 'user-id',
        encryptedApiKey: storedCreate.encryptedApiKey,
        encryptedSecret: storedCreate.encryptedSecret,
        totpSecret: null,
        updatedAt: new Date(),
      });

      const decrypted = await authService.getDecryptedBreezeCredentials('user-id');

      expect(decrypted).not.toBeNull();
      expect(decrypted!.apiKey).toBe('test-api-key-123');
      expect(decrypted!.secretKey).toBe('test-secret-456');
    });
  });
});
