import { ProviderRegistry } from './ProviderRegistry.js'
import { GoogleAdapter } from './GoogleAdapter.js'
import { AnthropicAdapter } from './AnthropicAdapter.js'
import { OpenAIAdapter } from './OpenAIAdapter.js'
import { OllamaAdapter } from './OllamaAdapter.js'
import { CustomAdapter } from './CustomAdapter.js'

export function registerProviders(): void {
  ProviderRegistry.register(new GoogleAdapter())
  ProviderRegistry.register(new AnthropicAdapter())
  ProviderRegistry.register(new OpenAIAdapter())
  ProviderRegistry.register(new OllamaAdapter())
  ProviderRegistry.register(new CustomAdapter())
}

export { ProviderRegistry } from './ProviderRegistry.js'
export { GoogleAdapter } from './GoogleAdapter.js'
export { AnthropicAdapter } from './AnthropicAdapter.js'
export { OpenAIAdapter } from './OpenAIAdapter.js'
export { OllamaAdapter } from './OllamaAdapter.js'
export { CustomAdapter } from './CustomAdapter.js'
export {
  ProviderError,
  ProviderTimeoutError,
  ProviderAbortError,
  isProviderError,
  type ProviderTimeoutPhase,
} from './providerErrors.js'
export {
  providerFetch,
  GuardedProviderCall,
  getProviderTimeoutConfig,
  DEFAULT_PROVIDER_CONNECT_TIMEOUT_MS,
  DEFAULT_PROVIDER_IDLE_TIMEOUT_MS,
  type ProviderTimeoutConfig,
} from './providerHttp.js'
