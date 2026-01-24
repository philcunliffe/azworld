import { parseJsonLoose } from "../util/json";

export type LLMProviderName = "ollama" | "openai" | "anthropic";

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

export type CompleteResult = {
  text: string;
  raw?: any;
  toolCalls?: ToolCall[];
  stopReason?: "end_turn" | "tool_use" | "max_tokens";
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
    if (typeof opts.temperature === "number") body.temperature = opts.temperature;
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
    return { text, raw: json };
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

    if (typeof opts.temperature === "number") body.temperature = opts.temperature;
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
      body.response_format = { type: "json_object" };
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

    return { text, raw: json, toolCalls: toolCalls.length ? toolCalls : undefined, stopReason };
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

    if (typeof opts.temperature === "number") body.temperature = opts.temperature;
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

    return {
      text: text || (toolCalls.length ? "" : JSON.stringify(json)),
      raw: json,
      toolCalls: toolCalls.length ? toolCalls : undefined,
      stopReason,
    };
  }
}

export class OllamaChatClient implements LLMClient {
  provider: LLMProviderName = "ollama";
  model: string;
  baseUrl: string;

  constructor(overrideModel?: string) {
    this.baseUrl = process.env.OLLAMA_HOST || "http://localhost:11434";
    this.model = overrideModel || process.env.OLLAMA_MODEL || "llama3";
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
    return { text: typeof text === "string" ? text : JSON.stringify(json), raw: json };
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

export async function completeJson<T = any>(client: LLMClient, opts: Omit<CompleteOpts, "jsonMode"> & { jsonSchema?: any }): Promise<T> {
  const res = await client.complete({ ...opts, jsonMode: true });
  const parsed = parseJsonLoose(res.text);
  return parsed as T;
}
