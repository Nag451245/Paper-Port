import { test, expect } from '@playwright/test';

test.describe('Sidebar Navigation', () => {
  test('should load dashboard page', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('text=Dashboard')).toBeVisible();
  });

  test('should navigate to Trading Terminal', async ({ page }) => {
    await page.goto('/dashboard');
    await page.click('text=Trading Terminal');
    await expect(page).toHaveURL(/terminal/);
    await expect(page.locator('text=/Select a Symbol|PLACE ORDER/i')).toBeVisible();
  });

  test('should navigate to AI Agent', async ({ page }) => {
    await page.goto('/dashboard');
    await page.click('text=AI Agent');
    await expect(page).toHaveURL(/ai-agent/);
  });

  test('should navigate to Bot Team', async ({ page }) => {
    await page.goto('/dashboard');
    await page.click('text=Bot Team');
    await expect(page).toHaveURL(/bots/);
  });

  test('should navigate to Strategy Builder', async ({ page }) => {
    await page.goto('/dashboard');
    await page.click('text=Strategy Builder');
    await expect(page).toHaveURL(/strategy-builder/);
    await expect(page.locator('text=Strategy Builder')).toBeVisible();
  });

  test('should navigate to Option Chain', async ({ page }) => {
    await page.goto('/dashboard');
    await page.click('text=Option Chain');
    await expect(page).toHaveURL(/option-chain/);
    await expect(page.locator('text=Option Chain')).toBeVisible();
  });

  test('should navigate to F&O Analytics', async ({ page }) => {
    await page.goto('/dashboard');
    await page.click('text=/F&O Analytics|F&O/');
    await expect(page).toHaveURL(/fno-analytics/);
  });

  test('should navigate to Portfolio', async ({ page }) => {
    await page.goto('/dashboard');
    await page.click('text=Portfolio');
    await expect(page).toHaveURL(/portfolio/);
  });

  test('should navigate to Settings', async ({ page }) => {
    await page.goto('/dashboard');
    await page.click('text=Settings');
    await expect(page).toHaveURL(/settings/);
    await expect(page.locator('text=Settings')).toBeVisible();
  });
});
