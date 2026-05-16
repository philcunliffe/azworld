import type { LLMClient } from "../../llm/providers";
import type { CanonStore } from "../../canon/canon";
import type {
  CampaignGenerators,
  CandidateDraft,
  GenerateArgs,
  GeneratorFn,
} from "../../campaign/tools";
import type { AnySlotKind } from "../../campaign/canon-mapping";

const SLOT_FOCUS: Record<AnySlotKind, string> = {
  region: "a geographic region (kingdom, free port, frontier valley, etc.) with biome, ruling culture, and current political shape",
  location: "a single concrete location inside the region (tavern, ruined keep, harbor district, monastery) where the PCs will physically be",
  event: "a recent or ongoing event that touches the region or location and gives the campaign forward motion",
  faction: "an organized group (guild, cult, mercantile house, rebel cell, mercenary band) with clear motives and a presence in the region or location",
  npcs: "an individual character the PCs are likely to meet, including a hook for what they want from the PCs",
  lore: "a single piece of background lore the players can learn (myth, ancient pact, lost ritual, dynastic feud)",
  hooks: "an adventure hook — a specific situation that pulls the PCs into action with stakes and a first step",
};

function buildSystemPrompt(slot: AnySlotKind): string {
  return `You are generating draft world-building candidates for a tabletop RPG campaign.

Slot focus: ${SLOT_FOCUS[slot]}.

Return ONLY a JSON object of the shape:
{ "candidates": [ { "name": string, "summary": string, "payload": object } ] }

Each candidate's payload is slot-specific. Use whatever shape best captures the entity (biome, alignment, leader, tags, etc.). Names must be evocative, not generic.
Summaries must be a single sentence — no more than 30 words.
Do not nest the candidates under any other key. Do not wrap in markdown.`;
}

function buildUserPrompt(slot: AnySlotKind, args: GenerateArgs, anchorContext: string): string {
  const parts: string[] = [];
  parts.push(`Generate ${args.count} candidate${args.count === 1 ? "" : "s"} for slot "${slot}".`);
  if (args.notes && args.notes.trim()) {
    parts.push(`Steering notes from the user: ${args.notes.trim()}`);
  }
  if (anchorContext) {
    parts.push(anchorContext);
  }
  if (args.seed) {
    parts.push(`Existing entity to revise (keep the name unless steering says otherwise):
- name: ${args.seed.name}
- summary: ${args.seed.summary}
- payload: ${JSON.stringify(args.seed.payload ?? {})}`);
  }
  parts.push(`Return ${args.count} distinct candidate${args.count === 1 ? "" : "s"} as JSON.`);
  return parts.join("\n\n");
}

function anchorContextFromCanon(canon: CanonStore, anchors?: GenerateArgs["anchors"]): string {
  if (!anchors) return "";
  const lines: string[] = [];
  if (anchors.regionEntityId) {
    const region = canon.getEntity(anchors.regionEntityId);
    if (region) {
      lines.push(`Anchored region "${region.name}": ${region.summary ?? "(no summary)"}.`);
    }
  }
  if (anchors.locationEntityId) {
    const location = canon.getEntity(anchors.locationEntityId);
    if (location) {
      lines.push(`Anchored location "${location.name}": ${location.summary ?? "(no summary)"}.`);
    }
  }
  return lines.join(" ");
}

function parseDrafts(raw: string): CandidateDraft[] {
  if (!raw || !raw.trim()) return [];
  let text = raw.trim();
  // Strip markdown fences if a provider added them despite the prompt.
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  }
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  let arr: any[] = [];
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (Array.isArray(parsed?.candidates)) {
    arr = parsed.candidates;
  } else if (parsed && typeof parsed === "object" && parsed.name) {
    arr = [parsed];
  }
  return arr
    .filter((c) => c && typeof c === "object")
    .map((c) => {
      const name = typeof c.name === "string" && c.name.trim() ? c.name.trim() : "Unnamed";
      const summary = typeof c.summary === "string" ? c.summary.trim() : "";
      const payload = c.payload && typeof c.payload === "object" && !Array.isArray(c.payload) ? c.payload : { ...c };
      return { name, summary, payload };
    });
}

function fillMissing(drafts: CandidateDraft[], wanted: number, slot: AnySlotKind): CandidateDraft[] {
  if (drafts.length >= wanted) return drafts.slice(0, wanted);
  const out = drafts.slice();
  while (out.length < wanted) {
    out.push({
      name: `Untitled ${slot} ${out.length + 1}`,
      summary: `Placeholder ${slot} candidate (model returned fewer drafts than requested).`,
      payload: {},
    });
  }
  return out;
}

export function createWebCampaignGenerators(llm: LLMClient, canon: CanonStore): CampaignGenerators {
  function makeGenerator(slot: AnySlotKind): GeneratorFn {
    return async (args: GenerateArgs) => {
      const wantedCount = Math.max(1, Math.floor(args.count));
      const anchorContext = anchorContextFromCanon(canon, args.anchors);
      const system = buildSystemPrompt(slot);
      const user = buildUserPrompt(slot, { ...args, count: wantedCount }, anchorContext);

      const result = await llm.complete({
        system,
        messages: [{ role: "user", content: user }],
        jsonMode: true,
        temperature: 0.7,
      });

      const drafts = parseDrafts(result.text);
      return fillMissing(drafts, wantedCount, slot);
    };
  }

  return {
    region: makeGenerator("region"),
    location: makeGenerator("location"),
    event: makeGenerator("event"),
    faction: makeGenerator("faction"),
    npcs: makeGenerator("npcs"),
    lore: makeGenerator("lore"),
    hooks: makeGenerator("hooks"),
  };
}
