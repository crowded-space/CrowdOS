// Desktop file log (logs/desktop.log).
//
// QA audit 2026-09-23 finding: the file log documented by the dev launcher
// and the Desktop Shell spec never existed. crowdos:log:write (the only
// writer) had no renderer callers, and the main process / embedded backend
// only logged to the parent terminal stdout - which vanishes when the
// terminal closes and does not exist at all in a packaged build.
//
// This module is the single writer:
//   1. startDesktopLogTee(logFile) captures main-process console
//      warn/error and appends them to the file (never swallows the
//   2. The existing crowdos:log:write IPC keeps its own appender for the
//      renderer (any future caller works as documented).
//
// The stream is append-only, created lazily, and errors are swallowed so a
// logging failure can never take the shell down.

import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

let stream: WriteStream | null = null;
let installedTee = false;

export function appendDesktopLog(logFile: string, line: string): void {
  try {
    if (!stream) {
      mkdirSync(dirname(logFile), { recursive: true });
      stream = createWriteStream(logFile, { flags: "a", encoding: "utf8" });
      stream.on("error", () => {
        // Keep logging failures silent-but-alive; drop the stream so the
        // next write retries (e.g. after the file is deleted while running).
        stream = null;
      });
    }
    stream.write(line);
  } catch {
    // Logging must never crash the shell.
  }
}

/** Best-effort timestamped line for the shared desktop log. */
export function logDesktopLine(logFile: string, level: string, message: string): void {
  const ts = new Date().toISOString();
  const clean = String(message).replace(/\r?\n$/, "");
  appendDesktopLog(logFile, ts + " [" + level + "] " + clean + "\n");
}

/**
 * Tee main-process console warn/error into the desktop log. Main-process
 * boot failures, embedded-backend errors, and updater noise are the signals
 * support needs from a packaged build; info/log spam stays console-only.
 */
export function startDesktopLogTee(logFile: string): void {
  if (installedTee) return;
  installedTee = true;
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    try {
      logDesktopLine(logFile, "warn", args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" "));
    } catch {}
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    try {
      logDesktopLine(logFile, "error", args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" "));
    } catch {}
    origError(...args);
  };
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
