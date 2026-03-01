import type { PrismaClient } from '@prisma/client';

const TELEGRAM_API = 'https://api.telegram.org/bot';

export class TelegramService {
  private botToken: string | null;

  constructor(private prisma: PrismaClient) {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN ?? null;
  }

  get isConfigured(): boolean {
    return !!this.botToken;
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
