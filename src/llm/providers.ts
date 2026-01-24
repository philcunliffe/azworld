import { parseJsonLoose } from "../util/json";

export type LLMProviderName = "ollama" | "openai" | "anthropic";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type CompleteOpts = {
  system?: string;
  messages: ChatMessage[];
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
  // Optional: provider-specific schema (OpenAI Responses + Ollama can use this)
  jsonSchema?: any;
};

export type CompleteResult = {
  text: string;
  raw?: any;
};

export interface LLMClient {
  provider: LLMProviderName;
  model: string;
  complete(opts: CompleteOpts): Promise<CompleteResult>;
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

  constructor() {
    this.apiKey = assertEnv("OPENAI_API_KEY");
    this.baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com";
    this.model = process.env.OPENAI_MODEL || "gpt-4o-mini";
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

export class AnthropicMessagesClient implements LLMClient {
  provider: LLMProviderName = "anthropic";
  model: string;
  apiKey: string;
  version: string;
  baseUrl: string;

  constructor() {
    this.apiKey = assertEnv("ANTHROPIC_API_KEY");
    this.baseUrl = process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com";
    this.version = process.env.ANTHROPIC_VERSION || "2023-06-01";
    this.model = process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5-20250929";
  }

  async complete(opts: CompleteOpts): Promise<CompleteResult> {
    const url = `${this.baseUrl.replace(/\/$/, "")}/v1/messages`;
    const system = opts.jsonMode ? addJsonDiscipline(opts.system) : (opts.system || undefined);

    const body: any = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 1024,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
    };
    if (system) body.system = system;
    if (typeof opts.temperature === "number") body.temperature = opts.temperature;

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
    const text = parts
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");

    return { text: text || JSON.stringify(json), raw: json };
  }
}

export class OllamaChatClient implements LLMClient {
  provider: LLMProviderName = "ollama";
  model: string;
  baseUrl: string;

  constructor() {
    this.baseUrl = process.env.OLLAMA_HOST || "http://localhost:11434";
    this.model = process.env.OLLAMA_MODEL || "llama3";
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

export function createLLMClient(): LLMClient {
  const provider = (process.env.LLM_PROVIDER || "ollama").toLowerCase() as LLMProviderName;
  if (provider === "openai") return new OpenAIResponsesClient();
  if (provider === "anthropic") return new AnthropicMessagesClient();
  return new OllamaChatClient();
}

export async function completeJson<T = any>(client: LLMClient, opts: Omit<CompleteOpts, "jsonMode"> & { jsonSchema?: any }): Promise<T> {
  const res = await client.complete({ ...opts, jsonMode: true });
  const parsed = parseJsonLoose(res.text);
  return parsed as T;
}
