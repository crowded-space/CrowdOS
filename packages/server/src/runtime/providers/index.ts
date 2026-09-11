import { ProviderRegistry } from './provider-registry.js'
import { GoogleAdapter } from './google-adapter.js'
import { AnthropicAdapter } from './anthropic-adapter.js'
import { OpenAIAdapter } from './open-ai-adapter.js'
import { OllamaAdapter } from './ollama-adapter.js'
import { CustomAdapter } from './custom-adapter.js'

export function registerProviders(): void {
  ProviderRegistry.register(new GoogleAdapter())
  ProviderRegistry.register(new AnthropicAdapter())
  ProviderRegistry.register(new OpenAIAdapter())
  ProviderRegistry.register(new OllamaAdapter())
  ProviderRegistry.register(new CustomAdapter())
}

export { ProviderRegistry } from './provider-registry.js'
export { GoogleAdapter } from './google-adapter.js'
export { AnthropicAdapter } from './anthropic-adapter.js'
export { OpenAIAdapter } from './open-ai-adapter.js'
export { OllamaAdapter } from './ollama-adapter.js'
export { CustomAdapter } from './custom-adapter.js'
export {
  ProviderError,
  ProviderTimeoutError,
  ProviderAbortError,
  isProviderError,
  type ProviderTimeoutPhase,
} from './provider-errors.js'
export {
  providerFetch,
  GuardedProviderCall,
  getProviderTimeoutConfig,
  DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  type ProviderTimeoutConfig,
} from './provider-http.js'
