import type { ModelModule } from '@/types/crowdOs';

// UI audit §2.10 (minor #12): the X-Ray "Provider" card rendered the raw
// provider type ("custom") while the model card for the same profile showed
// the module name ("Minimax M3.1") — one profile, two labels. The X-Ray card
// now shows the same label the model card shows: the module's display name,
// falling back to the compiled model name and finally the provider type so
// the card never renders empty.

export interface xrayModelInfo {
  provider?: string;
  modelName?: string;
}

/**
 * Human label for the X-Ray model card: the model module's own name when the
 * manifest slot matches a catalog entry, else the compiled model name, else
 * the provider type, else "unknown".
 */
export function xrayModelLabel(
  selectedModelId: string | null | undefined,
  modelModules: ReadonlyArray<Pick<ModelModule, 'id' | 'name'>> | undefined,
  modelInfo: xrayModelInfo | null | undefined,
): string {
  const fromCatalog = selectedModelId
    ? modelModules?.find(m => m.id === selectedModelId)?.name
    : undefined;
  if (fromCatalog && fromCatalog.trim()) return fromCatalog;

  const fromCompiled = modelInfo?.modelName;
  if (typeof fromCompiled === 'string' && fromCompiled.trim()) return fromCompiled;

  if (typeof modelInfo?.provider === 'string' && modelInfo.provider.trim()) {
    return modelInfo.provider;
  }
  return 'unknown';
}
