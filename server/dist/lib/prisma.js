import { PrismaClient } from '@prisma/client';
let prisma;
export function getPrisma() {
    if (!prisma) {
        prisma = new PrismaClient({
            log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
        });
    }
    return prisma;
}
export async function disconnectPrisma() {
    if (prisma) {
        await prisma.$disconnect();
    }
}
//# sourceMappingURL=prisma.js.map