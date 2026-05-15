/**
 * idea-injection.ts - Centralised hooks for pulling pending Ideas into generation.
 *
 * Generators call `prepareIdeaInjection()` to:
 *   1. Resolve a forced idea (Director "use the mistlands idea" path), OR
 *   2. Pull a tiny label-matched candidate set (implicit path).
 *
 * The returned `promptAddition` is appended to the generator's prompt and the
 * `candidateIds` are passed to `markIdeasUsedFromOutput()` after the LLM call
 * to flip ideas to "used" when the model declares `usedIdeaId(s)` in its output.
 *
 * Ideas are NEVER auto-injected when the pool is empty — the prompt is unchanged
 * and there is no behavioural difference from today.
 */

import type { CanonEntity, CanonStore } from "./canon";
import { listIdeas, markIdeaUsed, getIdea } from "./ideas";
import { debugLog } from "../chat/debug-log";

export type IdeaInjectionAnchor = {
  burgId?: number;
  stateId?: number;
  cultureId?: number;
  religionId?: number;
  azgaarReligionId?: number;
  cellId?: number;
  locationId?: string;
  tags?: string[];
};

export type FetchCandidateIdeasOpts = {
  entityType: string;
  anchor?: IdeaInjectionAnchor;
  additionalLabels?: string[];
  limit?: number;
};

function normalizeLabel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim().toLowerCase();
  return t || undefined;
}

function buildTargetLabels(opts: FetchCandidateIdeasOpts): Set<string> {
  const labels = new Set<string>();
  const t = normalizeLabel(opts.entityType);
  if (t) labels.add(t);
  if (opts.additionalLabels) {
    for (const l of opts.additionalLabels) {
      const tag = normalizeLabel(l);
      if (tag) labels.add(tag);
    }
  }
  if (opts.anchor?.tags) {
    for (const tag of opts.anchor.tags) {
      const n = normalizeLabel(tag);
      if (n) labels.add(n);
    }
  }
  return labels;
}

/**
 * Return up to `limit` (default 3) pending ideas, most-recent-first, where:
 *  - idea.labels intersects target-label set, OR
 *  - idea.labels is empty (wildcard).
 *
 * Returns `[]` when nothing matches — callers will then skip injection entirely.
 */
export function fetchCandidateIdeas(
  canon: CanonStore,
  opts: FetchCandidateIdeasOpts
): CanonEntity[] {
  const limit = Math.max(0, opts.limit ?? 3);
  if (limit === 0) return [];

  const targetLabels = buildTargetLabels(opts);
  const pending = listIdeas(canon, { status: "pending", limit: 500 });

  const matching: CanonEntity[] = [];
  for (const idea of pending) {
    const labels: string[] = Array.isArray(idea.payload?.labels) ? idea.payload.labels : [];
    if (labels.length === 0) {
      matching.push(idea);
      continue;
    }
    if (labels.some((l) => targetLabels.has((l || "").toLowerCase()))) {
      matching.push(idea);
    }
    if (matching.length >= limit) break;
  }

  return matching.slice(0, limit);
}

function ideaText(idea: CanonEntity): string {
  return idea.details_md || idea.summary || idea.name;
}

/**
 * Build an "OPTIONAL DESIGN HINTS" prompt block. Returns "" when no ideas —
 * the caller's prompt is then unchanged from today (zero behavioural change).
 */
export function formatCandidateIdeasPrompt(ideas: CanonEntity[]): string {
  if (!ideas.length) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push("OPTIONAL DESIGN HINTS (pending ideas in pool):");
  for (const idea of ideas) {
    const labels: string[] = Array.isArray(idea.payload?.labels) ? idea.payload.labels : [];
    const labelStr = labels.length ? `  (labels: ${labels.join(", ")})` : "";
    lines.push(`  - [${idea.id}] ${ideaText(idea)}${labelStr}`);
  }
  lines.push("");
  lines.push(
    "Most generations should NOT use any of these. Only weave in 0-1 if it fits the entity naturally as subtle flavor — not the dominant theme. If you use one, include its ID as `usedIdeaId` (a string) in your JSON output. Otherwise omit `usedIdeaId`."
  );
  return lines.join("\n");
}

/**
 * Build a "USE THIS IDEA" prompt block for the explicit Director pathway.
 */
