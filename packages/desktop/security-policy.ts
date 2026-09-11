// Shared BrowserWindow / webPreferences security baseline.
// Pure data + accessor: no Electron imports so lint tests and the renderer
// type surface can import this without pulling in Electron.

export const DESKTOP_SECURITY = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
  allowedConnectSrc: ["http://127.0.0.1:*", "ws://127.0.0.1:*"],
  csp: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; object-src 'none'; base-uri 'self'; connect-src http://127.0.0.1:* ws://127.0.0.1:*; img-src 'self' data: blob:",
} as const;

export type DesktopSecurityPolicy = typeof DESKTOP_SECURITY;

export function getDesktopSecurity(): DesktopSecurityPolicy {
  return DESKTOP_SECURITY;
}
