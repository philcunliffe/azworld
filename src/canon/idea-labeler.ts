import type { CanonStore } from "./canon";
import type { LLMClient } from "../llm/providers";
import { completeJson } from "../llm/providers";
import { getIdeasNeedingLabels, setIdeaLabels, markIdeaLabelingSkipped } from "./ideas";

const SYSTEM_PROMPT =
  "You label short worldbuilding idea snippets with concise tag tokens. " +
  "Return 2-5 short, lowercase, single-or-hyphenated-word tags that capture the topic, " +
  "subject matter, or thematic anchors. Avoid full sentences, articles, or punctuation. " +
  "Respond with JSON: {\"labels\": [\"tag1\", \"tag2\", ...]}.";

function sanitizeLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const tag = raw
    .trim()
    .toLowerCase()
    .replace(/^[#@]+/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!tag) return undefined;
  if (tag.length > 40) return tag.slice(0, 40);
  return tag;
}

function dedupe(tags: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (!t) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Ask the LLM to suggest 2-5 concise lowercase tag tokens for an idea snippet.
 * Returns [] if anything goes wrong — caller decides whether to skip or retry.
 */
export async function suggestLabelsForIdea(text: string, llm: LLMClient): Promise<string[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];

  try {
    const data = await completeJson<any>(llm, {
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: trimmed }],
      maxTokens: 200,
      temperature: 0.3,
      jsonSchema: {
        type: "object",
        properties: {
          labels: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["labels"],
        additionalProperties: false,
      },
    });

    const raw = Array.isArray(data?.labels) ? data.labels : [];
    const cleaned = dedupe(raw.map(sanitizeLabel)).slice(0, 5);
    return cleaned;
  } catch {
    return [];
  }
}

export type RunPendingIdeaLabelingOpts = {
  concurrency?: number;
};

export type RunPendingIdeaLabelingResult = {
  labeled: number;
  skipped: number;
};

/**
 * Drain all ideas whose labelsStatus is "pending". Best-effort:
 * individual failures are swallowed and recorded as "skipped".
 */
export async function runPendingIdeaLabeling(
  canon: CanonStore,
  llm: LLMClient,
  opts: RunPendingIdeaLabelingOpts = {}
): Promise<RunPendingIdeaLabelingResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 2);
  const pending = getIdeasNeedingLabels(canon);

  let labeled = 0;
  let skipped = 0;
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, () =>
    (async () => {
      while (true) {
        const i = index++;
        if (i >= pending.length) return;
        const idea = pending[i]!;
        const text = idea.details_md || idea.summary || idea.name;
        try {
          const labels = await suggestLabelsForIdea(text, llm);
          if (labels.length > 0) {
            setIdeaLabels(canon, idea.id, labels);
            labeled++;
          } else {
            markIdeaLabelingSkipped(canon, idea.id);
            skipped++;
          }
        } catch {
          markIdeaLabelingSkipped(canon, idea.id);
          skipped++;
        }
      }
    })()
  );

  await Promise.all(workers);
  return { labeled, skipped };
}

/**
 * Fire-and-forget wrapper for app startup hooks. Swallows all errors so a
 * misconfigured LLM (missing key, bad model) never blocks app launch.
 */
export function kickOffIdeaLabeling(
  canon: CanonStore,
  llm: LLMClient | undefined,
  opts: RunPendingIdeaLabelingOpts = {}
): Promise<RunPendingIdeaLabelingResult> {
  if (!llm) return Promise.resolve({ labeled: 0, skipped: 0 });
  return runPendingIdeaLabeling(canon, llm, opts).catch(() => ({ labeled: 0, skipped: 0 }));
}
