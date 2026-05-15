import type { CanonStore, EntityType } from "../canon/canon";
import type { ToolDefinition } from "../llm/providers";
import type { CampaignSession } from "./session";
import {
  CampaignStateError,
  type Candidate,
  type MultiSlotKind,
  type SlotKind,
} from "./types";
import {
  SLOT_TO_ENTITY_TYPE,
  anchorRelationFor,
  isMultiSlot,
  type AnySlotKind,
} from "./canon-mapping";

// ── Generator contract ─────────────────────────────────────────────────────
// The chat / web layers supply implementations of these methods that wrap the
// existing `generate_*` helpers in `src/chat/tools/generate-tools.ts`. Each
// returns an array of candidate drafts that the tool layer turns into
// `Candidate` objects with stable `c-N` ids.

export interface GenerateArgs {
  count: number;
  notes?: string;
  anchors?: { regionEntityId?: string; locationEntityId?: string };
  seed?: { name: string; summary: string; payload: unknown };
}

export interface CandidateDraft {
  name: string;
  summary: string;
  payload: unknown;
}

export type GeneratorFn = (args: GenerateArgs) => Promise<CandidateDraft[]> | CandidateDraft[];

export interface CampaignGenerators {
  region: GeneratorFn;
  location: GeneratorFn;
  event: GeneratorFn;
  faction: GeneratorFn;
  npcs: GeneratorFn;
  lore: GeneratorFn;
  hooks: GeneratorFn;
}

export interface CampaignToolDeps {
  session: CampaignSession;
  canon: CanonStore;
  generators: CampaignGenerators;
}

// ── Tool argument shapes ───────────────────────────────────────────────────

export interface ProposeArgs {
  slot: AnySlotKind;
  count: number;
  constraints?: {
    notes?: string;
    anchors?: { regionEntityId?: string; locationEntityId?: string };
  };
}

export interface RefineArgs {
  slot: AnySlotKind;
  deltas: string;
  preserve?: string[];
}

export interface AcceptArgs {
  slot: AnySlotKind;
  candidateId: string;
}

export interface ReviseArgs {
  slot: AnySlotKind;
  candidateId?: string;
  deltas: string;
}

export interface UnacceptArgs {
  slot: AnySlotKind;
  candidateId?: string;
  deleteEntity?: boolean;
}

export interface SetNotesArgs {
  slot: SlotKind;
  notes: string;
}

// ── Result shapes ──────────────────────────────────────────────────────────

export type ToolError = { error: string };
export type ToolResult<T> = T | ToolError;

export interface GetStateResult {
  slots: ReturnType<CampaignSession["getState"]>["slots"];
  multi: Record<MultiSlotKind, { entries: { candidateId: string; entityId?: string; notes?: string }[] }>;
  history: ReturnType<CampaignSession["getState"]>["history"];
}

export interface ProposeResult {
  slot: AnySlotKind;
  candidates: Candidate[];
}

export interface AcceptResult {
  slot: AnySlotKind;
  entityId: string;
  summary: string;
}

export interface ReviseResult {
  slot: AnySlotKind;
  entityId: string;
  summary: string;
}

export interface UnacceptResult {
  slot: AnySlotKind;
  removedEntityId: string;
  deleted: boolean;
}

export interface SetNotesResult {
  slot: SlotKind;
  notes: string;
}

// ── Registry ───────────────────────────────────────────────────────────────

export interface CampaignToolRegistry {
  get_state(): GetStateResult;
  propose(args: ProposeArgs): Promise<ToolResult<ProposeResult>>;
  refine(args: RefineArgs): Promise<ToolResult<ProposeResult>>;
  accept(args: AcceptArgs): Promise<ToolResult<AcceptResult>>;
  revise(args: ReviseArgs): Promise<ToolResult<ReviseResult>>;
  unaccept(args: UnacceptArgs): Promise<ToolResult<UnacceptResult>>;
  set_notes(args: SetNotesArgs): ToolResult<SetNotesResult>;
  execute(name: string, args: any): Promise<unknown> | unknown;
  toolDefinitions: ToolDefinition[];
}

