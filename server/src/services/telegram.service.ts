import type { PrismaClient } from '@prisma/client';
import { engineScan, engineOptionsSignals, engineOptionsData, isEngineAvailable, enginePerformanceSummary, engineActiveStrategies } from '../lib/rust-engine.js';
import { processCommandCenterChat } from '../routes/command-center.js';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const MIN_POLL_DELAY_MS = 3_000;
const MAX_POLL_DELAY_MS = 15_000;
const BRIDGE_URL = process.env.BREEZE_BRIDGE_URL || 'http://127.0.0.1:8001';
const SCAN_COOLDOWN_MS = 15_000;
const CHAT_COOLDOWN_MS = 5_000;
const PROCESSED_CACHE_SIZE = 500;

const GREETING_PATTERNS = new Set([
  'hi', 'hello', 'hey', 'hola', 'namaste', 'namaskar', 'namasthe',
  'vanakkam', 'sat sri akal', 'salaam', 'adab', 'howdy', 'yo',
  'good morning', 'good afternoon', 'good evening', 'good night',
  'suprabhat', 'shubh prabhat', 'bonjour', 'konnichiwa', 'annyeong',
  'hallo', 'ciao', 'ola', 'merhaba', 'salam', 'sawadee',
  'hey chitti', 'hi chitti', 'hello chitti', 'namaste chitti',
  'hey there', 'hi there', 'hello there', 'whats up', "what's up",
  'sup', 'wassup', 'kya haal', 'kya chal raha', 'kaise ho',
  'how are you', "how's it going", 'howzit',
]);

const CHITTI_GREETINGS = [
  "Namaste, trader! Chitti here — your markets companion. The screens are on, the data is flowing. What are we trading today?",
  "Hey! Chitti at your service. Markets never sleep and neither does my analysis engine. What's on your mind?",
  "Welcome back! I've been watching the tapes. NIFTY's got an interesting setup today. Ask me anything — scan a symbol, check your portfolio, or just chat markets.",
  "Hello, trader! Chitti reporting for duty. I've got 76 features, 40+ indicators, and strong opinions. Fire away.",
  "Yo! Good to see you. I've been crunching numbers while you were away. Want a status update, a scan, or shall we discuss a trade idea?",
  "Greetings! Chitti here — part quant, part mentor, fully caffeinated. The market's whispering today. What do you want to explore?",
  "Hey there! Your trading AI is locked and loaded. Ask me for a /scan, /quote, /status — or just talk markets in plain English.",
  "Namaste! I've been tracking your positions and the broader market. Everything's in check. What shall we look at?",
];

const KNOWN_SYMBOLS = new Set([
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'BHARTIARTL',
  'HINDUNILVR', 'ITC', 'KOTAKBANK', 'LT', 'HCLTECH', 'AXISBANK', 'ASIANPAINT',
  'MARUTI', 'SUNPHARMA', 'TITAN', 'BAJFINANCE', 'WIPRO', 'ULTRACEMCO',
  'NESTLEIND', 'TATAMOTORS', 'TATASTEEL', 'POWERGRID', 'NTPC', 'ONGC',
  'COALINDIA', 'ADANIENT', 'ADANIPORTS', 'TECHM', 'INDUSINDBK', 'DRREDDY',
  'CIPLA', 'BAJAJFINSV', 'HEROMOTOCO', 'DIVISLAB', 'EICHERMOT', 'GRASIM',
  'APOLLOHOSP', 'BPCL', 'JSWSTEEL', 'HINDALCO', 'BAJAJ-AUTO', 'TATACONSUM',
  'M&M', 'BRITANNIA', 'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY',
  'HDFCLIFE', 'SBILIFE', 'PNB', 'BANKBARODA', 'VEDL', 'TRENT', 'ZOMATO',
  'IRCTC', 'HAL', 'BEL', 'BHEL', 'GAIL', 'IOC', 'RECLTD', 'PFC',
]);

export class TelegramService {
  private static pollingInstance: TelegramService | null = null;
  private static pollingStarted = false;

