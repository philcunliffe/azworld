import type { CanonEntity, CanonStore } from "./canon";
import type { LLMClient } from "../llm/providers";
import { nowIso } from "../util/time";
import { suggestLabelsForIdea } from "./idea-labeler";

export type IdeaStatus = "pending" | "used";
export type IdeaLabelsStatus = "pending" | "labeled" | "skipped";

export type AddIdeaOpts = {
  text: string;
  labels?: string[];
  kickOffLabeling?: boolean;
  llm?: LLMClient;
  joinTimeoutMs?: number;
};

const DEFAULT_JOIN_TIMEOUT_MS = 300;

function normalizeLabels(labels: readonly string[] | undefined): string[] {
  if (!labels) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().toLowerCase();
    if (!tag) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function summarizeIdeaText(text: string): { summary: string; details: string | null } {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 240) return { summary: trimmed, details: null };
  return { summary: trimmed.slice(0, 237) + "…", details: text };
}

/**
 * Create an idea. If labels are provided, labelsStatus = "labeled". Otherwise,
 * if kickOffLabeling is true (default) and an llm client is supplied, attempt a
 * short synchronous join window so fast LLM returns surface labels immediately,
 * otherwise fall back to background labeling drained by `runPendingIdeaLabeling`.
 */
export async function addIdea(
  canon: CanonStore,
  opts: AddIdeaOpts
): Promise<CanonEntity> {
  const text = opts.text.trim();
  if (!text) throw new Error("idea text required");

  const userLabels = normalizeLabels(opts.labels);
  const explicitLabels = userLabels.length > 0;
  const kickOff = opts.kickOffLabeling !== false && !explicitLabels && !!opts.llm;
  const labelsStatus: IdeaLabelsStatus = explicitLabels ? "labeled" : "pending";
  const { summary, details } = summarizeIdeaText(text);

  const entity = canon.addEntity({
    type: "idea",
    name: summary,
    summary,
    details_md: details,
    payload: {
      status: "pending",
      labels: userLabels,
      labelsStatus,
    },
    provenance: { source: "user" },
  });

  if (!kickOff || !opts.llm) return entity;

  // Fire-and-forget with a soft join window so fast LLMs surface labels in-line.
  const labelingPromise = (async () => {
    try {
      const labels = await suggestLabelsForIdea(text, opts.llm!);
      if (labels.length > 0) {
        setIdeaLabels(canon, entity.id, labels);
      } else {
        markIdeaLabelingSkipped(canon, entity.id);
      }
    } catch {
      markIdeaLabelingSkipped(canon, entity.id);
    }
  })();

  // Detach to background but allow a brief join window.
  labelingPromise.catch(() => { /* swallowed above */ });

  const joinMs = typeof opts.joinTimeoutMs === "number" ? opts.joinTimeoutMs : DEFAULT_JOIN_TIMEOUT_MS;
  if (joinMs > 0) {
    await Promise.race([
      labelingPromise,
      new Promise<void>((resolve) => setTimeout(resolve, joinMs)),
    ]);
  }

  return canon.getEntity(entity.id) ?? entity;
}

export type ListIdeasOpts = {
  status?: IdeaStatus | "all";
  label?: string;
  limit?: number;
};

export function listIdeas(canon: CanonStore, opts: ListIdeasOpts = {}): CanonEntity[] {
  const limit = opts.limit ?? 200;
  const statusFilter = opts.status ?? "pending";
  const labelFilter = opts.label?.trim().toLowerCase();

  const entities = canon.listEntities({ type: "idea", limit });

  return entities.filter((e) => {
    const payload = e.payload || {};
    const status = (payload.status as string) || "pending";
    if (statusFilter !== "all" && status !== statusFilter) return false;
    if (labelFilter) {
      const labels: string[] = Array.isArray(payload.labels) ? payload.labels : [];
      if (!labels.map((l) => l.toLowerCase()).includes(labelFilter)) return false;
    }
    return true;
  });
}

export function getIdea(canon: CanonStore, id: string): CanonEntity | undefined {
  const e = canon.getEntity(id);
  if (!e || e.type !== "idea") return undefined;
  return e;
}

export function markIdeaUsed(
  canon: CanonStore,
  id: string,
  generatedEntityId?: string
): CanonEntity | undefined {
  const e = getIdea(canon, id);
  if (!e) return undefined;
  const payload: Record<string, any> = {
    status: "used",
    usedAt: nowIso(),
  };
  if (generatedEntityId) payload.usedByEntityId = generatedEntityId;
  return canon.patchEntity(id, { payload });
}

export function deleteIdea(canon: CanonStore, id: string): boolean {
  const e = getIdea(canon, id);
  if (!e) return false;
  return canon.deleteEntity(id);
}

export function getIdeasNeedingLabels(canon: CanonStore): CanonEntity[] {
  return canon
    .listEntities({ type: "idea", limit: 5000 })
    .filter((e) => (e.payload?.labelsStatus as string) === "pending");
}

export function setIdeaLabels(
  canon: CanonStore,
  id: string,
  labels: readonly string[]
): CanonEntity | undefined {
  const normalized = normalizeLabels(labels);
  return canon.patchEntity(id, {
    payload: { labels: normalized, labelsStatus: "labeled" },
  });
}

export function markIdeaLabelingSkipped(canon: CanonStore, id: string): CanonEntity | undefined {
  return canon.patchEntity(id, { payload: { labelsStatus: "skipped" } });
}
