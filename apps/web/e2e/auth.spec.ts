import { test, expect } from '@playwright/test';

// These tests exercise the auth UI and client/server Zod validation, and the
// middleware's redirect boundary, without creating persistent Better Auth
// users ad hoc — a full "real login" happy path instead uses a seeded test
// account (apps/api/src/scripts/seedFixtureUsers.ts), driven by
// auth.setup.ts / fixtures/personas.ts.

test.describe('middleware redirect boundary', () => {
  test('unauthenticated user hitting a private route is redirected to /login with ?next=', async ({ page }) => {
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/login\?next=%2Fonboarding/);
  });

  test('public auth routes are reachable without a session', async ({ page }) => {
    for (const path of ['/login', '/signup']) {
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
