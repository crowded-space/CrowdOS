import type { RoutableModelModule } from "./model-routing.js";

let rows: RoutableModelModule[] = [
  { id: "mod-flash-cheap", provider: "google", modelName: "gemini-2.0-flash", costPer1k: 0.1, hasApiKey: true },
  { id: "mod-flash-pricey", provider: "google", modelName: "gemma-4-27b", costPer1k: 0.4, hasApiKey: false },
  { id: "mod-frontier", provider: "google", modelName: "gemini-2.5-pro", costPer1k: 2.5, hasApiKey: true },
];

export function routingModuleRows(): RoutableModelModule[] {
  return rows;
}

export function setRoutingModuleRows(next: RoutableModelModule[]): void {
  rows = next;
}
