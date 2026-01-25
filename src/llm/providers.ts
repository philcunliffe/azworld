import { parseJsonLoose } from "../util/json";
import { debugLLMCall, isDebugEnabled } from "../chat/debug-log";

export type LLMProviderName = "ollama" | "openai" | "anthropic";

// Per-model configuration for handling model-specific quirks
export type ModelConfig = {
  fixedTemperature?: number;              // If set, temperature is locked to this value
  temperatureRange?: { min: number; max: number };  // Clamp temperature to this range
  supportsTools?: boolean;                // Whether model supports tool calling (default: true)
  supportsJsonMode?: boolean;             // Whether model supports JSON mode (default: true)
  maxOutputTokens?: number;               // Model's max output token limit
  reasoningModel?: boolean;               // Whether this is a reasoning/thinking model
};

// Known model configurations - exact matches take priority
const MODEL_CONFIGS: Record<string, ModelConfig> = {
  // OpenAI GPT-5 series (2025+) - reasoning models with fixed temperature
  "gpt-5": { fixedTemperature: 1, reasoningModel: true },
  "gpt-5-mini": { fixedTemperature: 1, reasoningModel: true },
  "gpt-5-turbo": { fixedTemperature: 1, reasoningModel: true },
  "gpt-5.1": { fixedTemperature: 1, reasoningModel: true },
  "gpt-5.1-mini": { fixedTemperature: 1, reasoningModel: true },
  "gpt-5.2": { fixedTemperature: 1, reasoningModel: true },
  "gpt-5.2-mini": { fixedTemperature: 1, reasoningModel: true },
  "gpt-5.2-chat-latest": { fixedTemperature: 1, reasoningModel: true },

  // OpenAI o-series reasoning models - no temperature control
  "o1": { fixedTemperature: 1, reasoningModel: true },
  "o1-mini": { fixedTemperature: 1, reasoningModel: true },
  "o1-preview": { fixedTemperature: 1, reasoningModel: true },
  "o3": { fixedTemperature: 1, reasoningModel: true },
  "o3-mini": { fixedTemperature: 1, reasoningModel: true },
  "o3-mini-high": { fixedTemperature: 1, reasoningModel: true },
  "o4-mini": { fixedTemperature: 1, reasoningModel: true },

  // GPT-4o series - standard temperature support
  "gpt-4o": { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 16384 },
  "gpt-4o-mini": { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 16384 },
  "gpt-4o-2024-08-06": { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 16384 },
  "gpt-4o-2024-11-20": { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 16384 },

  // GPT-4 Turbo
  "gpt-4-turbo": { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 4096 },
  "gpt-4-turbo-preview": { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 4096 },

  // Legacy GPT-4
  "gpt-4": { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 8192 },
  "gpt-4-32k": { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 8192 },

  // GPT-3.5 Turbo
  "gpt-3.5-turbo": { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 4096 },
  "gpt-3.5-turbo-16k": { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 4096 },
};

// Pattern-based model matching for model families
// Returns config if pattern matches, undefined otherwise
const MODEL_PATTERNS: Array<{ pattern: RegExp; config: ModelConfig }> = [
  // Any gpt-5.x model - reasoning models with fixed temperature
  { pattern: /^gpt-5(\.\d+)?(-|$)/i, config: { fixedTemperature: 1, reasoningModel: true } },

  // Any o1/o3/o4 reasoning model
  { pattern: /^o[134](-|$)/i, config: { fixedTemperature: 1, reasoningModel: true } },

  // Any gpt-4o variant
  { pattern: /^gpt-4o(-|$)/i, config: { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 16384 } },

  // Any gpt-4-turbo variant
  { pattern: /^gpt-4-turbo/i, config: { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 4096 } },

  // Any gpt-4 variant (non-turbo, non-o)
  { pattern: /^gpt-4(-\d|$)/i, config: { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 8192 } },

  // Any gpt-3.5 variant
  { pattern: /^gpt-3\.5/i, config: { temperatureRange: { min: 0, max: 2 }, maxOutputTokens: 4096 } },
];

