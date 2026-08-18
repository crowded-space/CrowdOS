import type { IContextMiddleware, MutableContextPacket, ContextBuildContext } from "../contextTypes.js";

export class MemoryRetrievalMiddleware implements IContextMiddleware {
  readonly name = "MemoryRetrievalMiddleware";
  readonly priority = 60;

  async process(packet: MutableContextPacket, ctx: ContextBuildContext): Promise<void> {
    const { agent, channelId, userInput } = ctx;

    try {
      const { retrieveMemoryCandidates, buildMemoryPreviewBlock } = await import("../../../Memories/memoriesGate.js");
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
