import type { FastifyRequest, FastifyReply } from 'fastify';
import { isIssuedBeforePasswordChange } from '../lib/token-revocation.js';

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
  let revoked = false;
  try {
    revoked = await isIssuedBeforePasswordChange(sub, iat);
  } catch {
    // Database unreachable: the signature is valid, so let the request through
    // rather than lock every user out. The route's own queries will fail anyway.
  }
  if (revoked) {
    reply.code(401).send({ error: 'Session ended because the password was changed. Please sign in again.' });
  }
}

export function getUserId(request: FastifyRequest): string {
  const payload = request.user as JwtPayload;
  return payload.sub;
}
