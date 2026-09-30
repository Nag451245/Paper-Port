/**
 * Set a new password for an existing account. There is no self-service reset,
 * and passwords are stored as bcrypt hashes, so a forgotten one cannot be read
 * back from anywhere; it can only be replaced.
 *
 * The new password is typed at a hidden prompt and never passed as an argument,
 * so it does not land in shell history or the process list.
 *
 * Usage (DATABASE_URL in server/.env must point at the database you mean):
 *   npx tsx scripts/reset-password.ts you@example.com
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '@prisma/client';
import readline from 'readline';

const SALT_ROUNDS = 12;   // same as auth.service.ts
const MIN_LENGTH = 8;     // same as the register schema in routes/auth.ts

function askHidden(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    const out = rl as unknown as { _writeToOutput: (s: string) => void };
    out._writeToOutput = (s: string) => { if (!muted || s.includes('\n')) process.stdout.write(muted ? '\n' : s); };
    rl.question(question, answer => { rl.close(); resolve(answer); });
    muted = true;
  });
}

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npx tsx scripts/reset-password.ts <email>');
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`No account with email ${email} in this database.`);
    process.exit(1);
  }
  const host = (process.env.DATABASE_URL ?? '').replace(/^[^@]*@/, '').split('/')[0] || 'unknown host';
  console.log(`Resetting the password for ${email} on ${host}`);

  const first = await askHidden('New password: ');
  if (first.length < MIN_LENGTH) {
    console.error(`Password must be at least ${MIN_LENGTH} characters. Nothing changed.`);
    process.exit(1);
  }
  const second = await askHidden('Repeat it: ');
  if (first !== second) {
    console.error('The two entries differ. Nothing changed.');
    process.exit(1);
  }

  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(first, SALT_ROUNDS) } });
  console.log('Password updated. Log in with the new one.');
  if (!user.isActive) console.log('Note: this account is deactivated, so login will still be refused.');
} finally {
  await prisma.$disconnect();
}
