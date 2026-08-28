import { EscalationChain } from "../../Agents/agentGate.js";
import type { EventBroker } from "../../EventBroker/eventBrokerGate.js";
import type { AgentProfile } from "../../Agents/agentGate.js";

// In-memory sliding window history of recent messages per agent to check similarity
const recentAgentMessages = new Map<string, string[]>();

export class LoopArbiter {
  /**
   * Analyzes consecutively generated messages from the same agent.
   * If three consecutive messages show cosine/lexical similarity >= 0.9, triggers Loop Detection and pauses the agent.
   * Returns true if loop detected (agent paused), false otherwise.
   */
  static async checkLoop(
    broker: EventBroker,
    agent: AgentProfile,
    channelId: string,
    newMessage: string
  ): Promise<boolean> {
    const list = recentAgentMessages.get(agent.id) ?? [];
    list.push(newMessage);

    // Keep sliding window of max 3 messages
    if (list.length > 3) {
      list.shift();
    }
    recentAgentMessages.set(agent.id, list);

    if (list.length < 3) return false;

    const [msg1, msg2, msg3] = list;

    // Check similarity (levenshtein/edit similarity approximation)
    const sim1 = this.calculateSimilarity(msg1, msg2);
    const sim2 = this.calculateSimilarity(msg2, msg3);

    console.log(`[LoopArbiter] [@${agent.name}] Checking similarity: Sim1=${sim1.toFixed(2)}, Sim2=${sim2.toFixed(2)}`);

    if (sim1 >= 0.9 && sim2 >= 0.9) {
      console.warn(`[LoopArbiter] Swarm self-loop detected for @${agent.name}!`);
      
      // Clear sliding window cache
      recentAgentMessages.delete(agent.id);

      await EscalationChain.escalate(
        broker,
        agent,
        channelId,
        "LOOP_DETECTED",
        `Infinite self-loop detected. 3 consecutive generated outputs show high lexical similarity >= 0.9.`
      );

      return true;
    }

    return false;
  }

  private static calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.trim().toLowerCase();
    const s2 = str2.trim().toLowerCase();

    if (s1 === s2) return 1.0;
    if (!s1 || !s2) return 0.0;

    // Edit distance similarity coefficient calculation
    const track = Array(s2.length + 1).fill(null).map(() => Array(s1.length + 1).fill(null));
    for (let i = 0; i <= s1.length; i += 1) track[0][i] = i;
    for (let j = 0; j <= s2.length; j += 1) track[j][0] = j;

    for (let j = 1; j <= s2.length; j += 1) {
      for (let i = 1; i <= s1.length; i += 1) {
        const indicator = s1[i - 1] === s2[j - 1] ? 0 : 1;
        track[j][i] = Math.min(
          track[j][i - 1] + 1, // deletion
          track[j - 1][i] + 1, // insertion
          track[j - 1][i - 1] + indicator // substitution
        );
      }
    }

    const editDistance = track[s2.length][s1.length];
    const maxLength = Math.max(s1.length, s2.length);
    return (maxLength - editDistance) / maxLength;
  }
}
