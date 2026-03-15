import type { PrismaClient } from '@prisma/client';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const POLL_INTERVAL = 10_000;

export class TelegramService {
  private botToken: string | null;
  private lastUpdateId = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private prisma: PrismaClient) {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN ?? null;
    if (this.botToken) this.startPolling();
  }

  get isConfigured(): boolean {
    return !!this.botToken;
  }

  stopPolling(): void {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => this.pollUpdates(), POLL_INTERVAL);
    this.pollUpdates();
  }

  private async pollUpdates(): Promise<void> {
    if (!this.botToken) return;
    try {
      const res = await fetch(
        `${TELEGRAM_API}${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=0&allowed_updates=["message"]`,
      );
      const data = await res.json() as {
        ok: boolean;
        result?: Array<{
          update_id: number;
          message?: { chat: { id: number; first_name?: string }; text?: string };
        }>;
      };
      if (!data.ok || !data.result) return;

      for (const update of data.result) {
        this.lastUpdateId = update.update_id;
        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);
        const name = msg.chat.first_name ?? 'there';

        if (msg.text === '/start') {
          await this.sendMessage(chatId,
            `👋 Hello ${name}!\n\n` +
            `Your <b>Chat ID</b> is:\n<code>${chatId}</code>\n\n` +
            `📋 Copy this number, go to <b>PaperPort Settings → Telegram</b>, paste it, and click <b>Connect</b>.`,
          );
        } else if (msg.text === '/status') {
          const user = await this.prisma.user.findFirst({
            where: { telegramChatId: chatId },
            select: { fullName: true, notifyTelegram: true },
          });
          if (user) {
            await this.sendMessage(chatId,
              `✅ Connected as <b>${user.fullName}</b>\nNotifications: ${user.notifyTelegram ? 'ON' : 'OFF'}`,
            );
          } else {
            await this.sendMessage(chatId,
              `⚠️ Not connected to any PaperPort account.\nPaste your Chat ID (<code>${chatId}</code>) in Settings to connect.`,
            );
          }
        }
      }
    } catch {
      // silent — poll will retry
    }
  }

  async sendMessage(chatId: string, text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
    if (!this.botToken || !chatId) return false;

    try {
      const response = await fetch(`${TELEGRAM_API}${this.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
      });

      const data = await response.json() as { ok: boolean };
      return data.ok;
    } catch (err) {
      console.error('[Telegram] Send failed:', (err as Error).message);
      return false;
    }
  }

  async notifyUser(userId: string, title: string, message: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramChatId: true, notifyTelegram: true, fullName: true },
    });

    if (!user?.notifyTelegram || !user.telegramChatId) return false;

    const text = `<b>${title}</b>\n\n${message}`;
    return this.sendMessage(user.telegramChatId, text);
  }

  async notifyTradeExecution(
    userId: string,
    symbol: string,
    side: string,
    qty: number,
    price: number,
    pnl?: number,
  ): Promise<boolean> {
    const emoji = side === 'BUY' ? '🟢' : '🔴';
    const pnlLine = pnl !== undefined ? `\nP&L: <b>${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}</b>` : '';

    return this.notifyUser(userId, `${emoji} Trade Executed`,
      `${side} ${qty}x ${symbol} @ ₹${price.toFixed(2)}${pnlLine}`);
  }

  async notifySignal(
    userId: string,
    symbol: string,
    direction: string,
    confidence: number,
    entry: number,
    target: number,
    stopLoss: number,
  ): Promise<boolean> {
    return this.notifyUser(userId, '📊 AI Signal',
      `<b>${direction} ${symbol}</b>\nEntry: ₹${entry} | Target: ₹${target} | SL: ₹${stopLoss}\nConfidence: ${(confidence * 100).toFixed(0)}%`);
  }

  async notifyRiskAlert(userId: string, alertType: string, message: string): Promise<boolean> {
    return this.notifyUser(userId, `⚠️ Risk Alert: ${alertType}`, message);
  }

  async notifyDailyReport(userId: string, report: {
    trades: number;
    pnl: number;
    winRate: number;
    topWinner: string;
    topLoser: string;
    regime: string;
  }): Promise<boolean> {
    const emoji = report.pnl >= 0 ? '📈' : '📉';
    return this.notifyUser(userId, `${emoji} Daily Report`,
      `Trades: ${report.trades} | P&L: ${report.pnl >= 0 ? '+' : ''}₹${report.pnl.toFixed(2)}\nWin Rate: ${report.winRate.toFixed(1)}%\nTop Winner: ${report.topWinner}\nTop Loser: ${report.topLoser}\nRegime: ${report.regime}`);
  }

  async verifyConnection(chatId: string): Promise<{ success: boolean; username?: string }> {
    if (!this.botToken) return { success: false };

    try {
      const sent = await this.sendMessage(chatId,
        '✅ <b>PaperPort Connected!</b>\n\nYou will now receive trade alerts, signals, and daily reports here.');
      return { success: sent };
    } catch {
      return { success: false };
    }
  }

  async getBotInfo(): Promise<{ username: string; name: string } | null> {
    if (!this.botToken) return null;

    try {
      const res = await fetch(`${TELEGRAM_API}${this.botToken}/getMe`);
      const data = await res.json() as { ok: boolean; result?: { username: string; first_name: string } };
      if (data.ok && data.result) {
        return { username: data.result.username, name: data.result.first_name };
      }
      return null;
    } catch {
      return null;
    }
  }
}
