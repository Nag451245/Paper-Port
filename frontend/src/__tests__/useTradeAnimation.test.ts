import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireProfitConfetti, fireLossAnimation } from '../hooks/useTradeAnimation';

// Mock canvas-confetti
vi.mock('canvas-confetti', () => ({
    default: vi.fn(),
}));

describe('useTradeAnimation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe('fireProfitConfetti', () => {
        it('should fire initial confetti immediately', async () => {
            const confetti = (await import('canvas-confetti')).default;
            fireProfitConfetti();

            expect(confetti).toHaveBeenCalledTimes(1);
            expect(confetti).toHaveBeenCalledWith(expect.objectContaining({
                particleCount: 100,
                colors: ['#10b981', '#34d399', '#6ee7b7', '#059669', '#047857']
            }));
        });

        it('should fire secondary confetti after delay', async () => {
            const confetti = (await import('canvas-confetti')).default;
            fireProfitConfetti();

            // Advance timers to trigger the setTimeout
            vi.advanceTimersByTime(200);

            // Initial + 2 secondary bursts
            expect(confetti).toHaveBeenCalledTimes(3);
        });
    });

    describe('fireLossAnimation', () => {
        it('should add and remove shake class on target element', () => {
            // Mock DOM element
            const mockElement = document.createElement('div');
            mockElement.id = 'trade-result-card';
            document.body.appendChild(mockElement);

            fireLossAnimation();

            expect(mockElement.classList.contains('animate-loss-shake')).toBe(true);

            // Fast forward past the 600ms timeout
            vi.advanceTimersByTime(600);

            expect(mockElement.classList.contains('animate-loss-shake')).toBe(false);

            // Cleanup
            document.body.removeChild(mockElement);
        });

        it('should handle missing element gracefully', () => {
            // Ensure element doesn't exist
            const el = document.getElementById('trade-result-card');
            if (el) document.body.removeChild(el);

            // Should not throw
            expect(() => fireLossAnimation()).not.toThrow();
        });
    });
});