export function formatForcedIdeaPrompt(idea: CanonEntity): string {
  return [
    "",
    `USE THIS IDEA: [${idea.id}] ${ideaText(idea)}`,
    `Weave it meaningfully into the generated entity. After generation, return \`usedIdeaId: "${idea.id}"\` in your JSON output.`,
  ].join("\n");
}

export type PrepareIdeaInjectionOpts = FetchCandidateIdeasOpts & {
  canon: CanonStore;
  forceUseIdeaId?: string;
};

export type IdeaInjection = {
  promptAddition: string;
  candidateIds: string[];
  forced: boolean;
};

/**
 * Single-call setup: returns the prompt block to append and the candidate IDs
 * to pass back to `markIdeasUsedFromOutput()` after the LLM responds.
 *
 * Forced path: if `forceUseIdeaId` is set, the helper loads the idea and emits
 * a forcing prompt block. Already-used ideas still proceed (idempotent) with
 * a warning logged.
 *
 * Implicit path: otherwise, label-matched candidates are pulled from the pool.
 */
export function prepareIdeaInjection(opts: PrepareIdeaInjectionOpts): IdeaInjection {
  if (opts.forceUseIdeaId) {
    const idea = getIdea(opts.canon, opts.forceUseIdeaId);
    if (!idea) {
      debugLog(`[ideas] WARNING: forceUseIdeaId=${opts.forceUseIdeaId} not found in canon`);
    } else {
      if (idea.payload?.status === "used") {
        debugLog(`[ideas] WARNING: forceUseIdeaId=${opts.forceUseIdeaId} already used; forcing anyway (idempotent)`);
      }
      return {
        promptAddition: formatForcedIdeaPrompt(idea),
        candidateIds: [idea.id],
        forced: true,
      };
    }
  }

  const candidates = fetchCandidateIdeas(opts.canon, {
    entityType: opts.entityType,
    anchor: opts.anchor,
    additionalLabels: opts.additionalLabels,
    limit: opts.limit,
  });

  return {
    promptAddition: formatCandidateIdeasPrompt(candidates),
    candidateIds: candidates.map((c) => c.id),
    forced: false,
  };
}

/**
 * Inspect a parsed generator output for `usedIdeaId` (string) or `usedIdeaIds`
 * (string[]) and mark those ideas used. ONLY IDs in `candidateIds` are honoured;
 * hallucinated IDs are silently dropped (with a debug log).
 *
 * Returns the list of IDs actually marked (or already-used, idempotent).
 */
export function markIdeasUsedFromOutput(
  canon: CanonStore,
  output: any,
  generatedEntityId: string | undefined,
  candidateIds: string[]
): string[] {
  if (!output || typeof output !== "object") return [];
  if (!candidateIds.length) {
    if (output.usedIdeaId || output.usedIdeaIds) {
      debugLog(`[ideas] WARNING: model returned usedIdeaId(s) but no candidates were offered`);
    }
    return [];
  }

  const allowed = new Set(candidateIds);
  const ids = new Set<string>();

  if (typeof output.usedIdeaId === "string" && output.usedIdeaId.trim()) {
    ids.add(output.usedIdeaId.trim());
  }
  if (Array.isArray(output.usedIdeaIds)) {
    for (const v of output.usedIdeaIds) {
      if (typeof v === "string" && v.trim()) ids.add(v.trim());
    }
  }

  const used: string[] = [];
  for (const id of ids) {
    if (!allowed.has(id)) {
      debugLog(`[ideas] WARNING: model returned usedIdeaId=${id} not in offered set [${candidateIds.join(",")}]`);
      continue;
    }
    const idea = getIdea(canon, id);
    if (!idea) {
      debugLog(`[ideas] WARNING: usedIdeaId=${id} not found in canon`);
      continue;
    }
    if (idea.payload?.status === "used") {
      used.push(id);
      continue;
    }
    markIdeaUsed(canon, id, generatedEntityId);
    used.push(id);
  }

  return used;
}

/**
 * Emit a debug breadcrumb for a generation site so it's easy to verify in logs
 * whether ideas were offered and which (if any) the model picked.
 */
export function logIdeaBreadcrumb(siteName: string, offered: string[], used: string[]): void {
  const offeredStr = offered.length ? offered.join(",") : "none";
  const usedStr = used.length ? used.join(",") : "none";
  debugLog(`[ideas] ${siteName}: offered=[${offeredStr}] used=[${usedStr}]`);
}
