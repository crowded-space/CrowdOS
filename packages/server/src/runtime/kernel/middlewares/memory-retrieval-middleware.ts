import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../context-types.js";

export class MemoryRetrievalMiddleware implements IContextMiddleware {
  readonly name = "MemoryRetrievalMiddleware";
  readonly priority = 60;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent, channelId, userInput, workspaceId } = ctx;

    try {
      const { retrieveMemoryCandidates, buildMemoryPreviewBlock } = await import("../../../memories/memories-gate.js");
      const candidates = await retrieveMemoryCandidates({
        agentId: agent.id,
        channelId,
        userMessageText: userInput,
        recentEpisodic: true,
        highImportance: true,
        mentions: true,
        unresolvedTensions: true,
        recencyBump: true,
        topK: 10,
        workspaceId,
      });

      if (candidates && candidates.length > 0) {
        const previewBlock = buildMemoryPreviewBlock(candidates);
        packet.memoryPreviewBlock = previewBlock;
      }
    } catch (err) {
      console.warn(`[MemoryRetrievalMiddleware] Failed to retrieve memory candidates for @${agent.name}:`, err);
    }
  }
}
