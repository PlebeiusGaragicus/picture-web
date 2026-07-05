import { expect, test, type Page } from '@playwright/test';

/** Console messages that are known noise and safe to ignore. Keep empty unless justified. */
const CONSOLE_ERROR_ALLOWLIST: RegExp[] = [];

const errors: string[] = [];

test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (CONSOLE_ERROR_ALLOWLIST.some((pattern) => pattern.test(message.text()))) return;
    errors.push(message.text());
  });
  page.on('pageerror', (error) => {
    errors.push(String(error));
  });
});

test.afterEach(() => {
  expect(errors, 'no console/page errors').toEqual([]);
});

async function openFixtureProject(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: 'E2E Fixture' }).click();
  await expect(page.locator('.project-phase-sidebar')).toBeVisible();
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(400);
}

test('landing shows the fixture project', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'E2E Fixture' })).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot('landing.png');
});

test('story view', async ({ page }) => {
  await openFixtureProject(page);
  await page.getByRole('button', { name: 'Story', exact: true }).click();
  await expect(page.locator('.canvas')).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot('story.png');
});

test('layout view', async ({ page }) => {
  await openFixtureProject(page);
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await settle(page);
  await expect(page).toHaveScreenshot('layout.png');
});

test('canvas view with node sidebar interaction', async ({ page }) => {
  await openFixtureProject(page);
  await page.getByRole('button', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.react-flow')).toBeVisible();
  await settle(page);
  // One real interaction: open a node's image viewer, then close it with Escape.
  await page.locator('.image-group-node').first().click();
  await expect(page.locator('.image-viewer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.image-viewer')).toHaveCount(0);
  await page.locator('.react-flow__pane').click({ position: { x: 60, y: 60 } });
  await settle(page);
  await expect(page).toHaveScreenshot('canvas.png');
});

test('concept art view', async ({ page }) => {
  await openFixtureProject(page);
  await page.getByRole('button', { name: 'Concept Art', exact: true }).click();
  await settle(page);
  await expect(page).toHaveScreenshot('concept-art.png');
});

test('characters view', async ({ page }) => {
  await openFixtureProject(page);
  await page.getByRole('button', { name: 'Characters', exact: true }).click();
  await settle(page);
  await expect(page).toHaveScreenshot('characters.png');
});

test('agent view', async ({ page }) => {
  await openFixtureProject(page);
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await settle(page);
  await expect(page).toHaveScreenshot('agent.png');
});
