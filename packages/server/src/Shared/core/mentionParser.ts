import { AgentRegistry } from "../../Agents/agentGate.js";
import type { MentionMetadata, MentionFlag, MentionType } from "../../types/mention.types.js";

export class MentionParser {
  private registry: AgentRegistry;

  constructor() {
    this.registry = new AgentRegistry();
  }

  /**
   * Compute Levenshtein distance between two strings
   */
  private levenshtein(s1: string, s2: string): number {
    const m = s1.length;
    const n = s2.length;
    const d: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) d[i][0] = i;
    for (let j = 0; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        d[i][j] = Math.min(
          d[i - 1][j] + 1, // deletion
          d[i][j - 1] + 1, // insertion
          d[i - 1][j - 1] + cost // substitution
        );
      }
    }
    return d[m][n];
  }

  /**
   * Parse and resolve mentions from text content.
   * Support @AgentName, @AgentId, @Level0, @Level1, @Level2, @Level3, @L0, @L1, @L2, @L3
   */
  async parseMentions(content: string): Promise<MentionMetadata[]> {
    if (!content) return [];

    const matches: MentionMetadata[] = [];

    // Fetch all active agents
    const allAgents = await this.registry.list({ isTemplate: false });

    const agentNames = allAgents.map(a => a.name);
    const roleNames = [
      'Level0', 'Level 0', 'L0', 'Omniscient', 'Omniscient Monitor',
      'Level1', 'Level 1', 'L1', 'Admin', 'Executive Administrator', 'CEO',
      'Level2', 'Level 2', 'L2', 'Coordinator', 'Operation Coordinator',
      'Level3', 'Level 3', 'L3', 'Worker', 'Autonomic Worker', 'Supervisor'
    ];
    const userNames = ['Human Operator', 'Operator', 'Juan Hamzah', 'User'];

    const candidateNames = Array.from(new Set([
      ...agentNames,
      ...roleNames,
      ...userNames
    ])).filter(Boolean);

    candidateNames.sort((a, b) => b.length - a.length);

    const escapeRegExp = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    let regex: RegExp;
    if (candidateNames.length > 0) {
      const escapedNames = candidateNames.map(escapeRegExp).join('|');
      regex = new RegExp(`@(${escapedNames}|[A-Za-z0-9_-]+)`, 'gi');
    } else {
      regex = /@([A-Za-z0-9_-]+)/g;
    }

    let match;
    while ((match = regex.exec(content)) !== null) {
      const tag = match[1]; // e.g. "Raven Architect"
      const position = match.index;

      const resolved = await this.resolveTag(tag, allAgents);
      if (resolved) {
        matches.push({
          type: resolved.type,
          targetId: resolved.targetId,
          targetName: resolved.targetName,
          position,
          flag: resolved.flag,
        });
      }
    }

    return matches;
  }

  private async resolveTag(
    tag: string,
    allAgents: any[]
  ): Promise<{ type: MentionType; targetId: string; targetName: string; flag: MentionFlag } | null> {
    const lowerTag = tag.toLowerCase();

    // 1. Check for role mentions (@Level0, @Level1, @Level2, @Level3, @L0, @L1, @L2, @L3)
    const roleMatch = this.matchRole(lowerTag);
    if (roleMatch !== null) {
      return {
        type: "role",
        targetId: `role-l${roleMatch}`,
        targetName: `Level${roleMatch}`,
        flag: "critical",
      };
    }

    // 2. Check for exact agent ID match
    const agentById = allAgents.find(a => a.id.toLowerCase() === lowerTag);
    if (agentById) {
      return {
        type: "agent",
        targetId: agentById.id,
        targetName: agentById.name,
        flag: this.getMentionFlag(agentById),
      };
    }

    // 3. Check for exact agent Name match (case-insensitive)
    const agentByName = allAgents.find(a => a.name.toLowerCase() === lowerTag);
    if (agentByName) {
      return {
        type: "agent",
        targetId: agentByName.id,
        targetName: agentByName.name,
        flag: this.getMentionFlag(agentByName),
      };
    }

    // 4. Levenshtein Typo Correction (distance <= 2) for agent names
    let closestAgent = null;
    let minDistance = Infinity;

    for (const agent of allAgents) {
      const dist = this.levenshtein(lowerTag, agent.name.toLowerCase());
      if (dist <= 2 && dist < minDistance) {
        minDistance = dist;
        closestAgent = agent;
      }
    }

    if (closestAgent) {
      console.log(`[MentionParser] Typo detected: "${tag}" auto-corrected to "${closestAgent.name}" (distance: ${minDistance})`);
      return {
        type: "agent",
        targetId: closestAgent.id,
        targetName: closestAgent.name,
        flag: this.getMentionFlag(closestAgent),
      };
    }

    return null;
  }

  private matchRole(lowerTag: string): number | null {
    if (lowerTag === "level0" || lowerTag === "l0" || lowerTag === "omniscient") return 0;
    if (lowerTag === "level1" || lowerTag === "l1" || lowerTag === "admin" || lowerTag === "ceo") return 1;
    if (lowerTag === "level2" || lowerTag === "l2" || lowerTag === "coordinator") return 2;
    if (lowerTag === "level3" || lowerTag === "l3" || lowerTag === "worker" || lowerTag === "supervisor") return 3;
    return null;
  }

  private getMentionFlag(agent: any): MentionFlag {
    return "critical";
  }
}
