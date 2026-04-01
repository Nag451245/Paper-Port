export async function authenticate(request, reply) {
    try {
        await request.jwtVerify();
    }
    catch {
        reply.code(401).send({ error: 'Not authenticated' });
    }
}
export function getUserId(request) {
    const payload = request.user;
    return payload.sub;
}
//# sourceMappingURL=auth.js.map