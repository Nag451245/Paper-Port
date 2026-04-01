import type { FastifyRequest, FastifyReply } from 'fastify';
export interface JwtPayload {
    sub: string;
    iat: number;
    exp: number;
}
export declare function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
export declare function getUserId(request: FastifyRequest): string;
//# sourceMappingURL=auth.d.ts.map