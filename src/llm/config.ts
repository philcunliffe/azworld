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
}).strict();

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

const CONFIG_DIR = join(homedir(), ".azworld");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

const DEFAULT_MODELS: Record<LLMProviderName, string> = {
  ollama: "llama3",
  openai: "gpt-4o-mini",
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

export { DEFAULT_MODELS };