// Get model config, checking exact match first, then patterns
export function getModelConfig(model: string): ModelConfig {
  // Exact match first
  if (MODEL_CONFIGS[model]) {
    return MODEL_CONFIGS[model];
  }

  // Try pattern matching
  for (const { pattern, config } of MODEL_PATTERNS) {
    if (pattern.test(model)) {
      return config;
    }
  }

  return {};
}

// Get effective temperature for a model, applying any constraints
function getEffectiveTemperature(model: string, requested?: number): number | undefined {
  const config = getModelConfig(model);

  if (config.fixedTemperature !== undefined) {
    return config.fixedTemperature;
  }

  if (requested !== undefined && config.temperatureRange) {
    return Math.max(config.temperatureRange.min, Math.min(config.temperatureRange.max, requested));
  }

  return requested;
}

// Reasoning models use tokens for internal thinking AND output, so they need more headroom.
// This multiplier ensures enough tokens for both reasoning and actual response.
const REASONING_TOKEN_MULTIPLIER = 4;
const REASONING_MIN_TOKENS = 8000;

// Get effective maxTokens for a model, accounting for reasoning model needs
function getEffectiveMaxTokens(model: string, requested?: number): number | undefined {
  const config = getModelConfig(model);

  if (config.reasoningModel && requested !== undefined) {
    // Reasoning models need significantly more tokens since they use them for thinking
    return Math.max(requested * REASONING_TOKEN_MULTIPLIER, REASONING_MIN_TOKENS);
  }

  return requested;
}

// Check if an API response indicates token exhaustion on a reasoning model
function isReasoningTokenExhaustion(raw: any): boolean {
  const choice = raw?.choices?.[0];
  if (!choice) return false;

  // Check for empty content with length finish reason and reasoning tokens used
  const content = choice.message?.content ?? "";
  const finishReason = choice.finish_reason;
  const reasoningTokens = raw?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

  return content === "" && finishReason === "length" && reasoningTokens > 0;
}

// Tool-use types
export type ToolDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required?: string[];
  };
};

export type ToolCall = {
  id: string;
  name: string;
  arguments: Record<string, any>;
};

export type ChatMessage = {
  role: "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];      // For assistant with tool calls
  toolCallId?: string;          // For tool result messages
};

export type CompleteOpts = {
  system?: string;
  messages: ChatMessage[];
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  // Optional: provider-specific schema (OpenAI Responses + Ollama can use this)
  jsonSchema?: any;
  // Tool-use options
  tools?: ToolDefinition[];
  toolChoice?: "auto" | "required" | "none";
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type CompleteResult = {
  text: string;
  raw?: any;
  toolCalls?: ToolCall[];
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
  usage?: TokenUsage;
};

// Streaming types
export type StreamChunk = {
  type: "text" | "tool_call_start" | "tool_call_delta" | "done";
  text?: string;
  toolCall?: Partial<ToolCall>;
  stopReason?: CompleteResult["stopReason"];
};

export interface LLMClient {
  provider: LLMProviderName;
  model: string;
  complete(opts: CompleteOpts): Promise<CompleteResult>;
  completeStream?(opts: CompleteOpts): AsyncIterable<StreamChunk>;
}

function assertEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function addJsonDiscipline(system: string | undefined): string {
  const base = system ? system.trim() + "\n\n" : "";
  return (
    base +
    "If the user requests structured output, respond with ONLY valid JSON. No markdown, no backticks, no commentary." +
    " If you must refuse or report an error, still output JSON with an 'error' field."
  );
}

function extractUsage(resp: any): TokenUsage | undefined {
  // OpenAI format
  if (resp?.usage) {
    return {
      promptTokens: resp.usage.prompt_tokens ?? resp.usage.input_tokens ?? 0,
      completionTokens: resp.usage.completion_tokens ?? resp.usage.output_tokens ?? 0,
      totalTokens: resp.usage.total_tokens ??
        ((resp.usage.prompt_tokens ?? 0) + (resp.usage.completion_tokens ?? 0)),
    };
  }
  // Anthropic format
  if (resp?.usage?.input_tokens !== undefined) {
    return {
      promptTokens: resp.usage.input_tokens ?? 0,
      completionTokens: resp.usage.output_tokens ?? 0,
      totalTokens: (resp.usage.input_tokens ?? 0) + (resp.usage.output_tokens ?? 0),
    };
  }
  // Ollama format
  if (resp?.prompt_eval_count !== undefined || resp?.eval_count !== undefined) {
    const prompt = resp.prompt_eval_count ?? 0;
    const completion = resp.eval_count ?? 0;
    return {
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: prompt + completion,
    };
  }
  return undefined;
}

function extractOpenAIOutputText(resp: any): string {
  if (typeof resp?.output_text === "string") return resp.output_text;
  const out = resp?.output;
  if (Array.isArray(out)) {
    const chunks: string[] = [];
    for (const item of out) {
      if (item?.type === "message" && Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (part?.type === "output_text" && typeof part.text === "string") chunks.push(part.text);
        }
      }
    }
    if (chunks.length) return chunks.join("");
  }
  return JSON.stringify(resp);
}

