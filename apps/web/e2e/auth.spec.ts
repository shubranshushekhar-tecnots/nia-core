import { test, expect } from '@playwright/test';

// These tests exercise the auth UI, client/server Zod validation, and the
// middleware's redirect boundary without creating persistent Supabase auth
// users (no service-role key is available to apps/web by design — see
// lib/supabase/*). A full "real login" happy path requires a seeded,
// email-confirmed test account provisioned out-of-band via a service-role
// script, not created ad hoc by this suite.

test.describe('middleware redirect boundary', () => {
  test('unauthenticated user hitting a private route is redirected to /login with ?next=', async ({ page }) => {
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/login\?next=%2Fonboarding/);
  });

  test('public auth routes are reachable without a session', async ({ page }) => {
    for (const path of ['/login', '/signup', '/forgot-password']) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
    }
  });
});

test.describe('login form', () => {
  test('renders and shows a validation error for a malformed email', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

    await page.locator('#email').fill('not-an-email');
    await page.locator('#password').fill('whatever');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();

    await expect(page.getByText(/valid email/i)).toBeVisible();
  });

  test('links to /signup', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Create an account' }).click();
    await expect(page).toHaveURL(/\/signup$/);
  });
});

test.describe('signup form', () => {
  test('renders and shows validation errors for short password', async ({ page }) => {
    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();

    await page.locator('#fullName').fill('Test User');
    await page.locator('#email').fill('test@example.com');
    await page.locator('#password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();

    await expect(page.getByText(/8 characters/i)).toBeVisible();
  });

  test('links back to /login', async ({ page }) => {
    await page.goto('/signup');
    await page.getByRole('link', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('forgot password form', () => {
  test('always shows the success state (never reveals account existence)', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.locator('#email').fill('someone-who-may-not-exist@example.com');
    await page.getByRole('button', { name: 'Send reset link' }).click();

    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  });
});

test.describe('theme toggle', () => {
  test('persists dark/light choice to localStorage and updates data-om-theme', async ({ page }) => {
    await page.goto('/login');
    const root = page.locator('[data-auth-theme]');
    await expect(root).toHaveAttribute('data-om-theme', 'light');

    await page.getByRole('button', { name: /switch to dark theme/i }).click();
    await expect(root).toHaveAttribute('data-om-theme', 'dark');

    const stored = await page.evaluate(() => window.localStorage.getItem('nia-om-theme'));
    expect(stored).toBe('dark');
  });
});
