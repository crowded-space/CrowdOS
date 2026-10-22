// Channel-mount-aware root: channel → category → workspace → workspace dir.
// Delegates to the ChannelMounts resolver so the agent file tools and the Repo
// panel can never disagree about which directory is the root.
// Dynamic import keeps the Tools → ChannelMounts gate edge lazy (no module cycle).
//
// Lives in its own file so the instruction tools can resolve the same root
// without importing the registry that registers them (that would be a cycle).

import { Guard } from "./safety/guard.js";

export async function resolveToolRoot(ctx?: { channelId?: string; workspaceId?: string }): Promise<string> {
  try {
    const { channelMountGate } = await import("../channel-mounts/channel-mount-gate.js");
    const root = await channelMountGate.effectiveRoot({
      channelId: ctx?.channelId,
      workspaceId: ctx?.workspaceId,
    });
    if (root?.path) return root.path;
  } catch {}
  return Guard.getWorkspaceDir(ctx?.workspaceId);
}
