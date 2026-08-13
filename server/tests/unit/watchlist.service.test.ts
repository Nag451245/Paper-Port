import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WatchlistService, WatchlistError } from '../../src/services/watchlist.service.js';

function createMockPrisma() {
  return {
    watchlist: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    watchlistItem: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  } as any;
}

describe('WatchlistService', () => {
  let service: WatchlistService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    service = new WatchlistService(mockPrisma);
  });

  describe('list', () => {
    it('should return watchlists with items', async () => {
      mockPrisma.watchlist.findMany.mockResolvedValue([
        { id: 'w1', name: 'My Watchlist', items: [{ symbol: 'RELIANCE' }] },
      ]);

      const result = await service.list('user1');

      expect(result).toHaveLength(1);
      expect(result[0].items).toHaveLength(1);
    });
  });

  describe('create', () => {
    it('should create a watchlist', async () => {
      mockPrisma.watchlist.create.mockResolvedValue({
        id: 'w-new',
        name: 'New Watchlist',
        items: [],
      });

      const result = await service.create('user1', 'New Watchlist');

      expect(result.name).toBe('New Watchlist');
      expect(mockPrisma.watchlist.create).toHaveBeenCalledWith({
        data: { userId: 'user1', name: 'New Watchlist' },
        include: { items: true },
      });
    });
  });

  describe('getById', () => {
    it('should return watchlist if owned by user', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1',
        userId: 'user1',
        name: 'My Watchlist',
        items: [],
      });

      const result = await service.getById('w1', 'user1');

      expect(result.id).toBe('w1');
    });

    it('should throw 404 if not found', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue(null);

      await expect(service.getById('nonexistent', 'user1')).rejects.toThrow(WatchlistError);
    });

    it('should throw 404 if owned by another user', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1',
        userId: 'other-user',
        items: [],
      });

      await expect(service.getById('w1', 'user1')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('addItem', () => {
    it('should add a new item to watchlist', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1',
        userId: 'user1',
        items: [],
      });
      mockPrisma.watchlistItem.findFirst.mockResolvedValue(null);
      mockPrisma.watchlistItem.create.mockResolvedValue({
        id: 'item-1',
        symbol: 'TCS',
        exchange: 'NSE',
      });

      const result = await service.addItem('w1', 'user1', 'TCS', 'NSE');

      expect(result.symbol).toBe('TCS');
    });

    it('should throw 409 if symbol already exists', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1',
        userId: 'user1',
        items: [],
      });
      mockPrisma.watchlistItem.findFirst.mockResolvedValue({ id: 'existing', symbol: 'TCS' });

      await expect(service.addItem('w1', 'user1', 'TCS', 'NSE')).rejects.toMatchObject({
        statusCode: 409,
        message: 'Symbol already in watchlist',
      });
    });
  });

  describe('removeItem', () => {
    it('should remove item from watchlist', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1',
        userId: 'user1',
        items: [],
      });
      mockPrisma.watchlistItem.findUnique.mockResolvedValue({
        id: 'item-1',
        watchlistId: 'w1',
      });
      mockPrisma.watchlistItem.delete.mockResolvedValue({ id: 'item-1' });

      await service.removeItem('w1', 'item-1', 'user1');

      expect(mockPrisma.watchlistItem.delete).toHaveBeenCalledWith({ where: { id: 'item-1' } });
    });

    it('should throw 404 if item not found', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1',
        userId: 'user1',
        items: [],
      });
      mockPrisma.watchlistItem.findUnique.mockResolvedValue(null);

      await expect(service.removeItem('w1', 'nonexistent', 'user1')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('should throw 404 if item belongs to different watchlist', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1',
        userId: 'user1',
        items: [],
      });
      mockPrisma.watchlistItem.findUnique.mockResolvedValue({
        id: 'item-1',
        watchlistId: 'w-other',
      });

      await expect(service.removeItem('w1', 'item-1', 'user1')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('deleteWatchlist', () => {
    it('should delete watchlist', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1',
        userId: 'user1',
        items: [],
      });
      mockPrisma.watchlist.delete.mockResolvedValue({ id: 'w1' });

      await service.deleteWatchlist('w1', 'user1');

      expect(mockPrisma.watchlist.delete).toHaveBeenCalledWith({ where: { id: 'w1' } });
    });
  });
});
