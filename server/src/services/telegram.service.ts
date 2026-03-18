import type { PrismaClient } from '@prisma/client';
import { engineScan, engineOptionsSignals, engineOptionsData, isEngineAvailable } from '../lib/rust-engine.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const POLL_INTERVAL = 10_000;
const BRIDGE_URL = process.env.BREEZE_BRIDGE_URL || 'http://127.0.0.1:8001';
const SCAN_COOLDOWN_MS = 15_000;

export class TelegramService {
  private botToken: string | null;
  private lastUpdateId = 0;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private userCooldowns = new Map<string, number>();

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

  private isOnCooldown(chatId: string): boolean {
    const last = this.userCooldowns.get(chatId) ?? 0;
    if (Date.now() - last < SCAN_COOLDOWN_MS) return true;
    this.userCooldowns.set(chatId, Date.now());
    return false;
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
        const text = msg.text.trim();

        if (text === '/start') {
          await this.sendMessage(chatId,
            `👋 Hello ${name}!\n\n` +
            `Your <b>Chat ID</b> is:\n<code>${chatId}</code>\n\n` +
            `📋 Copy this number, go to <b>PaperPort Settings → Telegram</b>, paste it, and click <b>Connect</b>.`,
          );
        } else if (text === '/status') {
          await this.handleStatus(chatId);
        } else if (text === '/help') {
          await this.handleHelp(chatId);
        } else if (text.startsWith('/scan ')) {
          await this.handleScanCommand(chatId, text.slice(6).trim().toUpperCase());
        } else if (text.startsWith('/options ')) {
          await this.handleOptionsCommand(chatId, text.slice(9).trim().toUpperCase());
        } else if (text.startsWith('/quote ')) {
          await this.handleQuoteCommand(chatId, text.slice(7).trim().toUpperCase());
        } else if (/^[A-Z&-]{2,20}$/.test(text.toUpperCase()) && !text.startsWith('/')) {
          await this.handleScanCommand(chatId, text.toUpperCase());
        }
      }
    } catch {
      // silent — poll will retry
    }
  }

  private async handleStatus(chatId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
      select: { fullName: true, notifyTelegram: true },
    });
    if (user) {
      await this.sendMessage(chatId,
        `✅ Connected as <b>${user.fullName}</b>\nNotifications: ${user.notifyTelegram ? 'ON' : 'OFF'}`);
    } else {
      await this.sendMessage(chatId,
        `⚠️ Not connected to any PaperPort account.\nPaste your Chat ID (<code>${chatId}</code>) in Settings to connect.`);
    }
  }

  private async handleHelp(chatId: string): Promise<void> {
    await this.sendMessage(chatId,
      `<b>📖 PaperPort Bot Commands</b>\n\n` +
      `<b>/scan SYMBOL</b> — Full technical analysis\n` +
      `  <i>e.g. /scan RELIANCE</i>\n\n` +
      `<b>/options SYMBOL</b> — Options chain analysis\n` +
      `  <i>e.g. /options NIFTY</i>\n\n` +
      `<b>/quote SYMBOL</b> — Quick price quote\n` +
      `  <i>e.g. /quote TCS</i>\n\n` +
      `<b>/status</b> — Check connection status\n\n` +
      `💡 You can also just type a symbol name (e.g. <b>INFY</b>) for a quick scan.`);
  }

  private async handleScanCommand(chatId: string, symbol: string): Promise<void> {
    if (!symbol || symbol.length < 2) {
      await this.sendMessage(chatId, '⚠️ Please provide a valid symbol.\n<i>Example: /scan RELIANCE</i>');
      return;
    }
    if (this.isOnCooldown(chatId)) {
      await this.sendMessage(chatId, '⏳ Please wait 15 seconds between scan requests.');
      return;
    }

    await this.sendMessage(chatId, `🔍 Analyzing <b>${symbol}</b>...`);

    try {
      const candles = await this.fetchCandles(symbol);
      if (!candles || candles.length < 15) {
        await this.sendMessage(chatId, `⚠️ Not enough data for <b>${symbol}</b>. Check if the symbol is valid.`);
        return;
      }

      if (!isEngineAvailable()) {
        await this.sendMessage(chatId, '⚠️ Rust engine is offline. Try again later.');
        return;
      }

      const result = await engineScan({
        symbols: [{ symbol, candles }],
        aggressiveness: 'high',
        current_date: new Date().toISOString().split('T')[0],
      });

      if (!result.signals || result.signals.length === 0) {
        const lastPrice = candles[candles.length - 1]?.close ?? 0;
        await this.sendMessage(chatId,
          `<b>📊 ${symbol} Analysis</b>\n\n` +
          `LTP: ₹${lastPrice.toFixed(2)}\n` +
          `Direction: <b>NEUTRAL</b>\n\n` +
          `No strong signals detected. Market is range-bound or lacks momentum.`);
        return;
      }

      const sig = result.signals[0];
      const emoji = sig.direction === 'BUY' ? '🟢' : '🔴';
      const entryPct = sig.entry > 0 && sig.target > 0
        ? ((sig.target - sig.entry) / sig.entry * 100).toFixed(1) : '—';
      const slPct = sig.entry > 0 && sig.stop_loss > 0
        ? ((sig.stop_loss - sig.entry) / sig.entry * 100).toFixed(1) : '—';

      const indicators = sig.indicators ?? {};
      const indLines: string[] = [];
      if (indicators.ema_9 && indicators.ema_21) indLines.push(`EMA9: ${indicators.ema_9.toFixed(1)} | EMA21: ${indicators.ema_21.toFixed(1)}`);
      if (indicators.rsi_14) indLines.push(`RSI: ${indicators.rsi_14.toFixed(1)}`);
      if (indicators.macd_histogram) indLines.push(`MACD Hist: ${indicators.macd_histogram.toFixed(2)}`);
      if (indicators.supertrend) indLines.push(`Supertrend: ${indicators.supertrend.toFixed(1)}`);

      await this.sendMessage(chatId,
        `<b>🦀 Rust Engine Analysis: ${symbol}</b>\n\n` +
        `${emoji} Direction: <b>${sig.direction}</b>\n` +
        `Confidence: <b>${(sig.confidence * 100).toFixed(0)}%</b>\n\n` +
        `Entry: ₹${sig.entry.toFixed(2)}\n` +
        `Target: ₹${sig.target.toFixed(2)} (${entryPct}%)\n` +
        `Stop Loss: ₹${sig.stop_loss.toFixed(2)} (${slPct}%)\n\n` +
        (indLines.length > 0 ? `<b>Indicators:</b>\n${indLines.join('\n')}\n` : '') +
        (sig.strategy ? `Strategy: ${sig.strategy}` : ''));

    } catch (err) {
      await this.sendMessage(chatId, `❌ Scan failed for <b>${symbol}</b>: ${(err as Error).message}`);
    }
  }

  private async handleOptionsCommand(chatId: string, symbol: string): Promise<void> {
    if (!symbol || symbol.length < 2) {
      await this.sendMessage(chatId, '⚠️ Please provide a valid symbol.\n<i>Example: /options NIFTY</i>');
      return;
    }
    if (this.isOnCooldown(chatId)) {
      await this.sendMessage(chatId, '⏳ Please wait 15 seconds between requests.');
      return;
    }

    await this.sendMessage(chatId, `📊 Fetching options data for <b>${symbol}</b>...`);

    try {
      const [optData, allSignals] = await Promise.all([
        engineOptionsData(symbol),
        engineOptionsSignals(),
      ]);

      const symbolSignals = allSignals.filter(s => s.symbol === symbol && s.confidence >= 0.5);

      if (!optData && symbolSignals.length === 0) {
        await this.sendMessage(chatId,
          `⚠️ No options data available for <b>${symbol}</b>.\n\n` +
          `Options data is available for major F&O symbols (NIFTY, BANKNIFTY, RELIANCE, etc.). ` +
          `Make sure the Rust engine options feed is running.`);
        return;
      }

      const lines: string[] = [`<b>📊 Options Analysis: ${symbol}</b>\n`];

      if (optData) {
        const pcr = optData.pcr as number | undefined;
        const maxPain = optData.max_pain as number | undefined;
        const atmIv = optData.atm_iv as number | undefined;
        const spot = optData.spot_price as number | undefined;

        if (spot) lines.push(`Spot: ₹${Number(spot).toFixed(2)}`);
        if (pcr !== undefined) {
          const pcrBias = pcr > 1.3 ? 'Bullish' : pcr < 0.7 ? 'Bearish' : 'Neutral';
          lines.push(`PCR: <b>${pcr.toFixed(2)}</b> (${pcrBias})`);
        }
        if (maxPain) lines.push(`Max Pain: ₹${Number(maxPain).toLocaleString()}`);
        if (atmIv !== undefined) lines.push(`ATM IV: ${(atmIv * 100).toFixed(1)}%`);
      }

      if (symbolSignals.length > 0) {
        lines.push('\n<b>Signals:</b>');
        for (const sig of symbolSignals) {
          const emoji = sig.side.toLowerCase() === 'buy' ? '🟢' : sig.side.toLowerCase() === 'sell' ? '🔴' : '🟡';
          lines.push(`${emoji} ${sig.strategy}: <b>${sig.side.toUpperCase()}</b> (${(sig.confidence * 100).toFixed(0)}%)`);
          if (sig.reason) lines.push(`   <i>${sig.reason}</i>`);
        }

        const bullish = symbolSignals.filter(s => s.side.toLowerCase() === 'buy').length;
        const bearish = symbolSignals.filter(s => s.side.toLowerCase() === 'sell').length;
        const bias = bullish > bearish ? '🟢 BULLISH' : bearish > bullish ? '🔴 BEARISH' : '🟡 NEUTRAL';
        lines.push(`\nDirectional Bias: <b>${bias}</b>`);
      }

      await this.sendMessage(chatId, lines.join('\n'));

    } catch (err) {
      await this.sendMessage(chatId, `❌ Options analysis failed for <b>${symbol}</b>: ${(err as Error).message}`);
    }
  }

  private async handleQuoteCommand(chatId: string, symbol: string): Promise<void> {
    if (!symbol || symbol.length < 2) {
      await this.sendMessage(chatId, '⚠️ Please provide a valid symbol.\n<i>Example: /quote TCS</i>');
      return;
    }
    if (this.isOnCooldown(chatId)) {
      await this.sendMessage(chatId, '⏳ Please wait 15 seconds between requests.');
      return;
    }

    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10_000);
      const res = await fetch(`${BRIDGE_URL}/quote/${encodeURIComponent(symbol)}`, { signal: ac.signal });
      clearTimeout(timer);
      const quote = await res.json() as {
        ltp?: number; change?: number; changePercent?: number;
        volume?: number; open?: number; high?: number; low?: number;
        error?: string;
      };

      if (quote.error || !quote.ltp) {
        await this.sendMessage(chatId, `⚠️ No quote data for <b>${symbol}</b>. Check if the symbol is valid.`);
        return;
      }

      const changeEmoji = (quote.change ?? 0) >= 0 ? '🟢' : '🔴';
      const changeSign = (quote.change ?? 0) >= 0 ? '+' : '';
      const vol = quote.volume ? `${(quote.volume / 1_000_000).toFixed(1)}M` : '—';

      await this.sendMessage(chatId,
        `<b>${changeEmoji} ${symbol}</b>\n\n` +
        `LTP: <b>₹${quote.ltp.toFixed(2)}</b>\n` +
        `Change: ${changeSign}₹${(quote.change ?? 0).toFixed(2)} (${changeSign}${(quote.changePercent ?? 0).toFixed(2)}%)\n` +
        (quote.open ? `Open: ₹${quote.open.toFixed(2)} | ` : '') +
        (quote.high ? `High: ₹${quote.high.toFixed(2)} | ` : '') +
        (quote.low ? `Low: ₹${quote.low.toFixed(2)}\n` : '') +
        `Volume: ${vol}`);

    } catch (err) {
      await this.sendMessage(chatId, `❌ Quote failed for <b>${symbol}</b>: ${(err as Error).message}`);
    }
  }

  private async fetchCandles(symbol: string): Promise<Array<{ open: number; high: number; low: number; close: number; volume: number; timestamp: string }>> {
    try {
      const fromDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const toDate = new Date().toISOString().split('T')[0];
      const url = `${BRIDGE_URL}/historical/${encodeURIComponent(symbol)}?interval=5minute&from=${fromDate}&to=${toDate}`;

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20_000);
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(timer);
      const data = await res.json() as { bars?: Array<Record<string, unknown>>; error?: string };

      if (data.error || !data.bars) return [];

      return data.bars.map(b => ({
        open: Number(b.open ?? 0),
        high: Number(b.high ?? 0),
        low: Number(b.low ?? 0),
        close: Number(b.close ?? 0),
        volume: Number(b.volume ?? 0),
        timestamp: String(b.timestamp ?? b.datetime ?? new Date().toISOString()),
      }));
    } catch {
      return [];
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
    source?: string,
  ): Promise<boolean> {
    const sourceTag = source?.includes('rust') || source?.includes('engine')
      ? '🦀 Rust Engine' : '🤖 AI Bot';
    const entryLine = entry > 0 ? `\nEntry: ₹${entry.toFixed(2)}` : '';
    const targetLine = target > 0 ? ` | Target: ₹${target.toFixed(2)}` : '';
    const slLine = stopLoss > 0 ? ` | SL: ₹${stopLoss.toFixed(2)}` : '';

    return this.notifyUser(userId, `📊 ${sourceTag} Signal`,
      `<b>${direction} ${symbol}</b>${entryLine}${targetLine}${slLine}\nConfidence: <b>${(confidence * 100).toFixed(0)}%</b>`);
  }

  async notifyPipelineSignal(
    symbol: string,
    direction: string,
    confidence: number,
    strategy: string,
    mlScore: number,
    source: string,
  ): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: { notifyTelegram: true, telegramChatId: { not: null } },
      select: { telegramChatId: true },
    });
    if (users.length === 0) return;

    const emoji = direction === 'BUY' ? '🟢' : '🔴';
    const text =
      `<b>🦀 Rust Engine Signal</b>\n\n` +
      `${emoji} <b>${direction} ${symbol}</b>\n` +
      `Strategy: ${strategy}\n` +
      `Confidence: <b>${(confidence * 100).toFixed(0)}%</b> | ML Score: ${(mlScore * 100).toFixed(0)}%\n` +
      `Source: ${source}`;

    for (const u of users) {
      if (u.telegramChatId) {
        this.sendMessage(u.telegramChatId, text).catch(() => {});
      }
    }
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
