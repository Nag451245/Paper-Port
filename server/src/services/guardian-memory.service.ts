import type { GuardianMemory, PrismaClient } from '@prisma/client';

export type GuardianMemoryType =
  | 'conversation'
  | 'market_opinion'
  | 'trade_lesson'
  | 'user_preference'
  | 'evolving_view'
  | 'pattern_observed';

export type GuardianMemorySummary = Record<GuardianMemoryType, number>;

export interface StoreMemoryOptions {
  importance?: number;
  sentiment?: number;
  expiresAt?: Date | null;
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'been',
  'being',
  'before',
  'after',
  'above',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'he',
  'her',
  'here',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'me',
  'more',
  'most',
  'my',
  'no',
  'nor',
  'not',
  'of',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
]);

function extractQueryKeywords(query: string): string[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter((t) => t.length > 0 && !STOP_WORDS.has(t));

  if (tokens.length > 0) return [...new Set(tokens)];

  const fallback = query.trim();
  return fallback.length > 0 ? [fallback.toLowerCase()] : [];
}

function notExpiredFilter(): { OR: Array<{ expiresAt: null } | { expiresAt: { gt: Date } }> } {
  return {
    OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
  };
}

export class GuardianMemoryService {
  constructor(private readonly prisma: PrismaClient) {}

  async storeMemory(
    userId: string,
    type: GuardianMemoryType,
    subject: string,
    content: string,
    opts?: StoreMemoryOptions,
  ): Promise<GuardianMemory> {
    if (type === 'evolving_view') {
      const existing = await this.prisma.guardianMemory.findFirst({
        where: { userId, subject, memoryType: 'evolving_view' },
      });

      if (existing) {
        return this.prisma.guardianMemory.update({
          where: { id: existing.id },
          data: {
            content,
            ...(opts?.sentiment !== undefined ? { sentiment: opts.sentiment } : {}),
            ...(opts?.importance !== undefined ? { importance: opts.importance } : {}),
            ...(opts?.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
          },
        });
      }
    }

    return this.prisma.guardianMemory.create({
      data: {
        userId,
        memoryType: type,
        subject,
        content,
        sentiment: opts?.sentiment ?? 0,
        importance: opts?.importance ?? 0.5,
        expiresAt: opts?.expiresAt ?? null,
      },
    });
  }

  async recallRelevant(userId: string, query: string, limit = 5): Promise<GuardianMemory[]> {
    const keywords = extractQueryKeywords(query);
    if (keywords.length === 0) return [];

    const keywordOr = keywords.flatMap((keyword) => [
      { subject: { contains: keyword, mode: 'insensitive' as const } },
      { content: { contains: keyword, mode: 'insensitive' as const } },
    ]);

    return this.prisma.guardianMemory.findMany({
      where: {
        userId,
        AND: [{ OR: keywordOr }, notExpiredFilter()],
      },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    });
  }

  async getRecentConversationContext(userId: string, limit = 10): Promise<GuardianMemory[]> {
    return this.prisma.guardianMemory.findMany({
      where: {
        userId,
        memoryType: 'conversation',
        AND: [notExpiredFilter()],
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getActiveOpinions(userId: string): Promise<GuardianMemory[]> {
    return this.prisma.guardianMemory.findMany({
      where: {
        userId,
        memoryType: { in: ['market_opinion', 'evolving_view'] },
        AND: [notExpiredFilter()],
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }

  async evolveView(
    userId: string,
    subject: string,
    newContent: string,
    sentiment?: number,
  ): Promise<GuardianMemory> {
    const existing = await this.prisma.guardianMemory.findFirst({
      where: { userId, subject, memoryType: 'evolving_view' },
    });

    if (existing) {
      return this.prisma.guardianMemory.update({
        where: { id: existing.id },
        data: {
          content: newContent,
          ...(sentiment !== undefined ? { sentiment } : {}),
        },
      });
    }

    return this.prisma.guardianMemory.create({
      data: {
        userId,
        memoryType: 'evolving_view',
        subject,
        content: newContent,
        sentiment: sentiment ?? 0,
        importance: 0.5,
      },
    });
  }

  async storeTradeLesson(
    userId: string,
    symbol: string,
    lesson: string,
    importance = 0.6,
  ): Promise<GuardianMemory> {
    return this.prisma.guardianMemory.create({
      data: {
        userId,
        memoryType: 'trade_lesson',
        subject: symbol,
        content: lesson,
        importance,
      },
    });
  }

  async getUserPreferences(userId: string): Promise<GuardianMemory[]> {
    return this.prisma.guardianMemory.findMany({
      where: { userId, memoryType: 'user_preference' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async pruneExpired(): Promise<number> {
    const result = await this.prisma.guardianMemory.deleteMany({
      where: {
        expiresAt: { not: null, lt: new Date() },
      },
    });
    return result.count;
  }

  async getMemorySummary(userId: string): Promise<GuardianMemorySummary> {
    const empty: GuardianMemorySummary = {
      conversation: 0,
      market_opinion: 0,
      trade_lesson: 0,
      user_preference: 0,
      evolving_view: 0,
      pattern_observed: 0,
    };

    const rows = await this.prisma.guardianMemory.groupBy({
      by: ['memoryType'],
      where: { userId },
      _count: { _all: true },
    });

    for (const row of rows) {
      const key = row.memoryType as GuardianMemoryType;
      if (key in empty) {
        empty[key] = row._count._all;
      }
    }

    return empty;
  }
}
