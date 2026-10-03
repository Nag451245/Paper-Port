/**
 * The administrator (env.ADMIN_EMAIL, one account only) approves new sign-ups
 * and can block, unblock and delete users. Everything here is for that one
 * account: routes/admin.ts guards it with requireAdmin.
 */
import type { PrismaClient } from '@prisma/client';
import { env } from '../config.js';
import { createChildLogger } from '../lib/logger.js';
import { forgetAccount } from '../lib/token-revocation.js';
import { appBaseUrl } from '../lib/app-url.js';
import { isMailConfigured, sendMail } from '../lib/mailer.js';

const log = createChildLogger('Admin');

export class AdminError extends Error {
  constructor(message: string, public readonly statusCode = 400) { super(message); }
}

export interface AdminUserRow {
  id: string; email: string; fullName: string; role: string; status: string; createdAt: Date;
}

const adminEmail = () => env.ADMIN_EMAIL.toLowerCase();

export class AdminService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Make ADMIN_EMAIL's account the administrator (active), and the only one:
   * any other account holding the admin role loses it. Run at startup.
   */
  async ensureSingleAdmin(): Promise<void> {
    const admin = await this.prisma.user.findFirst({ where: { email: { equals: adminEmail(), mode: 'insensitive' } } });
    if (admin && (admin.role !== 'ADMIN' || admin.status !== 'ACTIVE' || !admin.isActive)) {
      await this.prisma.user.update({ where: { id: admin.id }, data: { role: 'ADMIN', status: 'ACTIVE', isActive: true } });
      forgetAccount(admin.id);
      log.info({ email: admin.email }, 'Administrator account set');
    }
    const others = await this.prisma.user.updateMany({
      where: { role: 'ADMIN', NOT: { email: { equals: adminEmail(), mode: 'insensitive' } } },
      data: { role: 'LEARNER' },
    });
    if (others.count) log.warn({ count: others.count }, 'Removed the admin role from accounts other than ADMIN_EMAIL');
  }

  async listUsers(): Promise<AdminUserRow[]> {
    const rows = await this.prisma.user.findMany({
      select: { id: true, email: true, fullName: true, role: true, status: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }],
    });
    // Waiting for approval first, then active, then blocked.
    const rank: Record<string, number> = { PENDING: 0, ACTIVE: 1, BLOCKED: 2 };
    return rows.sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3));
  }

  private async target(adminId: string, userId: string) {
    if (userId === adminId) throw new AdminError('You cannot change your own account here.');
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AdminError('User not found', 404);
    if (user.role === 'ADMIN') throw new AdminError('The administrator account cannot be changed here.');
    return user;
  }

  private async setStatus(adminId: string, userId: string, status: 'ACTIVE' | 'BLOCKED') {
    const user = await this.target(adminId, userId);
    const updated = await this.prisma.user.update({ where: { id: user.id }, data: { status, isActive: status === 'ACTIVE' } });
    forgetAccount(user.id);                          // takes effect on the user's very next request
    if (status === 'BLOCKED') await this.stopTrading(user.id);
    log.info({ user: user.email, status }, 'User status changed by admin');
    return updated;
  }

  async approve(adminId: string, userId: string) {
    const user = await this.setStatus(adminId, userId, 'ACTIVE');
    if (isMailConfigured()) {
      sendMail({
        to: user.email,
        subject: 'Your PaperPort account is approved',
        text: `Hi ${user.fullName},\n\nYour account has been approved. You can sign in at ${appBaseUrl()}/login\n`,
      }).catch(() => {});
    }
    return user;
  }

  block(adminId: string, userId: string) { return this.setStatus(adminId, userId, 'BLOCKED'); }
  unblock(adminId: string, userId: string) { return this.setStatus(adminId, userId, 'ACTIVE'); }

  /** Bots of a blocked or deleted user stop at once. */
  private async stopTrading(userId: string) {
    await this.prisma.tradingBot.updateMany({ where: { userId, status: 'RUNNING' }, data: { status: 'IDLE', lastAction: 'Stopped: account blocked by the administrator' } })
      .catch((err) => log.warn({ err: (err as Error).message }, 'Could not stop bots of blocked user'));
  }

  /**
   * Delete a user and everything they own. Rows that reference each other
   * without a cascade (orders/trades → positions, bots → portfolios, bot
   * messages → bots) are removed first, inside one transaction.
   */
  async remove(adminId: string, userId: string): Promise<void> {
    const user = await this.target(adminId, userId);
    await this.stopTrading(user.id);
    const portfolios = (await this.prisma.portfolio.findMany({ where: { userId: user.id }, select: { id: true } })).map((p) => p.id);
    const bots = (await this.prisma.tradingBot.findMany({ where: { userId: user.id }, select: { id: true } })).map((b) => b.id);
    await this.prisma.$transaction([
      this.prisma.botMessage.deleteMany({ where: { OR: [{ fromBotId: { in: bots } }, { toBotId: { in: bots } }, { userId: user.id }] } }),
      this.prisma.tradingBot.deleteMany({ where: { id: { in: bots } } }),
      this.prisma.order.deleteMany({ where: { portfolioId: { in: portfolios } } }),
      this.prisma.trade.deleteMany({ where: { portfolioId: { in: portfolios } } }),
      this.prisma.user.delete({ where: { id: user.id } }),
    ]);
    forgetAccount(user.id);
    log.warn({ user: user.email }, 'User deleted by admin');
  }

  /** Tell the administrator someone is waiting: in the app, on Telegram, and by email when set up. */
  async notifyNewSignup(user: { email: string; fullName: string }): Promise<void> {
    const admin = await this.prisma.user.findFirst({ where: { email: { equals: adminEmail(), mode: 'insensitive' } } });
    if (!admin) return;
    const title = 'New sign-up waiting for approval';
    const message = `${user.fullName} (${user.email}) signed up. Approve or block them in Admin → Users.`;
    try {
      const { NotificationService } = await import('./notification.service.js');
      await new NotificationService(this.prisma).create(admin.id, title, message, 'critical');   // critical also goes to Telegram
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Could not notify the administrator in the app');
    }
    if (isMailConfigured()) {
      sendMail({ to: admin.email, subject: title, text: `${message}\n\n${appBaseUrl()}/admin\n` }).catch(() => {});
    }
  }
}
