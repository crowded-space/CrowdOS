export class ReActStreamParser {
  private static readonly triggerToken = '&&FINAL_RESPONSE&&';

  /**
   * Universal provider-agnostic ReAct and Chain-of-Thought parser.
   * Demultiplexes a single raw model string into internal monologue (thoughts)
   * and final response (content) using standard sentinel tokens or XML tags.
   */
  public static parse(rawText: string): { thoughts: string; content: string } {
    if (!rawText) {
      return { thoughts: '', content: '' };
    }

    const triggerIndex = rawText.lastIndexOf(this.triggerToken);

    if (triggerIndex === -1) {
      // Sentinel token not found (Failsafe fallback)
      // Check for legacy/alternative thinking block delimiters
      const delimiters = [
        { start: '<|channel>thought', end: '<channel|>' },
        { start: '<|think|>', end: '</|think|>' },
        { start: '<thought>', end: '</thought>' },
      ];

      for (const delim of delimiters) {
        const startIndex = rawText.indexOf(delim.start);
        if (startIndex !== -1) {
          const endIndex = rawText.indexOf(delim.end, startIndex + delim.start.length);
          if (endIndex !== -1) {
            const thoughts = rawText.slice(startIndex + delim.start.length, endIndex).trim();
            const content = (rawText.slice(0, startIndex) + rawText.slice(endIndex + delim.end.length)).trim();
            return { thoughts, content };
          }
        }
      }

      // No formatting sentinel or standard XML markers found.
      // Treat the entire output as standard response content to ensure no data is lost.
      return { thoughts: '', content: rawText.trim() };
    }

    // Sentinel token successfully matched!
    const thoughts = rawText.slice(0, triggerIndex).trim();
    const content = rawText.slice(triggerIndex + this.triggerToken.length).trim();

    return { thoughts, content };
  }
}
