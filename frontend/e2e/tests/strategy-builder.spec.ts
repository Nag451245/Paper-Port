import { test, expect } from '@playwright/test';

test.describe('Strategy Builder Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/strategy-builder');
  });

  test('should display the Strategy Builder heading', async ({ page }) => {
    await expect(page.locator('text=Strategy Builder')).toBeVisible();
  });

  test('should show strategy template cards', async ({ page }) => {
    await expect(page.locator('text=Strategy Templates')).toBeVisible();
    await expect(page.locator('text=Bull Call Spread')).toBeVisible();
  });

  test('should show category filter buttons', async ({ page }) => {
    await expect(page.locator('button:has-text("All")')).toBeVisible();
    await expect(page.locator('button:has-text("Bullish")')).toBeVisible();
    await expect(page.locator('button:has-text("Bearish")')).toBeVisible();
  });

  test('should load a template when clicked', async ({ page }) => {
    await page.click('text=Bull Call Spread');
    await expect(page.locator('text=Strategy Legs')).toBeVisible();
    const rows = page.locator('table tbody tr, [role="row"]');
    await expect(rows.first()).toBeVisible();
  });

  test('should show payoff diagram section', async ({ page }) => {
    await expect(page.locator('text=Payoff Diagram')).toBeVisible();
  });

  test('should show Greeks panel', async ({ page }) => {
    await expect(page.locator('text=Greeks')).toBeVisible();
  });
});
