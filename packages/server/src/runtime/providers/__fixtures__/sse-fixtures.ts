/**
 * TST-6 Provider SSE contract fixtures (recorded chunks per adapter).
 * Includes usage chunks (real token accounting verification) + error paths.
 */

export const GOOGLE_SSE_USAGE_FIXTURE = [
  'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"}}]}\n\n',
  'data: {"candidates":[{"content":{"parts":[{"text":" world"}],"role":"model"}}],"usageMetadata":{"promptTokenCount":12,"candidatesTokenCount":8,"totalTokenCount":20}}\n\n',
];

export const ANTHROPIC_SSE_USAGE_FIXTURE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Thought..."}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":15}}\n\n',
];

export const OPENAI_SSE_USAGE_FIXTURE = [
  'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
  'data: [DONE]\n\n',
];

export const PROVIDER_ERROR_FIXTURES = {
  timeout408: { status: 408, body: '{"error":{"message":"Request timed out"}}' },
  rateLimit429: { status: 429, body: '{"error":{"message":"Rate limit exceeded","code":"rate_limit_exceeded"}}' },
  overloaded529: { status: 529, body: '{"error":{"message":"Provider overloaded"}}' },
  refusal: { status: 200, body: '{"candidates":[{"finishReason":"SAFETY","content":{"parts":[{"text":"I cannot help with that request."}]}}]}' },
};