export class OpenAIResponsesClient implements LLMClient {
  provider: LLMProviderName = "openai";
  model: string;
  baseUrl: string;
  apiKey: string;

  constructor(overrideModel?: string) {
    this.apiKey = assertEnv("OPENAI_API_KEY");
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com";
    this.model = overrideModel || process.env.OPENAI_MODEL || "gpt-4o-mini";
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/responses`;
    const instructions = opts.jsonMode ? addJsonDiscipline(opts.system) : (opts.system || undefined);

    // Responses API can take string or array; we'll send an array of message-like items.
    const input = opts.messages.map((m) => ({ role: m.role, content: m.content }));

    const body: any = {
      model: this.model,
      input,
      instructions,
      store: false,
    };
    const effectiveTempResp = getEffectiveTemperature(this.model, opts.temperature);
    if (typeof effectiveTempResp === "number") body.temperature = effectiveTempResp;
    if (typeof opts.maxTokens === "number") body.max_output_tokens = opts.maxTokens;

    if (opts.jsonMode) {
      if (opts.jsonSchema) {
        body.text = { format: { type: "json_schema", strict: true, schema: opts.jsonSchema } };
      } else {
        body.text = { format: { type: "json_object" } };
      }
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${t}`);
    }

    const json = await res.json();
    const text = extractOpenAIOutputText(json);
    const usage = extractUsage(json);
    return { text, raw: json, usage };
  }
}

export class OpenAIChatClient implements LLMClient {
  provider: LLMProviderName = "openai";
  model: string;
  baseUrl: string;
  apiKey: string;

