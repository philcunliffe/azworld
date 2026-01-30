import { z } from "zod";
import { join } from "path";
import { homedir } from "os";
import { mkdir } from "fs/promises";
import type { LLMProviderName } from "./providers";

export const LLMConfigSchema = z.object({
  provider: z.enum(["ollama", "openai", "anthropic"]).optional(),
  models: z.object({
    ollama: z.string().optional(),
    openai: z.string().optional(),
    anthropic: z.string().optional(),
  }).optional(),
  // Separate generation model config (for content generation like NPCs, locations)
  generationProvider: z.enum(["ollama", "openai", "anthropic"]).optional(),
  generationModels: z.object({
    ollama: z.string().optional(),
    openai: z.string().optional(),
    anthropic: z.string().optional(),
  }).optional(),
  // Separate talk model config (for NPC conversations)
  talkProvider: z.enum(["ollama", "openai", "anthropic"]).optional(),
  talkModels: z.object({
    ollama: z.string().optional(),
    openai: z.string().optional(),
    anthropic: z.string().optional(),
  }).optional(),
}).strict();

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

const CONFIG_DIR = join(homedir(), ".azworld");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_MODELS: Record<LLMProviderName, string> = {
  ollama: "llama3.2",
  openai: "gpt-4o-mini",  // Reliable, cost-effective default with full feature support
  anthropic: "claude-sonnet-4-5-20250929",
};

export async function loadConfig(): Promise<LLMConfig> {
  try {
    const file = Bun.file(CONFIG_PATH);
    if (!(await file.exists())) {
      return {};
    }
    const text = await file.text();
    const parsed = JSON.parse(text);
    return LLMConfigSchema.parse(parsed);
  } catch {
    return {};
  }
}

export async function saveConfig(config: LLMConfig): Promise<void> {
  // Ensure directory exists
  await mkdir(CONFIG_DIR, { recursive: true });

  const validated = LLMConfigSchema.parse(config);
  await Bun.write(CONFIG_PATH, JSON.stringify(validated, null, 2) + "\n");
}

export function getEffectiveProvider(config: LLMConfig): LLMProviderName {
  if (config.provider) return config.provider;
  const envProvider = process.env.LLM_PROVIDER?.toLowerCase();
  if (envProvider === "openai" || envProvider === "anthropic" || envProvider === "ollama") {
    return envProvider;
  }
  return "ollama";
}

export function getEffectiveModel(config: LLMConfig, provider: LLMProviderName): string {
  // Check config first
  const configModel = config.models?.[provider];
  if (configModel) return configModel;

  // Then check env var
  const envKey = `${provider.toUpperCase()}_MODEL`;
  const envModel = process.env[envKey];
  if (envModel) return envModel;

  // Fall back to default
  return DEFAULT_MODELS[provider];
}

export function validateProviderSwitch(provider: LLMProviderName): string | null {
  if (provider === "openai" && !process.env.OPENAI_API_KEY) {
    return "OPENAI_API_KEY environment variable is required";
  }
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    return "ANTHROPIC_API_KEY environment variable is required";
  }
  return null;
}

/**
 * Get the effective generation provider. Falls back to main provider if not set.
 */
export function getEffectiveGenerationProvider(config: LLMConfig): LLMProviderName | undefined {
  if (config.generationProvider) return config.generationProvider;
  // Check for env var
  const envProvider = process.env.LLM_GENERATION_PROVIDER?.toLowerCase();
  if (envProvider === "openai" || envProvider === "anthropic" || envProvider === "ollama") {
    return envProvider;
  }
  return undefined; // Will fall back to main provider
}

/**
 * Get the effective generation model for a provider.
 */
export function getEffectiveGenerationModel(config: LLMConfig, provider: LLMProviderName): string {
  // Check generation-specific config first
  const configModel = config.generationModels?.[provider];
  if (configModel) return configModel;

  // Check env var
  const envKey = `LLM_GENERATION_${provider.toUpperCase()}_MODEL`;
  const envModel = process.env[envKey];
  if (envModel) return envModel;

  // Fall back to main model config, then default
  return getEffectiveModel(config, provider);
}

/**
 * Check if a separate generation model is configured.
 */
export function hasGenerationConfig(config: LLMConfig): boolean {
  return !!(
    config.generationProvider ||
    config.generationModels?.ollama ||
    config.generationModels?.openai ||
    config.generationModels?.anthropic ||
    process.env.LLM_GENERATION_PROVIDER
  );
}

/**
 * Get the effective talk provider. Returns undefined if not set (falls back to generation/main).
 */
export function getEffectiveTalkProvider(config: LLMConfig): LLMProviderName | undefined {
  if (config.talkProvider) return config.talkProvider;
  // Check for env var
  const envProvider = process.env.LLM_TALK_PROVIDER?.toLowerCase();
  if (envProvider === "openai" || envProvider === "anthropic" || envProvider === "ollama") {
    return envProvider;
  }
  return undefined; // Will fall back to generation provider or main provider
}

/**
 * Get the effective talk model for a provider.
 * Fallback chain: talkModel → generationModel → chatModel
 */
export function getEffectiveTalkModel(config: LLMConfig, provider: LLMProviderName): string {
  // Check talk-specific config first
  const configModel = config.talkModels?.[provider];
  if (configModel) return configModel;

  // Check env var
  const envKey = `LLM_TALK_${provider.toUpperCase()}_MODEL`;
  const envModel = process.env[envKey];
  if (envModel) return envModel;

  // Fall back to generation model config, then main model
  return getEffectiveGenerationModel(config, provider);
}

/**
 * Check if a separate talk model is configured.
 */
export function hasTalkConfig(config: LLMConfig): boolean {
  return !!(
    config.talkProvider ||
    config.talkModels?.ollama ||
    config.talkModels?.openai ||
    config.talkModels?.anthropic ||
    process.env.LLM_TALK_PROVIDER
  );
}

export { DEFAULT_MODELS };