const HISTORY_TAIL = 20;

export function createCampaignToolRegistry(deps: CampaignToolDeps): CampaignToolRegistry {
  const pendingMulti: Map<MultiSlotKind, Candidate[]> = new Map();

  function callGenerator(slot: AnySlotKind, args: GenerateArgs): Promise<CandidateDraft[]> {
    const fn = deps.generators[slot];
    if (!fn) {
      throw new CampaignStateError(`no generator registered for slot ${slot}`);
    }
    return Promise.resolve(fn(args));
  }

  function autoAnchors(
    explicit?: { regionEntityId?: string; locationEntityId?: string }
  ): { regionEntityId?: string; locationEntityId?: string } {
    const state = deps.session.getState();
    const out: { regionEntityId?: string; locationEntityId?: string } = { ...(explicit ?? {}) };
    if (!out.regionEntityId && state.slots.region.status === "accepted" && state.slots.region.entityId) {
      out.regionEntityId = state.slots.region.entityId;
    }
    if (!out.locationEntityId && state.slots.location.status === "accepted" && state.slots.location.entityId) {
      out.locationEntityId = state.slots.location.entityId;
    }
    return out;
  }

  function currentCandidates(slot: AnySlotKind): Candidate[] {
    if (isMultiSlot(slot)) {
      return pendingMulti.get(slot) ?? [];
    }
    return deps.session.getState().slots[slot as SlotKind].candidates ?? [];
  }

  function renumber(preserved: Candidate[], drafts: CandidateDraft[]): Candidate[] {
    const out: Candidate[] = preserved.map((c) => ({ ...c }));
    const used = new Set(out.map((c) => c.id));
    let n = 1;
    for (const d of drafts) {
      let id = `c-${n}`;
      while (used.has(id)) {
        n += 1;
        id = `c-${n}`;
      }
      used.add(id);
      out.push({ id, name: d.name, summary: d.summary, payload: d.payload });
      n += 1;
    }
    return out;
  }

  function findAcceptedEntity(slot: AnySlotKind, candidateId?: string): { entityId?: string; candidateId?: string; error?: string } {
    const state = deps.session.getState();
    if (isMultiSlot(slot)) {
      if (!candidateId) return { error: `candidateId is required for multi slot ${slot}` };
      const entry = state.multi[slot].entries.find((e) => e.candidateId === candidateId);
      if (!entry) return { error: `no accepted entry with candidateId ${candidateId} in slot ${slot}` };
      return { entityId: entry.entityId, candidateId };
    }
    const sk = slot as SlotKind;
    const s = state.slots[sk];
    if (s.status !== "accepted") return { error: `slot ${sk} is not accepted` };
    return { entityId: s.entityId, candidateId: s.acceptedCandidateId };
  }

  function nowIso(): string {
    return new Date().toISOString();
  }

  // ── tool: get_state ─────────────────────────────────────────────────────
  function get_state(): GetStateResult {
    const state = deps.session.getState();
    return {
      slots: state.slots,
      multi: state.multi as GetStateResult["multi"],
      history: state.history.slice(-HISTORY_TAIL),
    };
  }

  // ── tool: propose ───────────────────────────────────────────────────────
  async function propose(args: ProposeArgs): Promise<ToolResult<ProposeResult>> {
    try {
      const count = Math.max(1, Math.floor(args.count));
      const state = deps.session.getState();
      const slot = args.slot;

      const explicit = args.constraints?.anchors;
      const anchors = autoAnchors(explicit);

      let notes = args.constraints?.notes;
      if (!isMultiSlot(slot)) {
        const slotNotes = state.slots[slot as SlotKind].notes;
        if (slotNotes) {
          notes = notes ? `${slotNotes}\n${notes}` : slotNotes;
        }
      }

      const drafts = await callGenerator(slot, { count, notes, anchors });
      const candidates: Candidate[] = drafts.map((d, i) => ({
        id: `c-${i + 1}`,
        name: d.name,
        summary: d.summary,
        payload: d.payload,
      }));

      if (isMultiSlot(slot)) {
        pendingMulti.set(slot, candidates);
      } else {
        deps.session.setSlotProposed(slot as SlotKind, candidates);
      }

      return { slot, candidates };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  // ── tool: refine ────────────────────────────────────────────────────────
  async function refine(args: RefineArgs): Promise<ToolResult<ProposeResult>> {
    try {
      const slot = args.slot;
      const current = currentCandidates(slot);
      if (current.length === 0) {
        return { error: `no candidates to refine in slot ${slot} — call propose first` };
      }

      const preserveIds = new Set(args.preserve ?? []);
      const preserved = current.filter((c) => preserveIds.has(c.id));
      const needed = Math.max(1, current.length - preserved.length);

      const anchors = autoAnchors();
      const drafts = await callGenerator(slot, { count: needed, notes: args.deltas, anchors });
      const candidates = renumber(preserved, drafts);

      if (isMultiSlot(slot)) {
        pendingMulti.set(slot, candidates);
      } else {
        deps.session.setSlotProposed(slot as SlotKind, candidates);
      }
      return { slot, candidates };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  // ── tool: accept ────────────────────────────────────────────────────────
  async function accept(args: AcceptArgs): Promise<ToolResult<AcceptResult>> {
    try {
      const slot = args.slot;
      let candidate: Candidate | undefined;
      if (isMultiSlot(slot)) {
        const pending = pendingMulti.get(slot) ?? [];
        candidate = pending.find((c) => c.id === args.candidateId);
      } else {
        const slotState = deps.session.getState().slots[slot as SlotKind];
        candidate = slotState.candidates?.find((c) => c.id === args.candidateId);
      }
      if (!candidate) {
        return { error: `candidate ${args.candidateId} not found in slot ${slot}` };
      }

      const state = deps.session.getState();
      const anchors: Record<string, any> = {};
      if (state.slots.region.status === "accepted" && state.slots.region.entityId && slot !== "region") {
        anchors.regionEntityId = state.slots.region.entityId;
      }
      if (
        state.slots.location.status === "accepted" &&
        state.slots.location.entityId &&
        (slot === "npcs" || slot === "lore" || slot === "hooks")
      ) {
        anchors.locationEntityId = state.slots.location.entityId;
      }

      const entityType = SLOT_TO_ENTITY_TYPE[slot];
      const newEntity = deps.canon.addEntity({
        type: entityType as EntityType,
        name: candidate.name,
        summary: candidate.summary,
        payload: toPayloadObject(candidate.payload),
        anchors,
        provenance: {
          source: "campaign-builder",
          campaign_id: deps.session.id,
          candidate_id: candidate.id,
          accepted_at: nowIso(),
        },
      });

      if (state.slots.region.status === "accepted" && state.slots.region.entityId && slot !== "region") {
        const rel = anchorRelationFor(slot, "region");
        if (rel) {
          deps.canon.addRelation({
            from_id: newEntity.id,
            to_id: state.slots.region.entityId,
            rel_type: rel,
          });
        }
      }
      if (
        state.slots.location.status === "accepted" &&
        state.slots.location.entityId &&
        (slot === "npcs" || slot === "lore" || slot === "hooks")
      ) {
        const rel = anchorRelationFor(slot, "location");
        if (rel) {
          deps.canon.addRelation({
            from_id: newEntity.id,
            to_id: state.slots.location.entityId,
            rel_type: rel,
          });
        }
      }

      if (isMultiSlot(slot)) {
        deps.session.addMultiEntry(slot, { candidateId: candidate.id, entityId: newEntity.id });
        const pending = pendingMulti.get(slot) ?? [];
        pendingMulti.set(slot, pending.filter((c) => c.id !== candidate!.id));
      } else {
        deps.session.acceptSlot(slot as SlotKind, candidate.id, newEntity.id);
      }

      return { slot, entityId: newEntity.id, summary: candidate.summary };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  // ── tool: revise ────────────────────────────────────────────────────────
  async function revise(args: ReviseArgs): Promise<ToolResult<ReviseResult>> {
    try {
      const lookup = findAcceptedEntity(args.slot, args.candidateId);
      if (lookup.error) return { error: lookup.error };
      if (!lookup.entityId) return { error: `slot ${args.slot} has no canon entity id` };

      const existing = deps.canon.getEntity(lookup.entityId);
      if (!existing) return { error: `entity ${lookup.entityId} not found in canon` };

      const seed: GenerateArgs["seed"] = {
        name: existing.name,
        summary: existing.summary ?? "",
        payload: existing.payload,
      };
      const drafts = await callGenerator(args.slot, {
        count: 1,
        notes: args.deltas,
        anchors: autoAnchors(),
        seed,
      });
      if (drafts.length === 0) return { error: "generator returned no drafts" };
      const draft = drafts[0]!;

      const prevRevisions = Array.isArray(existing.provenance?.revised_at)
        ? (existing.provenance.revised_at as unknown[])
        : [];
      const updated = deps.canon.patchEntity(lookup.entityId, {
        name: draft.name,
        summary: draft.summary,
        payload: toPayloadObject(draft.payload),
        provenance: {
          revised_at: [...prevRevisions, { ts: nowIso(), deltas: args.deltas }],
        },
      });

      return {
        slot: args.slot,
        entityId: lookup.entityId,
        summary: updated?.summary ?? draft.summary,
      };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  // ── tool: unaccept ──────────────────────────────────────────────────────
  async function unaccept(args: UnacceptArgs): Promise<ToolResult<UnacceptResult>> {
    try {
      const lookup = findAcceptedEntity(args.slot, args.candidateId);
      if (lookup.error) return { error: lookup.error };
      if (!lookup.entityId) return { error: `slot ${args.slot} has no canon entity id` };

      if (args.deleteEntity) {
        deps.canon.deleteEntity(lookup.entityId);
      } else {
        deps.canon.patchEntity(lookup.entityId, {
          provenance: { campaign_id: null as unknown as undefined },
        });
      }

      if (isMultiSlot(args.slot)) {
        if (lookup.candidateId) {
          deps.session.removeMultiEntry(args.slot, lookup.candidateId);
        }
      } else {
        deps.session.resetSlot(args.slot as SlotKind);
      }

      return {
        slot: args.slot,
        removedEntityId: lookup.entityId,
        deleted: !!args.deleteEntity,
      };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  // ── tool: set_notes ─────────────────────────────────────────────────────
  function set_notes(args: SetNotesArgs): ToolResult<SetNotesResult> {
    try {
      if (isMultiSlot(args.slot as AnySlotKind)) {
        return { error: `set_notes only supports singleton slots, got ${args.slot}` };
      }
      deps.session.setSlotNotes(args.slot, args.notes);
      return { slot: args.slot, notes: args.notes };
    } catch (e) {
      return { error: errorMessage(e) };
    }
  }

  async function execute(name: string, args: any): Promise<unknown> {
    switch (name) {
      case "campaign.get_state":
        return get_state();
      case "campaign.propose":
        return propose(args);
      case "campaign.refine":
        return refine(args);
      case "campaign.accept":
        return accept(args);
      case "campaign.revise":
        return revise(args);
      case "campaign.unaccept":
        return unaccept(args);
      case "campaign.set_notes":
        return set_notes(args);
      default:
        return { error: `unknown campaign tool: ${name}` };
    }
  }

  return {
    get_state,
    propose,
    refine,
    accept,
    revise,
    unaccept,
    set_notes,
    execute,
    toolDefinitions: TOOL_DEFINITIONS,
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof CampaignStateError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

function toPayloadObject(payload: unknown): Record<string, any> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, any>;
  }
  return { value: payload };
}

const SLOT_ENUM: AnySlotKind[] = ["region", "location", "event", "faction", "npcs", "lore", "hooks"];

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "campaign.get_state",
    description:
      "Return the current campaign state: every slot's status (open/proposed/accepted), proposed candidates, accepted entity ids, slot notes, and the last 20 history entries.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "campaign.propose",
    description:
      "Generate fresh candidates for a slot. For singleton slots this flips the slot to 'proposed'; for multi slots the candidates are held in a pending buffer until accepted. Region/location anchors from already-accepted slots are auto-applied.",
    parameters: {
      type: "object",
      properties: {
        slot: { type: "string", description: "Slot kind", enum: SLOT_ENUM as unknown as string[] },
        count: { type: "number", description: "How many candidates to generate (>=1)" },
        constraints: {
          type: "object",
          description: "Optional steering — { notes?: string, anchors?: { regionEntityId?, locationEntityId? } }",
        },
      },
      required: ["slot", "count"],
    },
  },
  {
    name: "campaign.refine",
    description:
      "Re-generate candidates for an already-proposed slot using deltas as the steering text. Optionally preserve specific candidate ids (they keep their c-N id).",
    parameters: {
      type: "object",
      properties: {
        slot: { type: "string", description: "Slot kind", enum: SLOT_ENUM as unknown as string[] },
        deltas: { type: "string", description: "How the candidates should change" },
        preserve: { type: "string", description: "JSON array of candidate ids to keep unchanged" },
      },
      required: ["slot", "deltas"],
    },
  },
  {
    name: "campaign.accept",
    description:
      "Accept a proposed candidate. Writes the candidate to canon as a new entity with provenance.campaign_id, creates anchor relations (in_region, occupies, anchored_in_region) where applicable, and updates the session.",
    parameters: {
      type: "object",
      properties: {
        slot: { type: "string", description: "Slot kind", enum: SLOT_ENUM as unknown as string[] },
        candidateId: { type: "string", description: "Candidate id (e.g. c-2)" },
      },
      required: ["slot", "candidateId"],
    },
  },
  {
    name: "campaign.revise",
    description:
      "Re-generate the body of an already-accepted entity using deltas as steering text. Updates the canon entity in place and appends a revision record to provenance.revised_at.",
    parameters: {
      type: "object",
      properties: {
        slot: { type: "string", description: "Slot kind", enum: SLOT_ENUM as unknown as string[] },
        candidateId: {
          type: "string",
          description: "Required for multi slots; implied for singletons",
        },
        deltas: { type: "string", description: "How the entity should change" },
      },
      required: ["slot", "deltas"],
    },
  },
  {
    name: "campaign.unaccept",
    description:
      "Detach an accepted entity from the campaign. If deleteEntity is true, remove the canon entity and its relations; otherwise leave the entity in place but strip provenance.campaign_id so it becomes standalone.",
    parameters: {
      type: "object",
      properties: {
        slot: { type: "string", description: "Slot kind", enum: SLOT_ENUM as unknown as string[] },
        candidateId: {
          type: "string",
          description: "Required for multi slots; implied for singletons",
        },
        deleteEntity: {
          type: "string",
          description: "Pass 'true' to delete the canon entity (default false)",
        },
      },
      required: ["slot"],
    },
  },
  {
    name: "campaign.set_notes",
    description:
      "Persist free-form steering notes on a singleton slot. The notes feed into future propose/refine calls for that slot.",
    parameters: {
      type: "object",
      properties: {
        slot: {
          type: "string",
          description: "Singleton slot kind",
          enum: ["region", "location", "event", "faction"],
        },
        notes: { type: "string", description: "Steering text" },
      },
      required: ["slot", "notes"],
    },
  },
];
