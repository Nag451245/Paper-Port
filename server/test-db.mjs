import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
try {
  const r = await p.$queryRawUnsafe('SELECT 1 as test');
  console.log('DB OK:', JSON.stringify(r));
} catch (e) {
  console.log('DB Error:', e.message);
}
await p.$disconnect();
process.exit(0);
