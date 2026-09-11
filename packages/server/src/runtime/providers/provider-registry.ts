import type { IProviderAdapter } from '../types.js'

const registry = new Map<string, IProviderAdapter>()

export const ProviderRegistry = {
  register(adapter: IProviderAdapter): void {
    registry.set(adapter.provider, adapter)
  },

  get(provider: string): IProviderAdapter {
    const adapter = registry.get(provider)
    if (!adapter) {
      throw new Error(
        `[ProviderRegistry] No adapter registered for provider: "${provider}". Registered: ${[...registry.keys()].join(', ')}`
      )
    }
    return adapter
  },

  has(provider: string): boolean {
    return registry.has(provider)
  },

  list(): string[] {
    return [...registry.keys()]
  },
}
