import type { FastifyRequest, FastifyReply } from 'fastify';

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
  }
}

export function getUserId(request: FastifyRequest): string {
  const payload = request.user as JwtPayload;
  return payload.sub;
}