  private botToken: string | null;
  private lastUpdateId = 0;
  private polling = false;
  private stopRequested = false;
  private processedUpdateIds = new Set<number>();
  private userCooldowns = new Map<string, number>();
  private chatCooldowns = new Map<string, number>();
  private processingMessages = new Set<string>();

  constructor(private prisma: PrismaClient) {
    this.botToken = process.env.TELEGRAM_BOT_TOKEN ?? null;
    if (this.botToken && !TelegramService.pollingStarted) {
      TelegramService.pollingStarted = true;
      TelegramService.pollingInstance = this;
      this.startPolling();
    }
  }

  get isConfigured(): boolean {
    return !!this.botToken;
  }

  stopPolling(): void {
    this.stopRequested = true;
    if (TelegramService.pollingInstance === this) {
      TelegramService.pollingStarted = false;
      TelegramService.pollingInstance = null;
    }
  }

  private startPolling(): void {
    if (this.polling) return;
    this.polling = true;
    this.stopRequested = false;
    this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopRequested && this.botToken) {
      const start = Date.now();
      try {
        await this.pollUpdates();
      } catch (err) {
        console.error('[Telegram] Poll error:', (err as Error).message);
      }
      const elapsed = Date.now() - start;
      const delay = Math.max(MIN_POLL_DELAY_MS, MAX_POLL_DELAY_MS - elapsed);
      await new Promise(r => setTimeout(r, delay));
    }
    this.polling = false;
  }

  private isOnScanCooldown(chatId: string): boolean {
    const last = this.userCooldowns.get(chatId) ?? 0;
    if (Date.now() - last < SCAN_COOLDOWN_MS) return true;
    this.userCooldowns.set(chatId, Date.now());
    return false;
  }

  private isOnChatCooldown(chatId: string): boolean {
    const last = this.chatCooldowns.get(chatId) ?? 0;
    if (Date.now() - last < CHAT_COOLDOWN_MS) return true;
    this.chatCooldowns.set(chatId, Date.now());
    return false;
  }

  private markProcessed(updateId: number): boolean {
    if (this.processedUpdateIds.has(updateId)) return false;
    this.processedUpdateIds.add(updateId);
    if (this.processedUpdateIds.size > PROCESSED_CACHE_SIZE) {
      const oldest = this.processedUpdateIds.values().next().value;
      if (oldest !== undefined) this.processedUpdateIds.delete(oldest);
    }
    return true;
  }

  private async pollUpdates(): Promise<void> {
    if (!this.botToken) return;

    const res = await fetch(
      `${TELEGRAM_API}${this.botToken}/getUpdates?offset=${this.lastUpdateId + 1}&timeout=5&allowed_updates=["message"]`,
      { signal: AbortSignal.timeout(30_000) },
    );
    const data = await res.json() as {
      ok: boolean;
      result?: Array<{
        update_id: number;
        message?: {
          message_id: number;
          chat: { id: number; first_name?: string };
          text?: string;
          date: number;
        };
      }>;
    };
    if (!data.ok || !data.result || data.result.length === 0) return;

    for (const update of data.result) {
      if (update.update_id > this.lastUpdateId) {
        this.lastUpdateId = update.update_id;
      }

      if (!this.markProcessed(update.update_id)) continue;

      const msg = update.message;
      if (!msg?.text) continue;

      const messageAge = Date.now() / 1000 - msg.date;
      if (messageAge > 120) continue;

      const chatId = String(msg.chat.id);
      const text = msg.text.trim();
      const dedupKey = `${chatId}:${msg.message_id}`;

      if (this.processingMessages.has(dedupKey)) continue;
      this.processingMessages.add(dedupKey);

      try {
        await this.routeMessage(chatId, text, msg.chat.first_name ?? 'there');
      } catch (err) {
        console.error(`[Telegram] Handler error for ${dedupKey}:`, (err as Error).message);
      } finally {
        setTimeout(() => this.processingMessages.delete(dedupKey), 60_000);
      }
    }
  }

  private async routeMessage(chatId: string, text: string, name: string): Promise<void> {
    if (text === '/start') {
      await this.sendMessage(chatId,
        `Namaste ${name}! I'm <b>Chitti</b> — your AI trading companion.\n\n` +
        `Your <b>Chat ID</b> is:\n<code>${chatId}</code>\n\n` +
        `Copy this number, go to <b>Capital Guard Settings → Telegram</b>, paste it, and click <b>Connect</b>.\n\n` +
        `Once connected, you can chat with me in plain English, ask for scans, quotes, and more.\n` +
        `Type <b>/help</b> to see what I can do.`);
      return;
    }

    if (text === '/help') {
      await this.handleHelp(chatId);
      return;
    }

    if (text === '/status') {
      await this.handleSmartStatus(chatId);
      return;
    }

    if (text.startsWith('/scan ')) {
      const symbol = text.slice(6).trim().toUpperCase();
      if (symbol.length >= 2) {
        await this.handleScanCommand(chatId, symbol);
        return;
      }
    }

    if (text.startsWith('/options ')) {
      const symbol = text.slice(9).trim().toUpperCase();
      if (symbol.length >= 2) {
        await this.handleOptionsCommand(chatId, symbol);
        return;
      }
    }

    if (text.startsWith('/quote ')) {
      const symbol = text.slice(7).trim().toUpperCase();
      if (symbol.length >= 2) {
        await this.handleQuoteCommand(chatId, symbol);
        return;
      }
    }

    const lowerText = text.toLowerCase().replace(/[!?.,']/g, '').trim();
    if (GREETING_PATTERNS.has(lowerText)) {
      await this.handleGreeting(chatId, name);
      return;
    }

    const upperText = text.toUpperCase().trim();
    if (KNOWN_SYMBOLS.has(upperText) && !text.startsWith('/')) {
      await this.handleScanCommand(chatId, upperText);
      return;
    }

    if (text.length > 1 && !text.startsWith('/')) {
      await this.handleCommandCenterChat(chatId, text);
      return;
    }
  }

  private async handleGreeting(chatId: string, name: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
      select: { id: true, fullName: true },
    });

    const greeting = CHITTI_GREETINGS[Math.floor(Math.random() * CHITTI_GREETINGS.length)];
    const userName = user?.fullName?.split(' ')[0] ?? name;
    const personalizedGreeting = greeting.replace(/trader/i, userName);

    await this.sendMessage(chatId, `<b>🤖 Chitti</b>\n\n${personalizedGreeting}`);
  }

  private async handleSmartStatus(chatId: string): Promise<void> {
    const user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
      select: { id: true, fullName: true, notifyTelegram: true },
    });

    if (!user) {
      await this.sendMessage(chatId,
        `Not connected to any PaperPort account.\nPaste your Chat ID (<code>${chatId}</code>) in Settings to connect.`);
      return;
    }

    const [portfolio, bots, recentSignals, engineOnline, perfSummary] = await Promise.all([
      this.prisma.portfolio.findFirst({
        where: { userId: user.id },
        select: { currentNav: true, initialCapital: true },
      }),
      this.prisma.tradingBot.findMany({
        where: { userId: user.id },
        select: { name: true, status: true, totalPnl: true, winRate: true, totalTrades: true },
      }),
      this.prisma.aITradeSignal.count({
        where: { userId: user.id, createdAt: { gte: new Date(Date.now() - 24 * 60 * 60_000) } },
      }),
      Promise.resolve(isEngineAvailable()),
      enginePerformanceSummary().catch(() => null),
    ]);

    const lines: string[] = [`<b>Capital Guard Status</b>\n`];
    lines.push(`Account: <b>${user.fullName}</b>`);
    lines.push(`Notifications: ${user.notifyTelegram ? 'ON' : 'OFF'}\n`);

    if (portfolio) {
      const nav = Number(portfolio.currentNav);
      const initial = Number(portfolio.initialCapital);
      const pnl = nav - initial;
      const pnlPct = initial > 0 ? (pnl / initial * 100) : 0;
      lines.push(`NAV: <b>₹${nav.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</b>`);
      lines.push(`P&L: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)\n`);
    }

    if (bots.length > 0) {
      const activeBots = bots.filter(b => b.status === 'ACTIVE');
      lines.push(`Bots: ${activeBots.length}/${bots.length} active`);
      const totalBotPnl = bots.reduce((sum, b) => sum + Number(b.totalPnl ?? 0), 0);
      if (totalBotPnl !== 0) lines.push(`Bot P&L: ${totalBotPnl >= 0 ? '+' : ''}₹${totalBotPnl.toFixed(0)}`);
    }

    lines.push(`Signals (24h): ${recentSignals}`);
    lines.push(`Rust Engine: ${engineOnline ? '<b>ONLINE</b>' : '<b>OFFLINE</b>'}`);

    if (perfSummary) {
      const outcomes = (perfSummary as Record<string, unknown>).total_outcomes ?? 0;
      const health = (perfSummary as Record<string, unknown>).avg_health_score ?? 'N/A';
      lines.push(`Performance: ${outcomes} outcomes tracked, avg health: ${health}`);
    }

    await this.sendMessage(chatId, lines.join('\n'));
  }

  private async handleHelp(chatId: string): Promise<void> {
    await this.sendMessage(chatId,
      `<b>🤖 Chitti — Capital Guard AI</b>\n\n` +
      `I'm your AI trading companion with 20+ years of market wisdom, ` +
      `40+ technical indicators, and strong opinions.\n\n` +
      `<b>Commands:</b>\n` +
      `/scan SYMBOL — Technical analysis (Rust Engine)\n` +
      `/options SYMBOL — Options chain + Greeks\n` +
      `/quote SYMBOL — Live price quote\n` +
      `/status — Portfolio, bots & engine status\n` +
      `/help — This message\n\n` +
      `<b>Smart features:</b>\n` +
      `• Type a stock symbol (e.g. <b>RELIANCE</b>) for instant scan\n` +
      `• Say hello in any language — I speak them all\n` +
      `• Ask anything in plain English — I understand context, query live data, and give you actionable insights\n\n` +
      `<b>Examples:</b>\n` +
      `<i>"Should I buy INFY at current levels?"</i>\n` +
      `<i>"What's the risk on my portfolio?"</i>\n` +
      `<i>"Morning briefing"</i>\n` +
      `<i>"How's NIFTY looking?"</i>`);
  }

  private async handleScanCommand(chatId: string, symbol: string): Promise<void> {
    if (!symbol || symbol.length < 2) {
      await this.sendMessage(chatId, 'Please provide a valid symbol.\n<i>Example: /scan RELIANCE</i>');
      return;
    }
    if (this.isOnScanCooldown(chatId)) {
      await this.sendMessage(chatId, 'Please wait 15 seconds between scan requests.');
      return;
    }

    await this.sendMessage(chatId, `Analyzing <b>${symbol}</b>...`);

    try {
      const candles = await this.fetchCandles(symbol);
      if (!candles || candles.length < 15) {
        await this.sendMessage(chatId, `Not enough data for <b>${symbol}</b>. Check if the symbol is valid.`);
        return;
      }

      if (!isEngineAvailable()) {
        await this.sendMessage(chatId, 'Rust engine is offline. Try again later.');
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
          `<b>${symbol} Analysis</b>\n\n` +
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
        `<b>Rust Engine: ${symbol}</b>\n\n` +
        `${emoji} Direction: <b>${sig.direction}</b>\n` +
        `Confidence: <b>${(sig.confidence * 100).toFixed(0)}%</b>\n\n` +
        `Entry: ₹${sig.entry.toFixed(2)}\n` +
        `Target: ₹${sig.target.toFixed(2)} (${entryPct}%)\n` +
        `Stop Loss: ₹${sig.stop_loss.toFixed(2)} (${slPct}%)\n\n` +
        (indLines.length > 0 ? `<b>Indicators:</b>\n${indLines.join('\n')}\n` : '') +
        (sig.strategy ? `Strategy: ${sig.strategy}` : ''));

    } catch (err) {
      await this.sendMessage(chatId, `Scan failed for <b>${symbol}</b>: ${(err as Error).message}`);
    }
  }

  private async handleOptionsCommand(chatId: string, symbol: string): Promise<void> {
    if (!symbol || symbol.length < 2) {
      await this.sendMessage(chatId, 'Please provide a valid symbol.\n<i>Example: /options NIFTY</i>');
      return;
    }
    if (this.isOnScanCooldown(chatId)) {
      await this.sendMessage(chatId, 'Please wait 15 seconds between requests.');
      return;
    }

    await this.sendMessage(chatId, `Fetching options data for <b>${symbol}</b>...`);

    try {
      const [optData, allSignals] = await Promise.all([
        engineOptionsData(symbol),
        engineOptionsSignals(),
      ]);

      const symbolSignals = allSignals.filter(s => s.symbol === symbol && s.confidence >= 0.5);

      if (!optData && symbolSignals.length === 0) {
        await this.sendMessage(chatId,
          `No options data available for <b>${symbol}</b>.\n\n` +
          `Options data is available for major F&O symbols (NIFTY, BANKNIFTY, RELIANCE, etc.).`);
        return;
      }

      const lines: string[] = [`<b>Options Analysis: ${symbol}</b>\n`];

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
      await this.sendMessage(chatId, `Options analysis failed for <b>${symbol}</b>: ${(err as Error).message}`);
    }
  }

  private async handleQuoteCommand(chatId: string, symbol: string): Promise<void> {
    if (!symbol || symbol.length < 2) {
      await this.sendMessage(chatId, 'Please provide a valid symbol.\n<i>Example: /quote TCS</i>');
      return;
    }
    if (this.isOnScanCooldown(chatId)) {
      await this.sendMessage(chatId, 'Please wait 15 seconds between requests.');
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
        await this.sendMessage(chatId, `No quote data for <b>${symbol}</b>. Check if the symbol is valid.`);
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
      await this.sendMessage(chatId, `Quote failed for <b>${symbol}</b>: ${(err as Error).message}`);
    }
  }

  private async handleCommandCenterChat(chatId: string, text: string): Promise<void> {
    if (this.isOnChatCooldown(chatId)) {
      return;
    }

    const user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
      select: { id: true },
    });
    if (!user) {
      await this.sendMessage(chatId,
        '🤖 Not connected to any Capital Guard account yet.\n\n' +
        `Your Chat ID: <code>${chatId}</code>\nPaste this in <b>Settings → Telegram</b> to connect.`);
      return;
    }

    await this.sendMessage(chatId, '🤖 <i>Chitti is analyzing...</i>');

    try {
      const result = await processCommandCenterChat(user.id, text);
      const response = result.content || 'Hmm, I could not form a response. Try rephrasing or ask me something specific.';
      const maxLen = 3900;
      const branded = `<b>🤖 Chitti</b>\n\n${response}`;
      if (branded.length > maxLen) {
        await this.sendMessage(chatId, branded.slice(0, maxLen) + '\n\n<i>...message trimmed</i>');
      } else {
        await this.sendMessage(chatId, branded);
      }
    } catch (err) {
      console.error('[Telegram] Command center error:', (err as Error).message);
      await this.sendMessage(chatId, '🤖 Something went wrong on my end. Give me a moment and try again.');
    }
  }

  private async fetchCandles(symbol: string): Promise<Array<{ open: number; high: number; low: number; close: number; volume: number; timestamp: string }>> {
    try {
      const fromDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
      const toDate = new Date().toISOString().split('T')[0];
      const url = `${BRIDGE_URL}/historical/${encodeURIComponent(symbol)}?interval=5minute&from=${fromDate}&to=${toDate}`;

      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
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

  // ─── Public API (unchanged signatures) ──────────────────────────────

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
      select: { telegramChatId: true, notifyTelegram: true },
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
      ? 'Rust Engine' : 'AI Bot';
    const entryLine = entry > 0 ? `\nEntry: ₹${entry.toFixed(2)}` : '';
    const targetLine = target > 0 ? ` | Target: ₹${target.toFixed(2)}` : '';
    const slLine = stopLoss > 0 ? ` | SL: ₹${stopLoss.toFixed(2)}` : '';

    return this.notifyUser(userId, `${sourceTag} Signal`,
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
      `<b>Rust Engine Signal</b>\n\n` +
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
    return this.notifyUser(userId, `Risk Alert: ${alertType}`, message);
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
        '<b>PaperPort Connected!</b>\n\nYou will now receive trade alerts, signals, and daily reports here.');
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
