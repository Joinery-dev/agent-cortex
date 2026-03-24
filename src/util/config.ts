import { DEFAULT_CONFIG } from "../types/orchestrator.js";
import type { CortexConfig } from "../types/orchestrator.js";

export function buildConfig(overrides: Partial<CortexConfig> = {}): CortexConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    models: {
      ...DEFAULT_CONFIG.models,
      ...overrides.models,
    },
  };
}
