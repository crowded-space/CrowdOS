/*
 * Leave Workspace confirmation - overlay placement regression.
 *
 * BUG: ConfirmDialog rendered its `fixed inset-0` overlay inline inside the
 * sidebar <nav> (WorkspaceDropdown -> WorkspaceSidebar). Below xl that nav is
 * off-canvas and carries a non-none `translate` (Tailwind v4 emits the
 * standalone `translate` property), which makes it the containing block for
 * `position: fixed` descendants. The dialog therefore centered inside the
 * ~300px sidebar instead of the viewport, appearing pinned to the sidebar's
 * bottom-left.
 *
 * FIX: ConfirmDialog portals its overlay to document.body.
 *
 * These assertions fail without the portal: the overlay measures the nav box
 * (narrow) and the panel is not viewport-centered. The sub-xl case is asserted
 * explicitly because that is where the nav is translated.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';

async function viteUp(): Promise<boolean> {
  try {
    await fetch('http://localhost:22077', { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Click a locator, retrying when the live store re-renders detach the node
 * mid-action. Locators re-resolve on each attempt, so a retry lands on the
 * current DOM node.
 */
async function clickWithRetry(locator: Locator, attempts = 5): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await locator.click({ timeout: 5000 });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await locator.page().waitForTimeout(400);
    }
  }
}

/**
 * Ensure a workspace shell is open, entering from the portal if needed.
 *
 * Idempotent: safe to call when the shell is already up, and after a bounce
 * back to the portal. The app is local-first — the active workspace lives in
 * localStorage on the shared dev-server origin — so callers run each test in
 * its own browser context to keep that state private.
 */
async function ensureWorkspace(page: Page): Promise<boolean> {
  const row = page.locator('[data-testid^="workspace-row-"]').first();
  const sidebar = page.locator('#workspace-sidebar');

  // Boot settles asynchronously into one of two stable states: the portal
  // listing workspaces, or an already-open workspace shell. Wait for either
  // before deciding, otherwise a cold start looks like "no workspace".
  // NOTE: the sidebar is checked by count, not visibility — below xl it is
  // attached but legitimately off-canvas (visibility: hidden).
  await expect
    .poll(
      async () =>
        (await sidebar.count()) > 0 || (await row.isVisible().catch(() => false)),
      { timeout: 30000, message: 'portal list or workspace shell should appear' },
    )
    .toBe(true);

  if ((await sidebar.count()) === 0 && (await row.count()) > 0) {
    await clickWithRetry(row);
  }

  try {
    await sidebar.waitFor({ state: 'attached', timeout: 25000 });
  } catch {
    return false;
  }
  return true;
}

/**
 * Open a workspace in its own isolated browser context and arm the Leave
 * confirmation. Isolating localStorage per test removes the cross-spec race
 * on the active workspace, and the context is torn down by the caller.
 */
async function openLeaveConfirmInIsolatedContext(
  browser: import('@playwright/test').Browser,
  viewport: { width: number; height: number },
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto('http://localhost:22077/', { waitUntil: 'domcontentloaded' });

  if (!(await ensureWorkspace(page))) {
    throw new Error('No workspace available to open');
  }
  await openLeaveConfirm(page);

  return { page, close: () => context.close() };
}

/**
 * Reveal the sidebar if it is off-canvas (below xl it is attached but
 * visibility: hidden, so its trigger is not clickable). Clicking the header
 * trigger while the sidebar is already open would toggle it shut, so this
 * only acts while the trigger is genuinely hidden.
 */
async function revealSidebar(page: Page): Promise<void> {
  const trigger = page.locator('#workspace-sidebar [aria-label="Open workspace menu"]');
  if (await trigger.isVisible().catch(() => false)) return;

  const headerTrigger = page.locator('button[title="Workspace menu"]');
  if (!(await headerTrigger.isVisible().catch(() => false))) return;

  await clickWithRetry(headerTrigger).catch(() => {});
  await trigger.waitFor({ state: 'visible', timeout: 10000 });
}

/**
 * Open the workspace menu and arm the Leave confirmation.
 *
 * `fetchWorkspaces` can fail while the dev server is under parallel load, and
 * the store then clears tenant slices (honest degradation), which drops the
 * shell back to the portal. Re-enter and retry so the helper is idempotent.
 */
