import { registerProviders } from './providers/index.js'

export { RuntimeExecutor } from './RuntimeExecutor.js'
export { RuntimeRouter } from './RuntimeRouter.js'
export { ContextAssembler } from './kernel/ContextAssembler.js'
export { RuntimeKernel } from './kernel/RuntimeKernel.js'
export { ProviderRegistry } from './providers/ProviderRegistry.js'
export { GoogleAdapter } from './providers/GoogleAdapter.js'
export { AnthropicAdapter } from './providers/AnthropicAdapter.js'
export { OpenAIAdapter } from './providers/OpenAIAdapter.js'
export { ConversationalRuntime } from './runtimes/ConversationalRuntime.js'
export { AgenticRuntime } from './runtimes/AgenticRuntime.js'
export { SwarmRuntime } from './runtimes/SwarmRuntime.js'
export { CodingRuntime } from './runtimes/CodingRuntime.js'
export { BaseRuntime } from './runtimes/BaseRuntime.js'
export * from './types.js'

export function initRuntime(): void {
  registerProviders()
  console.log('[Runtime] Provider adapters registered.')
}
