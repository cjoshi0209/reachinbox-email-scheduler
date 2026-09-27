import path from 'node:path';
import { expect, test } from '@playwright/test';

const LEADS = path.resolve(__dirname, '../../samples/leads.csv');

test.describe('unauthenticated', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('redirects to the login page, which offers Google login', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Login with Google' })).toHaveAttribute('href', '/auth/google');
  });
});

test.describe.serial('authenticated dashboard', () => {
  const subject = `E2E campaign ${Date.now()}`;

  test('shows the user in the header and empty states', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('user-name')).toHaveText('Test User');
    await expect(page.getByTestId('user-email')).toHaveText(/^e2e-\d+@example\.com$/);
    await expect(page.getByTestId('empty-state')).toContainText('No scheduled emails');
    await page.getByRole('link', { name: 'Sent' }).click();
    await expect(page.getByTestId('empty-state')).toContainText('No sent emails yet');
  });

  test('compose validates required fields', async ({ page }) => {
    await page.goto('/compose');
    await page.getByTestId('submit-schedule').click();
    await expect(page.getByRole('alert').first()).toContainText('Add at least one recipient');
  });

  test('uploads a CSV, detects emails and schedules them', async ({ page }) => {
    await page.goto('/compose');
    await expect(page.getByTestId('sender-select')).toContainText('@ethereal.email');
    await page.getByTestId('csv-input').setInputFiles(LEADS);
    await expect(page.getByTestId('recipient-count')).toHaveText('7');
    await expect(page.getByTestId('upload-summary')).toContainText('7 emails detected in leads.csv, 1 duplicate removed, 1 invalid skipped');
    await expect(page.getByTestId('recipient-chips')).toContainText('+4');

    await page.getByLabel('Subject').fill(subject);
    await page.getByLabel('Email body').fill('Hi there,\nThis was scheduled by the Playwright suite.');
    await page.locator('#delay').fill('1');
    await page.locator('#hourly').fill('100');
    await page.getByTestId('submit-schedule').click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByText(/Scheduled 7 emails/)).toBeVisible();
    await expect(page.getByTestId('count-scheduled')).not.toHaveText('');
  });

  test('the worker sends them; they move to Sent with Ethereal previews', async ({ page }) => {
    await page.goto('/dashboard/sent');
    // 7 emails, >= 2s apart (MIN_EMAIL_DELAY_MS) via real Ethereal SMTP.
    await expect(page.locator('[data-testid=email-row][data-status=sent]')).toHaveCount(7, { timeout: 90_000 });
    await expect(page.getByTestId('count-sent')).toHaveText('7');
    await page.goto('/dashboard');
    await expect(page.getByTestId('empty-state')).toBeVisible();

    await page.goto('/dashboard/sent');
    await page.locator('[data-testid=email-row]').first().click();
    await expect(page.getByRole('heading', { name: subject })).toBeVisible();
    await expect(page.getByRole('link', { name: /Open in Ethereal/ })).toHaveAttribute('href', /^https:\/\/ethereal\.email\/message\//);
  });

  test('search (Elasticsearch) finds emails by recipient and subject', async ({ page }) => {
    await page.goto('/dashboard/sent');
    await page.getByLabel('Search emails').fill('dame@jmail.com');
    await expect(page.getByTestId('search-summary')).toContainText('1 result');
    await expect(page.getByTestId('row-recipient')).toHaveText('dame@jmail.com');
    await page.getByLabel('Search emails').fill(subject);
    await expect(page.getByTestId('search-summary')).toContainText('7 results');
    await page.getByLabel('Search emails').fill('zzzz-no-such-thing');
    await expect(page.getByText('No matching emails')).toBeVisible();
  });

  test('is usable on a phone-sized screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard/sent');
    await expect(page.locator('[data-testid=email-row]').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('link', { name: 'Compose' }).click();
    await expect(page.getByRole('heading', { name: 'Compose New Email' })).toBeVisible();
  });

  test('logout returns to the login page and protects the dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByTestId('user-menu').click();
    await page.getByRole('menuitem', { name: 'Logout' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/login$/);
  });
});