  constructor(overrideModel?: string) {
    this.apiKey = assertEnv("OPENAI_API_KEY");
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com";
    this.model = overrideModel || process.env.OPENAI_MODEL || "gpt-4o-mini";
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

    const messages: any[] = [];
    if (opts.system) {
      messages.push({ role: "system", content: opts.jsonMode ? addJsonDiscipline(opts.system) : opts.system });
    }

    for (const m of opts.messages) {
      if (m.role === "tool") {
        messages.push({
          role: "tool",
          tool_call_id: m.toolCallId,
          content: m.content,
        });
      } else if (m.role === "assistant" && m.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const body: any = {
      model: this.model,
      messages,
    };

    const effectiveTemp = getEffectiveTemperature(this.model, opts.temperature);
    if (typeof effectiveTemp === "number") body.temperature = effectiveTemp;
    if (typeof opts.maxTokens === "number") body.max_completion_tokens = opts.maxTokens;

    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
      if (opts.toolChoice) {
        body.tool_choice = opts.toolChoice === "required" ? "required" : opts.toolChoice;
      }
    }

    if (opts.jsonMode && !opts.tools?.length) {
      if (opts.jsonSchema) {
        // Use structured outputs - strict mode disabled to allow flexible payload objects
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: "response",
            strict: false,
            schema: opts.jsonSchema,
          },
        };
      } else {
        body.response_format = { type: "json_object" };
      }
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${t}`);
    }

    const json = await res.json();
    const choice = json.choices?.[0];
    const message = choice?.message;
    const text = message?.content ?? "";

    const toolCalls: ToolCall[] = [];
    if (Array.isArray(message?.tool_calls)) {
      for (const tc of message.tool_calls) {
        if (tc.type === "function") {
          let args: Record<string, any> = {};
          try {
            args = JSON.parse(tc.function.arguments || "{}");
          } catch {
            args = {};
          }
          toolCalls.push({
            id: tc.id,
            name: tc.function.name,
            arguments: args,
          });
        }
      }
    }

    let stopReason: CompleteResult["stopReason"] = "end_turn";
    if (choice?.finish_reason === "tool_calls") {
      stopReason = "tool_use";
    } else if (choice?.finish_reason === "length") {
      stopReason = "max_tokens";
    }

    const usage = extractUsage(json);
    return { text, raw: json, toolCalls: toolCalls.length ? toolCalls : undefined, stopReason, usage };
  }

  async *completeStream(opts: CompleteOpts): AsyncIterable<StreamChunk> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

    const messages: any[] = [];
    if (opts.system) {
      messages.push({ role: "system", content: opts.jsonMode ? addJsonDiscipline(opts.system) : opts.system });
    }
    for (const m of opts.messages) {
      if (m.role === "tool") {
        messages.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
      } else if (m.role === "assistant" && m.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          })),
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const body: any = {
      model: this.model,
      messages,
      stream: true,
    };

    const effectiveTempStream = getEffectiveTemperature(this.model, opts.temperature);
    if (typeof effectiveTempStream === "number") body.temperature = effectiveTempStream;
    if (typeof opts.maxTokens === "number") body.max_completion_tokens = opts.maxTokens;

    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (opts.toolChoice) {
        body.tool_choice = opts.toolChoice === "required" ? "required" : opts.toolChoice;
      }
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${t}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim() || line.startsWith(":")) continue;
        if (line === "data: [DONE]") {
          yield { type: "done" };
          return;
        }
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices?.[0]?.delta;
            if (delta?.content) {
              yield { type: "text", text: delta.content };
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  yield { type: "tool_call_start", toolCall: { id: tc.id, name: tc.function.name } };
                }
                if (tc.function?.arguments) {
                  yield { type: "tool_call_delta", toolCall: { id: tc.id }, text: tc.function.arguments };
                }
              }
            }
            const finishReason = data.choices?.[0]?.finish_reason;
            if (finishReason === "stop") {
              yield { type: "done", stopReason: "end_turn" };
            } else if (finishReason === "tool_calls") {
              yield { type: "done", stopReason: "tool_use" };
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }
  }
}

export class AnthropicMessagesClient implements LLMClient {
  provider: LLMProviderName = "anthropic";
  model: string;
  apiKey: string;
  version: string;
  baseUrl: string;

  constructor(overrideModel?: string) {
    this.apiKey = assertEnv("ANTHROPIC_API_KEY");
    this.baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    this.version = process.env.ANTHROPIC_VERSION || "2023-06-01";
    this.model = overrideModel || process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/messages`;
    const system = opts.jsonMode ? addJsonDiscipline(opts.system) : (opts.system || undefined);

    // Build messages array with tool result support
    const messages: any[] = [];
    for (const m of opts.messages) {
      if (m.role === "tool") {
        // Tool results in Anthropic go in the user role with tool_result blocks
        messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: m.toolCallId,
            content: m.content,
          }],
        });
      } else if (m.role === "assistant" && m.toolCalls?.length) {
        // Assistant message with tool calls
        const content: any[] = [];
        if (m.content) {
          content.push({ type: "text", text: m.content });
        }
        for (const tc of m.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        messages.push({ role: "assistant", content });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const body: any = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      messages,
    };
    if (system) body.system = system;
    if (typeof opts.temperature === "number") body.temperature = opts.temperature;

    // Add tools if provided
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      if (opts.toolChoice === "required") {
        body.tool_choice = { type: "any" };
      } else if (opts.toolChoice === "none") {
        // Don't include tool_choice to allow no tools
      }
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": this.version,
        "X-Api-Key": this.apiKey,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${t}`);
    }

    const json = await res.json();
    const parts = Array.isArray(json?.content) ? json.content : [];

    // Extract text
    const text = parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");

    // Extract tool calls
    const toolCalls: ToolCall[] = [];
    for (const p of parts) {
      if (p?.type === "tool_use") {
        toolCalls.push({
          id: p.id,
          name: p.name,
          arguments: p.input ?? {},
        });
      }
    }

    // Determine stop reason
    let stopReason: CompleteResult["stopReason"] = "end_turn";
    if (json.stop_reason === "tool_use") {
      stopReason = "tool_use";
    } else if (json.stop_reason === "max_tokens") {
      stopReason = "max_tokens";
    }

    const usage = extractUsage(json);
    return {
      text: text || (toolCalls.length ? "" : JSON.stringify(json)),
      raw: json,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      stopReason,
      usage,
    };
  }
}

export class OllamaChatClient implements LLMClient {
  provider: LLMProviderName = "ollama";
  model: string;
  baseUrl: string;

  constructor(overrideModel?: string) {
    this.baseUrl = process.env.OLLAMA_HOST || "http://localhost:11434";
    this.model = overrideModel || process.env.OLLAMA_MODEL || "llama3.2";
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/api/chat`;
    const body: any = {
      model: this.model,
      messages: [
        ...(opts.system ? [{ role: "system", content: opts.jsonMode ? addJsonDiscipline(opts.system) : opts.system }] : []),
        ...opts.messages,
      ],
      stream: false,
    };

    if (opts.jsonMode) {
      body.format = opts.jsonSchema ? opts.jsonSchema : "json";
    }

    // Ollama uses an "options" object for runtime settings
    body.options = {};
    if (typeof opts.temperature === "number") body.options.temperature = opts.temperature;
    // No standardized max tokens across models; leave unless explicitly requested

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Ollama API error ${res.status}: ${t}`);
    }

    const json = await res.json();
    const text = json?.message?.content;
    const usage = extractUsage(json);
    return { text: typeof text === "string" ? text : JSON.stringify(json), raw: json, usage };
  }
}

export type CreateLLMClientOpts = {
  provider?: LLMProviderName;
  model?: string;
  preferTools?: boolean;
};

export function createLLMClient(opts?: CreateLLMClientOpts): LLMClient {
  const provider = opts?.provider || (process.env.LLM_PROVIDER || "ollama").toLowerCase() as LLMProviderName;
  const model = opts?.model;

  if (provider === "openai") {
    // Use chat completions API by default for tool support, or when preferTools is set
    const apiType = process.env.OPENAI_API_TYPE?.toLowerCase() || "chat";
    if (apiType === "responses") return new OpenAIResponsesClient(model);
    return new OpenAIChatClient(model);
  }
  if (provider === "anthropic") return new AnthropicMessagesClient(model);
  return new OllamaChatClient(model);
}

// Known Anthropic models (no public list API)
// Keep this list updated as new models are released
const ANTHROPIC_MODELS = [
  // Claude 4.5 series (latest)
  "claude-sonnet-4-5-20250929",
  "claude-opus-4-5-20251101",
  // Claude 4 series
  "claude-opus-4-20250514",
  "claude-sonnet-4-20250514",
  // Claude 3.5 series
  "claude-3-5-sonnet-20241022",
  "claude-3-5-haiku-20241022",
  // Claude 3 series
  "claude-3-opus-20240229",
  "claude-3-sonnet-20240229",
  "claude-3-haiku-20240307",
];

export type ModelInfo = {
  id: string;
  name?: string;
  size?: string;
};

/**
 * List available models for a provider.
 */
export async function listModels(provider: LLMProviderName): Promise<ModelInfo[]> {
  if (provider === "ollama") {
    const baseUrl = process.env.OLLAMA_HOST || "http://localhost:11434";
    try {
      const res = await fetch(`${baseUrl}/api/tags`);
      if (!res.ok) return [];
      const json = await res.json();
      return (json.models || []).map((m: any) => ({
        id: m.name,
        name: m.name,
        size: m.size ? `${(m.size / 1e9).toFixed(1)}GB` : undefined,
      }));
    } catch {
      return [];
    }
  }

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return [];
    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com";
    try {
      const res = await fetch(`${baseUrl}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return [];
      const json = await res.json();
      // Filter to chat/reasoning models, sort by id
      // Include: gpt-*, o1*, o3*, o4* (reasoning models)
      return (json.data || [])
        .filter((m: any) => {
          const id = m.id.toLowerCase();
          return id.includes("gpt") ||
                 id.startsWith("o1") ||
                 id.startsWith("o3") ||
                 id.startsWith("o4");
        })
        .map((m: any) => ({ id: m.id, name: m.id }))
        .sort((a: ModelInfo, b: ModelInfo) => a.id.localeCompare(b.id));
    } catch {
      return [];
    }
  }

  if (provider === "anthropic") {
    // No public API, return known models
    return ANTHROPIC_MODELS.map((id) => ({ id, name: id }));
  }

  return [];
}

