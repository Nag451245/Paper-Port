import type { FastifyRequest, FastifyReply } from 'fastify';
import { accountRole, sessionProblem } from '../lib/token-revocation.js';

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'Not authenticated' });
    return;
  }

  const { sub, iat } = request.user as JwtPayload;
  let problem: string | null = null;
  try {
    problem = await sessionProblem(sub, iat);
  } catch {
    // Database unreachable: the signature is valid, so let the request through
    // rather than lock every user out. The route's own queries will fail anyway.
  }
  if (problem) {
    reply.code(401).send({ error: problem });
  }
}

/** Signed in AND the administrator. The role is read from the database, never trusted from the token. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(request, reply);
  if (reply.sent) return;
  let role = '';
  try {
    role = await accountRole(getUserId(request));
  } catch { /* fall through to refuse */ }
  if (role !== 'ADMIN') {
    reply.code(403).send({ error: 'Only the administrator can do this.' });
  }
}

export function getUserId(request: FastifyRequest): string {
  const payload = request.user as JwtPayload;
  return payload.sub;
}
