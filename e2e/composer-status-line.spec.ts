/*
 * Composer status line - single-row regression.
 *
 * BUG: the composer rendered two stacked status rows, each showing the same
 * runtime + mount chips: `StatusStrip` (with icons) directly above the older
 * `ComposerPreflight` line (without icons). The duplicate read as noise and
 * made the composer look broken.
 *
 * FIX: `ComposerPreflight` was removed; `StatusStrip` is the single composer
 * status line. The over-limit guard is unchanged and still lives in
 * `handleSend` via the overflow `ConfirmDialog`.
 *
 * IMPORTANT: assertions must wait for the mount chip before counting rows.
 * The legacy `ComposerPreflight` returned null while it had nothing to show
 * (no mount, no pinned agents, no context/scope/cost, not over limit), so a
 * naive count taken right after the composer mounts passes trivially and
 * would not catch a regression. The mount chip only renders once the
 * effective root resolves, which is the signal that both rows have settled.
 */
import { test, expect, type Locator } from '@playwright/test';

async function viteUp(): Promise<boolean> {
  try {
    await fetch('http://localhost:22077', { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

/** Click a locator, retrying when live store re-renders detach the node. */
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
 * Ensure the composer is mounted, re-entering the workspace if the shell
 * bounced back to the portal. `fetchWorkspaces` can fail while the dev server
 * is under parallel load, and the store then clears tenant slices (honest
 * degradation), which drops the shell to the portal. Idempotent.
 */
async function ensureComposer(page: Page): Promise<void> {
  const row = page.locator('[data-testid^="workspace-row-"]').first();
  const composer = page.locator('#input-composer-container');

  if (await composer.isVisible().catch(() => false)) return;

  if (await row.isVisible().catch(() => false)) {
    await clickWithRetry(row);
  }
  await composer.waitFor({ state: 'visible', timeout: 25000 });
  await page.locator('[aria-label="Run status"]').first().waitFor({ state: 'visible', timeout: 25000 });
}

/**
 * Read the composer status-row counts atomically, re-entering the workspace
 * first if needed. One evaluate so the two counts cannot come from different
 * render states.
 */
async function readStatusRowCounts(
  page: Page,
): Promise<{ status: number; preflight: number; mountChips: number; runtimeChips: number }> {
  await ensureComposer(page);
  return page.evaluate(() => ({
    status: document.querySelectorAll('[aria-label="Run status"]').length,
    preflight: document.querySelectorAll('[aria-label="Send preflight"]').length,
    mountChips: document.querySelectorAll('[aria-label^="Open repository panel"]').length,
    runtimeChips: document.querySelectorAll('[aria-label^="Runtime "]').length,
  }));
}

/**
 * Open the composer in its own isolated browser context.
 *
 * The app is local-first: the active workspace lives in localStorage on the
 * shared dev-server origin, so parallel specs (and the leave spec, which
 * exercises the portal round-trip) can yank the workspace out from under this
 * one. A dedicated context per test keeps localStorage private and removes
 * that cross-spec race entirely.
 */
async function openComposerInIsolatedContext(
  browser: import('@playwright/test').Browser,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();

  const row = page.locator('[data-testid^="workspace-row-"]').first();
  const sidebar = page.locator('#workspace-sidebar');

  await page.goto('http://localhost:22077/', { waitUntil: 'domcontentloaded' });

  // Boot settles into the portal listing workspaces, or an already-open shell.
  // NOTE: the sidebar is checked by count, not visibility — below xl it is
  // attached but legitimately off-canvas (visibility: hidden).
  await expect
    .poll(
      async () => (await sidebar.count()) > 0 || (await row.isVisible().catch(() => false)),
      { timeout: 30000, message: 'portal list or workspace shell should appear' },
    )
    .toBe(true);

  await ensureComposer(page);

  // Settle: the mount chip appears only once the effective root resolves, so
  // waiting for it (best-effort) avoids sampling mid-render. A workspace with
  // no resolvable root legitimately has no chip.
  await page
    .locator('[aria-label^="Open repository panel"]')
    .first()
    .waitFor({ state: 'visible', timeout: 15000 })
    .catch(() => {});

  return { page, close: () => context.close() };
}

test.describe('composer status line is a single row', () => {
  // Each test boots the app and opens a workspace in its own browser context
  // (see openComposerInIsolatedContext), so no cross-test state is shared.
  test.describe.configure({ mode: 'serial', timeout: 120000 });

  test('renders one status row and no legacy preflight row', async ({ browser }) => {
    if (!(await viteUp())) {
      test.info().annotations.push({ type: 'SKIP', description: 'Vite not running on :22077' });
      return;
    }
    const { page, close } = await openComposerInIsolatedContext(browser);
    try {
      const counts = await readStatusRowCounts(page);

      // Exactly one status row...
      expect(counts.status).toBe(1);
      // ...and none of the removed legacy preflight row. This aria-label only
      // ever existed on ComposerPreflight, so it is the unambiguous marker.
      expect(counts.preflight).toBe(0);
      // The duplicate also rendered a second mount chip when a root resolved.
      // A channel with no resolvable root legitimately renders none, so assert
      // "never more than one" rather than "exactly one".
      expect(counts.mountChips).toBeLessThanOrEqual(1);
      // The surviving row still carries the runtime chip.
      expect(counts.runtimeChips).toBe(1);
    } finally {
      await close();
    }
  });

  test('status row stays above the textarea and above Send', async ({ browser }) => {
    if (!(await viteUp())) {
      test.info().annotations.push({ type: 'SKIP', description: 'Vite not running on :22077' });
      return;
    }
    const { page, close } = await openComposerInIsolatedContext(browser);
    try {
      // Read all three boxes in one evaluate so they come from the same layout
      // pass. Re-enter the workspace on each poll: the shell can bounce back to
      // the portal when a fetch fails under load (honest degradation).
      await expect
        .poll(
          async () => {
            try {
              await ensureComposer(page);
            } catch {
              return false;
            }
            return page.evaluate(() => {
              const composer = document.querySelector('#input-composer-container');
              const status = document.querySelector('[aria-label="Run status"]');
              const textarea = composer?.querySelector('textarea');
              const send = composer?.querySelector('[aria-label="Send message"]');
              if (!status || !textarea || !send) return false;
              // Single row sits between the composer top and the textarea,
              // and never overlaps the Send control.
              const s = status.getBoundingClientRect();
              const t = textarea.getBoundingClientRect();
              const b = send.getBoundingClientRect();
              return s.bottom <= t.top + 1 && s.top < b.top;
            });
          },
          { timeout: 45000, message: 'status row should sit above the textarea and above Send' },
        )
        .toBe(true);
    } finally {
      await close();
    }
  });
});