async function openLeaveConfirm(page: Page): Promise<void> {
  const trigger = page.locator('#workspace-sidebar [aria-label="Open workspace menu"]');
  const menu = page.locator('#workspace-dropdown-menu');
  const leave = page.getByRole('menuitem', { name: 'Leave Portal' });
  const dialog = page.getByRole('alertdialog');

  for (let attempt = 0; attempt < 4; attempt++) {
    if (!(await ensureWorkspace(page))) {
      throw new Error('No workspace available to open');
    }

    await revealSidebar(page);
    await trigger.waitFor({ state: 'visible', timeout: 10000 });

    // Open the menu, then verify it actually opened. A retried click would
    // toggle it shut, so never blind-retry the trigger.
    if (!(await menu.isVisible().catch(() => false))) {
      await trigger.click({ timeout: 5000 }).catch(() => {});
      await menu.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    }
    if (!(await menu.isVisible().catch(() => false))) continue;

    await leave.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    await leave.click({ timeout: 5000 }).catch(() => {});

    if (await dialog.isVisible().catch(() => false)) return;
  }
  throw new Error('Could not open the Leave Workspace confirm dialog');
}

/** Poll the panel's offset from the viewport center until the spring settles. */
async function expectPanelCentered(page: Page): Promise<void> {
  const viewport = page.viewportSize()!;
  const panel = page.getByRole('alertdialog').locator('div.relative').first();
  await expect
    .poll(
      async () => {
        const box = await panel.boundingBox();
        if (!box) return Number.POSITIVE_INFINITY;
        return Math.max(
          Math.abs(box.x + box.width / 2 - viewport.width / 2),
          Math.abs(box.y + box.height / 2 - viewport.height / 2),
        );
      },
      { timeout: 5000, message: 'dialog panel should settle on the viewport center' },
    )
    .toBeLessThan(2);
}

test.describe('leave workspace confirm overlay placement', () => {
  // Each test opens the workspace in its own browser context, so the
  // local-first active-workspace state is private and no parallel worker can
  // move it. Booting the app and opening a workspace needs more than the
  // default 30s when the dev server is under load.
  test.describe.configure({ mode: 'serial', timeout: 120000 });

  test('overlay covers the viewport and centers the panel (desktop xl+)', async ({ browser }) => {
    if (!(await viteUp())) {
      test.info().annotations.push({ type: 'SKIP', description: 'Vite not running on :22077' });
      return;
    }
    const { page, close } = await openLeaveConfirmInIsolatedContext(browser, { width: 1280, height: 720 });
    try {
      const dialog = page.getByRole('alertdialog');
      // The overlay must be a direct child of <body>, not of the sidebar nav.
      expect(await dialog.evaluate((el) => el.parentElement === document.body)).toBe(true);

      const viewport = page.viewportSize()!;
      const overlay = (await dialog.boundingBox())!;
      expect(Math.abs(overlay.x)).toBeLessThan(1);
      expect(Math.abs(overlay.y)).toBeLessThan(1);
      expect(Math.abs(overlay.width - viewport.width)).toBeLessThan(1);
      expect(Math.abs(overlay.height - viewport.height)).toBeLessThan(1);

      await expectPanelCentered(page);
    } finally {
      await close();
    }
  });

  test('overlay escapes the translated off-canvas sidebar (sub-xl)', async ({ browser }) => {
    if (!(await viteUp())) {
      test.info().annotations.push({ type: 'SKIP', description: 'Vite not running on :22077' });
      return;
    }
    // Below xl the sidebar is off-canvas and carries a non-none translate,
    // which is the containing block that used to capture the fixed overlay.
    // openLeaveConfirmInIsolatedContext reveals the sidebar itself (its
    // trigger is hidden below xl until then) — exactly the state under test.
    const { page, close } = await openLeaveConfirmInIsolatedContext(browser, { width: 1024, height: 768 });
    try {
      const dialog = page.getByRole('alertdialog');
      const viewport = page.viewportSize()!;
      const overlay = (await dialog.boundingBox())!;
      const nav = page.locator('nav[aria-label="Workspace channels"]');
      const navBox = (await nav.boundingBox())!;

      // The regression: the overlay was clamped to the nav box.
      expect(overlay.width).toBeGreaterThan(navBox.width + 1);
      expect(Math.abs(overlay.width - viewport.width)).toBeLessThan(1);
      expect(Math.abs(overlay.height - viewport.height)).toBeLessThan(1);

      await expectPanelCentered(page);
    } finally {
      await close();
    }
  });

  test('cancel still closes the dialog and restores scroll', async ({ browser }) => {
    if (!(await viteUp())) {
      test.info().annotations.push({ type: 'SKIP', description: 'Vite not running on :22077' });
      return;
    }
    const { page, close } = await openLeaveConfirmInIsolatedContext(browser, { width: 1280, height: 720 });
    try {
      await expect(page.getByRole('alertdialog')).toBeVisible();
      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.getByRole('alertdialog')).toBeHidden();
      // The dialog locks body scroll while open; confirm it is released.
      await expect
        .poll(() => page.evaluate(() => document.body.style.overflow), { timeout: 5000 })
        .not.toBe('hidden');
    } finally {
      await close();
    }
  });
});
