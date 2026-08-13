import { test as setup, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const authDir = path.join(__dirname, '.auth');
const authFile = path.join(authDir, 'user.json');

const TEST_EMAIL = 'e2e-test@paperport.test';
const TEST_PASSWORD = 'TestP@ss123!';
const TEST_NAME = 'E2E Tester';

setup('authenticate', async ({ page }) => {
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  await page.goto('/login');

  // Try login first
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page.click('button:has-text("Sign In")');

  // Wait for navigation or error
  const response = await Promise.race([
    page.waitForURL('**/dashboard', { timeout: 5000 }).then(() => 'success'),
    page.waitForSelector('text=/Invalid|Not Found|error/i', { timeout: 5000 }).then(() => 'error'),
  ]).catch(() => 'timeout');

  if (response !== 'success') {
    // Register new account
    await page.goto('/register');
    await page.fill('input[placeholder*="name" i], input[name="fullName"]', TEST_NAME);
    await page.fill('input[type="email"]', TEST_EMAIL);

    const passwordInputs = page.locator('input[type="password"]');
    await passwordInputs.first().fill(TEST_PASSWORD);
    if (await passwordInputs.count() > 1) {
      await passwordInputs.nth(1).fill(TEST_PASSWORD);
    }

    await page.click('button:has-text("Create Account")');
    await page.waitForURL('**/dashboard', { timeout: 10000 });
  }

  await expect(page.locator('text=/Dashboard|Portfolio/i').first()).toBeVisible({ timeout: 5000 });

  await page.context().storageState({ path: authFile });
});
