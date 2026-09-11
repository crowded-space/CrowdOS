// Pure auto-updater policy for the desktop shell (P3b stub).
//
// No `electron-updater` dependency: this module only decides *whether* an
// update may proceed and parses feed URLs. The real main process performs
// the download/install later via the `crowdos:updater:check` /
// `crowdos:updater:install` invoke channels.

export const UPDATE_CHANNELS = ["stable", "beta"] as const;

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export interface UpdaterState {
  isPackaged: boolean;
  runningCount: number;
  channel?: UpdateChannel;
  currentVersion?: string;
}

export interface AutoUpdateDecision {
  ok: boolean;
  reason?: string;
}

// Updates are blocked while runs are in flight so an install/restart can
// never strand a run mid-step; main surfaces `reason` as a drain prompt
// (pause/cancel runs first). Dev (unpackaged) builds never auto-update.
export function canAutoUpdate(state: {
  isPackaged: boolean;
  runningCount: number;
}): AutoUpdateDecision {
  if (!state.isPackaged) {
    return {
      ok: false,
      reason: "auto-update is unavailable in development (app is not packaged)",
    };
  }
  if (state.runningCount > 0) {
    const n = state.runningCount;
    return {
      ok: false,
      reason:
        `${n} run${n === 1 ? " is" : "s are"} still in flight — ` +
        "pause or cancel runs to drain before updating",
    };
  }
  return { ok: true };
}

export interface UpdaterFeed {
  channel: UpdateChannel;
  baseUrl: string;
  raw: string;
}

function isUpdateChannel(value: string): value is UpdateChannel {
  return (UPDATE_CHANNELS as readonly string[]).includes(value);
}

// Channel comes from `?channel=<name>` first, then the first matching path
// segment, defaulting to `stable`. Only https feeds are accepted.
export function parseUpdaterFeed(url: string): UpdaterFeed {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`parseUpdaterFeed: invalid URL ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("parseUpdaterFeed: feed URL must use https");
  }
  const queryChannel = (parsed.searchParams.get("channel") ?? "").toLowerCase();
  const segments = parsed.pathname
    .split("/")
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment.length > 0);
  const channel: UpdateChannel =
    [queryChannel, ...segments].find(isUpdateChannel) ?? "stable";
  parsed.search = "";
  parsed.hash = "";
  return { channel, baseUrl: parsed.toString(), raw: url };
}
