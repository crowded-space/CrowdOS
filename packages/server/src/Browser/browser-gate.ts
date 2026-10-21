// Browser domain facade. Wire + re-export only: no logic lives here.
// Outsiders (create-app, tools/browser-tools, routes/browser, the socket
// server) only need browserGate; the launcher seam and profile-dir resolver
// stay in-domain.

import { closeAllSessions, closeWorkspaceSession } from "./browser-session.js";
import {
  clickAtBrowser,
  clickBrowser,
  getBrowserState,
  navigateBrowser,
  openBrowser,
  readBrowser,
  screenshotBrowser,
  typeBrowser,
  typeTextBrowser,
  waitBrowser,
} from "./browser-service.js";
import {
  subscribeBrowserStream,
  unsubscribeBrowserStream,
  type browserFrame,
  type browserStreamSink,
  type browserStreamState,
} from "./browser-stream.js";

export type { browserFrame, browserStreamSink, browserStreamState };

export const browserGate = {
  navigate: navigateBrowser,
  open: openBrowser,
  screenshot: screenshotBrowser,
  click: clickBrowser,
  type: typeBrowser,
  read: readBrowser,
  wait: waitBrowser,
  state: getBrowserState,
  close: closeWorkspaceSession,
  closeAll: closeAllSessions,
  subscribeStream: subscribeBrowserStream,
  unsubscribeStream: unsubscribeBrowserStream,
  clickAt: clickAtBrowser,
  typeText: typeTextBrowser,
};
