const CALL_TOOL_REGEX = /<call_tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/call_tool>/g;
const STRIP_CALL_TOOL_REGEX = /<call_tool\s+name="[^"]+"\s*>[\s\S]*?<\/call_tool>/g;

export interface ParsedToolCall {
  name: string;
  input: string;
}

export function parseToolCalls(text: string): ParsedToolCall[] {
  if (!text) return [];
  const toolCalls: ParsedToolCall[] = [];
  let match: RegExpExecArray | null;
  CALL_TOOL_REGEX.lastIndex = 0;
  while ((match = CALL_TOOL_REGEX.exec(text)) !== null) {
    const name = match[1].trim();
    const rawArgs = match[2].trim();
    const cleanArgs = rawArgs.replace(/```json|```/g, '').trim();
    toolCalls.push({ name, input: cleanArgs });
  }
  return toolCalls;
}

export function stripToolCalls(text: string): string {
  if (!text) return '';
  return text.replace(STRIP_CALL_TOOL_REGEX, '').trim();
}
