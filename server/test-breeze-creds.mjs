import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
try {
  const creds = await p.breezeCredential.findMany({
    select: {
      userId: true,
      encryptedApiKey: true,
      totpSecret: true,
      sessionToken: true,
      sessionExpiresAt: true,
      encryptedLoginId: true,
      encryptedLoginPassword: true,
      lastAutoLoginAt: true,
      autoLoginError: true,
    }
  });
  for (const c of creds) {
    console.log({
      userId: c.userId.substring(0, 8) + '...',
      hasApiKey: !!c.encryptedApiKey,
      hasTotp: !!c.totpSecret,
      hasSession: !!c.sessionToken,
      sessionExpiresAt: c.sessionExpiresAt,
      hasLoginId: !!c.encryptedLoginId,
      hasLoginPwd: !!c.encryptedLoginPassword,
      lastAutoLoginAt: c.lastAutoLoginAt,
      autoLoginError: c.autoLoginError?.substring(0, 200),
    });
  }
} catch(e) {
  console.error('Error:', e.message);
}
await p.$disconnect();