export async function completeJson<T = any>(client: LLMClient, opts: Omit<CompleteOpts, "jsonMode"> & { jsonSchema?: any }): Promise<T> {
  // Adjust maxTokens for reasoning models
  const effectiveMaxTokens = getEffectiveMaxTokens(client.model, opts.maxTokens);

  if (isDebugEnabled()) {
    debugLLMCall("completeJson System prompt", opts.system);
    debugLLMCall("completeJson User message", opts.messages?.[0]?.content);
    debugLLMCall("completeJson Options", {
      maxTokens: opts.maxTokens,
      effectiveMaxTokens,
      temp: opts.temperature,
      hasSchema: !!opts.jsonSchema,
    });
  }

  const res = await client.complete({ ...opts, maxTokens: effectiveMaxTokens, jsonMode: true });

  if (isDebugEnabled()) {
    debugLLMCall("completeJson Raw response", res.text);
    debugLLMCall("completeJson Raw API response", res.raw);
  }

  // Check for reasoning model token exhaustion (empty response, all tokens used on thinking)
  if (isReasoningTokenExhaustion(res.raw)) {
    const used = res.raw?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    throw new Error(
      `Reasoning model exhausted tokens on thinking (${used} reasoning tokens used, no output). ` +
      `Try increasing maxTokens or using a non-reasoning model for this task.`
    );
  }

  try {
    const parsed = parseJsonLoose(res.text);
    return parsed as T;
  } catch (e: any) {
    debugLLMCall("completeJson Parse error - full response", res.text);
    // Include preview of the response in error for easier debugging
    const preview = res.text.length > 200 ? res.text.slice(0, 200) + "..." : res.text;
    throw new Error(`Failed to parse JSON from LLM response: ${preview}`);
  }
}

