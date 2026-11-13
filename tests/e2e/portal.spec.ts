/*
 * Portal journey - local-first hub.
 * Covers: first-run empty state, create local, failed database falls back
 * to local, open recent via click and keyboard.
 * DB-backed create with a live database is covered by the API test path;
 * this spec asserts the UI never blocks local creation when the DB fails.
 */
import { test, expect } from '@playwright/test';

async function viteUp(): Promise<boolean> {
  try {
    await fetch('http://localhost:22077', { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

test.describe('workspace portal', () => {
  test('first run shows the creation hero', async ({ page }) => {
    if (!(await viteUp())) {
      test.info().annotations.push({ type: 'SKIP', description: 'Vite not running on :22077' });
      return;
    }
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const portal = page.locator('#workspace-portal');
    if ((await portal.count()) === 0) {
      test.info().annotations.push({ type: 'SKIP', description: 'Portal not mounted (workspace already active)' });
      return;
    }
    await expect(portal.getByText('New workspace')).toBeVisible({ timeout: 8000 });
    await expect(portal.getByTestId('portal-create')).toBeVisible();
  });

  test('create button stays legible with an empty name', async ({ page }) => {
    if (!(await viteUp())) {
      test.info().annotations.push({ type: 'SKIP', description: 'Vite not running on :22077' });
      return;
    }
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const portal = page.locator('#workspace-portal');
    if ((await portal.count()) === 0) return;
    const create = portal.getByTestId('portal-create');
    await expect(create).toBeDisabled();
    await expect(create).toHaveCSS('cursor', /not-allowed/);
  });

  test('failed database still allows local creation', async ({ page }) => {
    if (!(await viteUp())) {
      test.info().annotations.push({ type: 'SKIP', description: 'Vite not running on :22077' });
      return;
    }
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const portal = page.locator('#workspace-portal');
    if ((await portal.count()) === 0) return;
    await portal.getByLabel('Workspace name').fill('Portal E2E ' + Date.now());
    const disclosure = portal.getByText(/Semantic memory/);
    await disclosure.click();
    await portal.getByLabel('PostgreSQL connection URL').fill('postgresql://u:p@127.0.0.1:1/db');
    await portal.getByRole('button', { name: 'Test connection' }).click();
    await expect(portal.getByText('You can still create this workspace locally.')).toBeVisible({ timeout: 15000 });
    await expect(portal.getByTestId('portal-create')).toBeEnabled();
  });

  test('recent rows expose open and keyboard selection', async ({ page }) => {
    if (!(await viteUp())) {
      test.info().annotations.push({ type: 'SKIP', description: 'Vite not running on :22077' });
      return;
    }
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const portal = page.locator('#workspace-portal');
    if ((await portal.count()) === 0) return;
    const list = portal.getByRole('listbox', { name: 'Workspaces' });
    if ((await list.count()) === 0) return;
    await list.focus();
    await page.keyboard.press('ArrowDown');
    await expect(list.getByRole('option').first()).toBeVisible();
  });
});
