import { describe, expect, it } from 'vitest';

import { SHEET_TABS } from './OperationsSheet';
import type { rightPanelView } from '@/types/crowdOs';

// UI audit §2.16 (major #7): below xl the right sidebar (roster / repo /
// jobs / telemetry / browser) is unmounted, so the OperationsSheet is the
// only access point. The sheet used to cover only Jobs/Approvals/Repo,
// which made the roster, telemetry, and browser panels unreachable at
// narrow viewport widths. The sheet tab list must cover EVERY desktop
// right-panel view — panel parity is the contract. If a future right-panel
// view forgets the sheet, this test reintroduces the audit finding.

const DESKTOP_PANEL_VIEWS: ReadonlyArray<rightPanelView> = ['roster', 'repo', 'jobs', 'telemetry', 'browser'];

describe('operations sheet panel parity (UI audit §2.16)', () => {
  it('covers every desktop right-panel view so none is unreachable below xl', () => {
    const sheetIds = new Set(SHEET_TABS.map(t => t.id));
    for (const view of DESKTOP_PANEL_VIEWS) {
      expect(sheetIds.has(view), `right-panel view "${view}" has no OperationsSheet access point`).toBe(true);
    }
  });

  it('keeps tabs unique with a label and an icon component each', () => {
    const ids = SHEET_TABS.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tab of SHEET_TABS) {
      expect(tab.label.length).toBeGreaterThan(0);
      // lucide icons are forwardRef components (objects, not functions).
      expect(tab.icon).toBeTruthy();
    }
  });
});
