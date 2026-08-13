import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';

export async function createTestApp(): Promise<FastifyInstance> {
  const app = await buildApp({ logger: false });
  await app.ready();
  return app;
}

export function authHeader(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

export const TEST_USER = {
  email: 'test@example.com',
  password: 'SecurePass123!',
  fullName: 'Test User',
  riskAppetite: 'MODERATE' as const,
  virtualCapital: 1000000,
};

export function mockUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-user-id-123',
    email: TEST_USER.email,
    passwordHash: '$2a$12$LJ3m4ys1U3kXXXXXXXXXXuKK3qNXXXXXXXXXXXXXXXXXXXXXXXXX',
    fullName: TEST_USER.fullName,
    riskAppetite: 'MODERATE',
    virtualCapital: 1000000,
    role: 'LEARNER',
    isActive: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}