export type CompleteJsonResult<T> = {
  data: T;
  usage?: TokenUsage;
};

export async function completeJsonWithUsage<T = any>(
  client: LLMClient,
  opts: Omit<CompleteOpts, "jsonMode"> & { jsonSchema?: any }
): Promise<CompleteJsonResult<T>> {
  // Adjust maxTokens for reasoning models
  const effectiveMaxTokens = getEffectiveMaxTokens(client.model, opts.maxTokens);

  if (isDebugEnabled()) {
    debugLLMCall("completeJson System prompt", opts.system);
    debugLLMCall("completeJson User message", opts.messages?.[0]?.content);
    debugLLMCall("completeJson Options", {
      maxTokens: opts.maxTokens,
      effectiveMaxTokens,
      temp: opts.temperature,
      hasSchema: !!opts.jsonSchema,
    });
  }

  const res = await client.complete({ ...opts, maxTokens: effectiveMaxTokens, jsonMode: true });

  if (isDebugEnabled()) {
    debugLLMCall("completeJson Raw response", res.text);
    debugLLMCall("completeJson Raw API response", res.raw);
  }

  // Check for reasoning model token exhaustion (empty response, all tokens used on thinking)
  if (isReasoningTokenExhaustion(res.raw)) {
    const used = res.raw?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    throw new Error(
      `Reasoning model exhausted tokens on thinking (${used} reasoning tokens used, no output). ` +
      `Try increasing maxTokens or using a non-reasoning model for this task.`
    );
  }

  try {
    const parsed = parseJsonLoose(res.text);
    return { data: parsed as T, usage: res.usage };
  } catch (e: any) {
    debugLLMCall("completeJson Parse error - full response", res.text);
    // Include preview of the response in error for easier debugging
    const preview = res.text.length > 200 ? res.text.slice(0, 200) + "..." : res.text;
    throw new Error(`Failed to parse JSON from LLM response: ${preview}`);
  }
}
