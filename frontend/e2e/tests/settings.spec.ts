import { test, expect } from '@playwright/test';

test.describe('Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
  });

  test('should display Settings heading', async ({ page }) => {
    await expect(page.locator('h1:has-text("Settings"), text=Settings').first()).toBeVisible();
  });

  test('should show Breeze API Credentials section', async ({ page }) => {
    await expect(page.locator('text=/Breeze API/i')).toBeVisible();
  });

  test('should show API Key input field', async ({ page }) => {
    await expect(page.locator('input[placeholder*="API" i]').first()).toBeVisible();
  });

  test('should show Virtual Capital section', async ({ page }) => {
    await expect(page.locator('text=/Virtual Capital/i')).toBeVisible();
  });

  test('should show Configuration and Setup Guide tabs', async ({ page }) => {
    await expect(page.locator('text=Configuration')).toBeVisible();
    await expect(page.locator('text=/Setup Guide/i')).toBeVisible();
  });
});
