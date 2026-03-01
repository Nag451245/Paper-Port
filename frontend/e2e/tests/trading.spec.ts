import { test, expect } from '@playwright/test';

test.describe('Trading Terminal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/terminal');
  });

  test('should display trading terminal UI', async ({ page }) => {
    await expect(page.locator('text=/Select a Symbol|PLACE ORDER/i')).toBeVisible();
  });

  test('should show exchange tabs', async ({ page }) => {
    await expect(page.locator('text=/All Markets|NSE/i').first()).toBeVisible();
  });

  test('should show BUY and SELL buttons', async ({ page }) => {
    await expect(page.locator('button:has-text("BUY")').first()).toBeVisible();
    await expect(page.locator('button:has-text("SELL")').first()).toBeVisible();
  });

  test('should have positions/orders/trades tabs', async ({ page }) => {
    await expect(page.locator('text=Positions')).toBeVisible();
    await expect(page.locator('text=Orders')).toBeVisible();
    await expect(page.locator('text=Trades')).toBeVisible();
  });

  test('should search for a symbol', async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="Search" i], input[placeholder*="symbol" i]').first();
    if (await searchInput.isVisible()) {
      await searchInput.fill('RELIANCE');
      await page.waitForTimeout(1000);
    }
  });
});
