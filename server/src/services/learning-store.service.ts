import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync, rmSync } from 'fs';
import { resolve, join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const LEARNING_DIR = resolve(__dirname, '..', '..', '..', 'learning');
const MAX_SIZE_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB
const PRUNE_KEEP_DAYS = 90;

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function dateStr(date: Date): string {
  return date.toISOString().split('T')[0];
}

export class LearningStoreService {
  constructor() {
    ensureDir(LEARNING_DIR);
    ensureDir(join(LEARNING_DIR, 'daily-reports'));
    ensureDir(join(LEARNING_DIR, 'trade-reviews'));
    ensureDir(join(LEARNING_DIR, 'false-positives'));
    ensureDir(join(LEARNING_DIR, 'strategy-evolution'));
    ensureDir(join(LEARNING_DIR, 'regime-log'));
  }

  async writeDailyReport(date: Date, data: unknown): Promise<void> {
    const filePath = join(LEARNING_DIR, 'daily-reports', `${dateStr(date)}.json`);
    writeFileSync(filePath, JSON.stringify(data, null, 2));
    this.checkAndPrune();
  }

  async writeTradeReview(date: Date, tradeId: string, data: unknown): Promise<void> {
    const dir = join(LEARNING_DIR, 'trade-reviews', dateStr(date));
    ensureDir(dir);
    writeFileSync(join(dir, `${tradeId}.json`), JSON.stringify(data, null, 2));
  }

  async writeFalsePositives(date: Date, data: unknown): Promise<void> {
    const filePath = join(LEARNING_DIR, 'false-positives', `${dateStr(date)}.json`);
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  async writeStrategyEvolution(strategyId: string, data: unknown): Promise<void> {
    const filePath = join(LEARNING_DIR, 'strategy-evolution', `${strategyId}.json`);

    let history: unknown[] = [];
    if (existsSync(filePath)) {
      try {
        history = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch { history = []; }
    }

    history.push({ timestamp: new Date().toISOString(), ...data as object });

    // Keep last 365 entries
    if (history.length > 365) history = history.slice(-365);

    writeFileSync(filePath, JSON.stringify(history, null, 2));
  }

  async writeRegimeLog(date: Date, regime: string, data: unknown): Promise<void> {
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const filePath = join(LEARNING_DIR, 'regime-log', `${monthKey}.json`);

    let log: unknown[] = [];
    if (existsSync(filePath)) {
      try {
        log = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch { log = []; }
    }

    log.push({ date: dateStr(date), regime, ...data as object });
    writeFileSync(filePath, JSON.stringify(log, null, 2));
  }

  async readDailyReport(date: Date): Promise<unknown | null> {
    const filePath = join(LEARNING_DIR, 'daily-reports', `${dateStr(date)}.json`);
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  }

  readRecentFalsePositives(days = 30): Array<{
    date: string;
    signals: Array<{ symbol: string; type: string; confidence: number; status: string; outcome: string | null }>;
  }> {
    const fpDir = join(LEARNING_DIR, 'false-positives');
    if (!existsSync(fpDir)) return [];

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = dateStr(cutoff);

    const results: Array<{
      date: string;
      signals: Array<{ symbol: string; type: string; confidence: number; status: string; outcome: string | null }>;
    }> = [];

    for (const file of readdirSync(fpDir).filter(f => f.endsWith('.json'))) {
      const name = file.replace('.json', '');
      if (name < cutoffStr) continue;
      try {
        const data = JSON.parse(readFileSync(join(fpDir, file), 'utf-8'));
        if (data?.signals) {
          results.push({ date: name, signals: data.signals });
        }
      } catch { /* skip corrupted files */ }
    }
    return results;
  }

  getTotalSize(): number {
    return this.dirSize(LEARNING_DIR);
  }

  getMetaSummary(): { totalSizeMB: number; fileCount: number; oldestDate: string | null } {
    const totalSize = this.getTotalSize();
    const reportDir = join(LEARNING_DIR, 'daily-reports');
    let fileCount = 0;
    let oldestDate: string | null = null;

    if (existsSync(reportDir)) {
      const files = readdirSync(reportDir).filter(f => f.endsWith('.json')).sort();
      fileCount = files.length;
      if (files.length > 0) oldestDate = files[0].replace('.json', '');
    }

    return {
      totalSizeMB: Math.round(totalSize / (1024 * 1024)),
      fileCount,
      oldestDate,
    };
  }

  private checkAndPrune(): void {
    const totalSize = this.getTotalSize();
    if (totalSize < MAX_SIZE_BYTES * 0.9) return; // Under 90% threshold

    console.log(`[LearningStore] Size ${(totalSize / 1024 / 1024).toFixed(0)}MB approaching ${MAX_SIZE_BYTES / 1024 / 1024}MB limit, pruning...`);

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - PRUNE_KEEP_DAYS);
    const cutoffStr = dateStr(cutoffDate);

    // Prune daily reports older than 90 days
    this.pruneDirectory(join(LEARNING_DIR, 'daily-reports'), cutoffStr);

    // Prune false positives older than 90 days
    this.pruneDirectory(join(LEARNING_DIR, 'false-positives'), cutoffStr);

    // Prune trade review directories older than 30 days
    const tradeReviewDir = join(LEARNING_DIR, 'trade-reviews');
    if (existsSync(tradeReviewDir)) {
      const cutoff30 = new Date();
      cutoff30.setDate(cutoff30.getDate() - 30);
      const cutoff30Str = dateStr(cutoff30);

      for (const dir of readdirSync(tradeReviewDir)) {
        if (dir < cutoff30Str) {
          try {
            rmSync(join(tradeReviewDir, dir), { recursive: true, force: true });
          } catch { /* skip */ }
        }
      }
    }

    const newSize = this.getTotalSize();
    console.log(`[LearningStore] Pruned to ${(newSize / 1024 / 1024).toFixed(0)}MB`);
  }

  private pruneDirectory(dir: string, cutoffStr: string): void {
    if (!existsSync(dir)) return;
    for (const file of readdirSync(dir)) {
      const name = file.replace('.json', '');
      if (name < cutoffStr) {
        try { unlinkSync(join(dir, file)); } catch { /* skip */ }
      }
    }
  }

  private dirSize(dirPath: string): number {
    if (!existsSync(dirPath)) return 0;
    let total = 0;
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += this.dirSize(fullPath);
      } else {
        try { total += statSync(fullPath).size; } catch { /* skip */ }
      }
    }
    return total;
  }
}
