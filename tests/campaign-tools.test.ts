import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CampaignStore } from "../src/campaign/store";
import { CampaignSession } from "../src/campaign/session";
import {
  createCampaignToolRegistry,
  type CampaignGenerators,
  type CampaignToolRegistry,
  type CandidateDraft,
  type GenerateArgs,
} from "../src/campaign/tools";
import {
  SLOT_TO_ENTITY_TYPE,
  anchorRelationFor,
  isMultiSlot,
} from "../src/campaign/canon-mapping";
import { CAMPAIGN_BUILDER_SYSTEM_PROMPT } from "../src/campaign/prompt";
import type { CanonEntity, CanonRelation, CanonStore } from "../src/canon/canon";

// ── Mock canon store ───────────────────────────────────────────────────────
// Records calls + minimal in-memory state. Satisfies the CanonStore shape
// the tool layer touches: addEntity, addRelation, getEntity, patchEntity,
// deleteEntity. Other methods throw so accidental use surfaces in tests.

interface MockEntity extends CanonEntity {}
interface MockRelation extends CanonRelation {}

class MockCanon {
  entities: Map<string, MockEntity> = new Map();
  relations: Map<string, MockRelation> = new Map();
  addEntityCalls: any[] = [];
  addRelationCalls: any[] = [];
  patchEntityCalls: any[] = [];
  deleteEntityCalls: string[] = [];
  deleteRelationCalls: string[] = [];
  private nextId = 1;

  addEntity(opts: any): MockEntity {
    this.addEntityCalls.push(opts);
    const id = opts.entity_id ?? `ent-${this.nextId++}`;
    const now = "2026-05-15T00:00:00Z";
    const e: MockEntity = {
      id,
      type: opts.type,
      name: opts.name,
      summary: opts.summary ?? null,
      details_md: opts.details_md ?? null,
      tags: opts.tags ?? [],
      anchors: opts.anchors ?? {},
      payload: opts.payload ?? {},
      meta: opts.meta ?? {},
      provenance: opts.provenance ?? {},
      created_at: now,
      updated_at: now,
    };
    this.entities.set(id, e);
    return e;
  }

  addRelation(opts: any): MockRelation {
    this.addRelationCalls.push(opts);
    const id = opts.relation_id ?? `rel-${this.nextId++}`;
    const now = "2026-05-15T00:00:00Z";
    const r: MockRelation = {
      id,
      from_id: opts.from_id,
      to_id: opts.to_id,
      rel_type: opts.rel_type,
      strength: opts.strength ?? null,
      notes: opts.notes ?? null,
      created_at: now,
    };
    this.relations.set(id, r);
    return r;
  }

  getEntity(id: string): MockEntity | undefined {
    return this.entities.get(id);
  }

  patchEntity(id: string, patch: any): MockEntity | undefined {
    this.patchEntityCalls.push({ id, patch });
    const existing = this.entities.get(id);
    if (!existing) return undefined;
    const provenance = mergeShallow(existing.provenance, patch.provenance);
    const updated: MockEntity = {
      ...existing,
      name: patch.name ?? existing.name,
      summary: patch.summary ?? existing.summary,
      payload: mergeShallow(existing.payload, patch.payload),
      provenance,
    };
    this.entities.set(id, updated);
    return updated;
  }

  deleteEntity(id: string): boolean {
    this.deleteEntityCalls.push(id);
    const had = this.entities.has(id);
    this.entities.delete(id);
    // simulate FK cascade
    for (const [rid, r] of [...this.relations.entries()]) {
      if (r.from_id === id || r.to_id === id) this.relations.delete(rid);
    }
    return had;
  }
}

function mergeShallow(base: any, patch: any): any {
  if (patch === undefined) return base ?? {};
  if (patch === null) return null;
  if (typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: any = { ...(typeof base === "object" && base && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (typeof v === "object" && v && !Array.isArray(v)) out[k] = mergeShallow(out[k], v);
    else out[k] = v;
  }
  return out;
}

// ── Mock generators ────────────────────────────────────────────────────────

interface GeneratorCall {
  slot: string;
  args: GenerateArgs;
}

function buildGenerators(
  calls: GeneratorCall[],
  buildDrafts: (slot: string, args: GenerateArgs) => CandidateDraft[]
): CampaignGenerators {
  function wrap(slot: string) {
    return (args: GenerateArgs) => {
      calls.push({ slot, args });
      return buildDrafts(slot, args);
    };
  }
  return {
    region: wrap("region"),
    location: wrap("location"),
    event: wrap("event"),
    faction: wrap("faction"),
    npcs: wrap("npcs"),
    lore: wrap("lore"),
    hooks: wrap("hooks"),
  };
}

function defaultDrafts(slot: string, args: GenerateArgs): CandidateDraft[] {
  const out: CandidateDraft[] = [];
  for (let i = 1; i <= args.count; i++) {
    out.push({
      name: `${slot}-name-${i}`,
      summary: `${slot} summary ${i}`,
      payload: { kind: slot, idx: i, notes: args.notes ?? null },
    });
  }
  return out;
}

// ── Test rig ───────────────────────────────────────────────────────────────

function freshStore(): CampaignStore {
  const db = new Database(":memory:");
  const store = new CampaignStore(db);
  store.initDb();
  return store;
}

function newRig(opts: {
  buildDrafts?: (slot: string, args: GenerateArgs) => CandidateDraft[];
} = {}) {
  const store = freshStore();
  const session = CampaignSession.create(store, { name: "Test" });
  const canon = new MockCanon();
  const generatorCalls: GeneratorCall[] = [];
  const generators = buildGenerators(generatorCalls, opts.buildDrafts ?? defaultDrafts);
  const tools = createCampaignToolRegistry({
    session,
    canon: canon as unknown as CanonStore,
    generators,
  });
  return { store, session, canon, generators, generatorCalls, tools };
}

// ── canon-mapping unit tests ───────────────────────────────────────────────

describe("canon-mapping", () => {
  test("SLOT_TO_ENTITY_TYPE matches the bead-specified strings", () => {
    expect(SLOT_TO_ENTITY_TYPE.region).toBe("region");
    expect(SLOT_TO_ENTITY_TYPE.location).toBe("location");
    expect(SLOT_TO_ENTITY_TYPE.event).toBe("event");
    expect(SLOT_TO_ENTITY_TYPE.faction).toBe("faction");
    expect(SLOT_TO_ENTITY_TYPE.npcs).toBe("npc");
    expect(SLOT_TO_ENTITY_TYPE.lore).toBe("lore");
    expect(SLOT_TO_ENTITY_TYPE.hooks).toBe("hook");
  });

  test("anchorRelationFor matches bead examples", () => {
    expect(anchorRelationFor("location", "region")).toBe("in_region");
    expect(anchorRelationFor("npcs", "location")).toBe("occupies");
    expect(anchorRelationFor("hooks", "region")).toBe("anchored_in_region");
  });

  test("isMultiSlot identifies multi slots", () => {
    expect(isMultiSlot("region")).toBe(false);
    expect(isMultiSlot("faction")).toBe(false);
    expect(isMultiSlot("npcs")).toBe(true);
    expect(isMultiSlot("lore")).toBe(true);
    expect(isMultiSlot("hooks")).toBe(true);
  });
});

// ── tool: propose ─────────────────────────────────────────────────────────

describe("campaign.propose", () => {
  test("singleton: calls generator with count, flips slot to proposed", async () => {
    const rig = newRig();
    const res = await rig.tools.propose({ slot: "region", count: 3 });
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.candidates.length).toBe(3);
    expect(res.candidates.map((c) => c.id)).toEqual(["c-1", "c-2", "c-3"]);

    expect(rig.generatorCalls.length).toBe(1);
    expect(rig.generatorCalls[0]!.slot).toBe("region");
    expect(rig.generatorCalls[0]!.args.count).toBe(3);

    const slot = rig.session.getState().slots.region;
    expect(slot.status).toBe("proposed");
    expect(slot.candidates?.length).toBe(3);
  });

  test("multi: stashes pending candidates, does NOT call session.addMultiEntry", async () => {
    const rig = newRig();
    const res = await rig.tools.propose({ slot: "npcs", count: 2 });
    expect("error" in res).toBe(false);

    expect(rig.session.getState().multi.npcs.entries.length).toBe(0);

    // Re-proposing returns a new list; pending replaces.
    const res2 = await rig.tools.propose({ slot: "npcs", count: 4 });
    expect("error" in res2).toBe(false);
    if ("error" in res2) return;
    expect(res2.candidates.length).toBe(4);
    expect(rig.session.getState().multi.npcs.entries.length).toBe(0);
  });

  test("auto-anchors region entity id when region is accepted", async () => {
    const rig = newRig();
    // Manually mark region as accepted with a fake entity id
    rig.session.setSlotProposed("region", [
      { id: "c-1", name: "R", summary: "s", payload: {} },
    ]);
    rig.session.acceptSlot("region", "c-1", "region-ent-1");

    await rig.tools.propose({ slot: "location", count: 1 });
    const call = rig.generatorCalls.find((c) => c.slot === "location");
    expect(call?.args.anchors?.regionEntityId).toBe("region-ent-1");
  });

  test("slot notes feed into the generator's notes arg", async () => {
    const rig = newRig();
    rig.session.setSlotNotes("region", "more dangerous, bandits");
    await rig.tools.propose({ slot: "region", count: 1 });
    const call = rig.generatorCalls.find((c) => c.slot === "region");
    expect(call?.args.notes).toContain("more dangerous");
  });
});

// ── tool: accept ──────────────────────────────────────────────────────────

describe("campaign.accept", () => {
  test("singleton: writes canon entity with correct type and provenance.campaign_id", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "region", count: 2 });

    const res = await rig.tools.accept({ slot: "region", candidateId: "c-1" });
    expect("error" in res).toBe(false);
    if ("error" in res) return;

    expect(rig.canon.addEntityCalls.length).toBe(1);
    const call = rig.canon.addEntityCalls[0]!;
    expect(call.type).toBe("region");
    expect(call.name).toBe("region-name-1");
    expect(call.provenance.source).toBe("campaign-builder");
    expect(call.provenance.campaign_id).toBe(rig.session.id);
    expect(call.provenance.candidate_id).toBe("c-1");
    expect(typeof call.provenance.accepted_at).toBe("string");

    expect(rig.session.getState().slots.region.status).toBe("accepted");
    expect(rig.session.getState().slots.region.entityId).toBe(res.entityId);
  });

  test("singleton: creates 'in_region' relation when location is accepted under a region", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "region", count: 1 });
    const regionAccept = await rig.tools.accept({ slot: "region", candidateId: "c-1" });
    expect("error" in regionAccept).toBe(false);

    await rig.tools.propose({ slot: "location", count: 1 });
    const locAccept = await rig.tools.accept({ slot: "location", candidateId: "c-1" });
    expect("error" in locAccept).toBe(false);
    if ("error" in locAccept) return;

    expect(rig.canon.addRelationCalls.length).toBe(1);
    const rel = rig.canon.addRelationCalls[0]!;
    expect(rel.rel_type).toBe("in_region");
    expect(rel.from_id).toBe(locAccept.entityId);
    expect(rel.to_id).toBe(rig.session.getState().slots.region.entityId);
  });

  test("multi: moves pending → session.multi.entries", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "npcs", count: 3 });
    expect(rig.session.getState().multi.npcs.entries.length).toBe(0);

    const res = await rig.tools.accept({ slot: "npcs", candidateId: "c-2" });
    expect("error" in res).toBe(false);
    if ("error" in res) return;

    const entries = rig.session.getState().multi.npcs.entries;
    expect(entries.length).toBe(1);
    expect(entries[0]!.candidateId).toBe("c-2");
    expect(entries[0]!.entityId).toBe(res.entityId);

    // Accepting c-2 again should now fail (it has been consumed from pending)
    const repeat = await rig.tools.accept({ slot: "npcs", candidateId: "c-2" });
    expect("error" in repeat).toBe(true);
  });

  test("multi npc under accepted location: creates 'occupies' relation", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "region", count: 1 });
    await rig.tools.accept({ slot: "region", candidateId: "c-1" });
    await rig.tools.propose({ slot: "location", count: 1 });
    await rig.tools.accept({ slot: "location", candidateId: "c-1" });
    rig.canon.addRelationCalls.length = 0;

    await rig.tools.propose({ slot: "npcs", count: 1 });
    const accept = await rig.tools.accept({ slot: "npcs", candidateId: "c-1" });
    expect("error" in accept).toBe(false);

    const relTypes = rig.canon.addRelationCalls.map((c) => c.rel_type);
    expect(relTypes).toContain("in_region");
    expect(relTypes).toContain("occupies");
  });

  test("accept on an open slot returns { error }", async () => {
    const rig = newRig();
    const res = await rig.tools.accept({ slot: "region", candidateId: "c-1" });
    expect("error" in res).toBe(true);
  });

  test("accept never throws — bad candidate id returns { error }", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "region", count: 1 });
    const res = await rig.tools.accept({ slot: "region", candidateId: "c-nope" });
    expect("error" in res).toBe(true);
  });
});

// ── tool: revise ──────────────────────────────────────────────────────────

describe("campaign.revise", () => {
  test("calls canon.patchEntity and appends to provenance.revised_at", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "region", count: 1 });
    const ac = await rig.tools.accept({ slot: "region", candidateId: "c-1" });
    expect("error" in ac).toBe(false);
    if ("error" in ac) return;

    const res = await rig.tools.revise({ slot: "region", deltas: "make it stormier" });
    expect("error" in res).toBe(false);

    expect(rig.canon.patchEntityCalls.length).toBe(1);
    const patch = rig.canon.patchEntityCalls[0]!;
    expect(patch.id).toBe(ac.entityId);
    expect(Array.isArray(patch.patch.provenance.revised_at)).toBe(true);
    expect(patch.patch.provenance.revised_at.length).toBe(1);
    expect(patch.patch.provenance.revised_at[0].deltas).toBe("make it stormier");

    // Second revise appends, not replaces.
    await rig.tools.revise({ slot: "region", deltas: "also colder" });
    const lastPatch = rig.canon.patchEntityCalls.at(-1)!;
    expect(lastPatch.patch.provenance.revised_at.length).toBe(2);
    expect(lastPatch.patch.provenance.revised_at[1].deltas).toBe("also colder");
  });

  test("revise on multi slot requires candidateId", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "npcs", count: 1 });
    await rig.tools.accept({ slot: "npcs", candidateId: "c-1" });

    const noCid = await rig.tools.revise({ slot: "npcs", deltas: "older" });
    expect("error" in noCid).toBe(true);

    const withCid = await rig.tools.revise({ slot: "npcs", candidateId: "c-1", deltas: "older" });
    expect("error" in withCid).toBe(false);
  });

  test("revise on an open slot returns { error }", async () => {
    const rig = newRig();
    const res = await rig.tools.revise({ slot: "region", deltas: "x" });
    expect("error" in res).toBe(true);
  });
});

// ── tool: unaccept ────────────────────────────────────────────────────────

describe("campaign.unaccept", () => {
  test("deleteEntity=true calls canon.deleteEntity and resets the slot", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "region", count: 1 });
    const ac = await rig.tools.accept({ slot: "region", candidateId: "c-1" });
    if ("error" in ac) throw new Error("setup failed");
    // simulate that a child relation existed
    rig.canon.addRelation({ from_id: "other", to_id: ac.entityId, rel_type: "in_region" });
    expect(rig.canon.relations.size).toBeGreaterThan(0);

    const res = await rig.tools.unaccept({ slot: "region", deleteEntity: true });
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.deleted).toBe(true);
    expect(res.removedEntityId).toBe(ac.entityId);

    expect(rig.canon.deleteEntityCalls).toContain(ac.entityId);
    // FK-cascade: relations referencing the deleted entity are gone.
    expect(rig.canon.relations.size).toBe(0);
    expect(rig.session.getState().slots.region.status).toBe("open");
  });

  test("deleteEntity=false keeps the entity but strips campaign_id from provenance", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "region", count: 1 });
    const ac = await rig.tools.accept({ slot: "region", candidateId: "c-1" });
    if ("error" in ac) throw new Error("setup failed");

    const before = rig.canon.getEntity(ac.entityId)!;
    expect(before.provenance.campaign_id).toBe(rig.session.id);

    const res = await rig.tools.unaccept({ slot: "region" });
    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.deleted).toBe(false);

    // Entity still present in canon
    const after = rig.canon.getEntity(ac.entityId);
    expect(after).toBeDefined();
    expect(after?.provenance.campaign_id).toBeUndefined();
    // Other provenance keys preserved
    expect(after?.provenance.source).toBe("campaign-builder");

    expect(rig.session.getState().slots.region.status).toBe("open");
  });

  test("multi: deleteEntity=true removes the entry from session.multi", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "npcs", count: 2 });
    const ac1 = await rig.tools.accept({ slot: "npcs", candidateId: "c-1" });
    const ac2 = await rig.tools.accept({ slot: "npcs", candidateId: "c-2" });
    if ("error" in ac1 || "error" in ac2) throw new Error("setup failed");
    expect(rig.session.getState().multi.npcs.entries.length).toBe(2);

    const res = await rig.tools.unaccept({ slot: "npcs", candidateId: "c-1", deleteEntity: true });
    expect("error" in res).toBe(false);

    const entries = rig.session.getState().multi.npcs.entries;
    expect(entries.length).toBe(1);
    expect(entries[0]!.candidateId).toBe("c-2");
  });
});

// ── tool: refine ──────────────────────────────────────────────────────────

describe("campaign.refine", () => {
  test("preserve keeps candidate ids, new candidates get fresh c-N ids", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "region", count: 3 });
    const before = rig.session.getState().slots.region.candidates!;
    expect(before.map((c) => c.id)).toEqual(["c-1", "c-2", "c-3"]);

    const res = await rig.tools.refine({
      slot: "region",
      deltas: "more wintery",
      preserve: ["c-2"],
    });
    expect("error" in res).toBe(false);
    if ("error" in res) return;

    const ids = res.candidates.map((c) => c.id);
    expect(ids).toContain("c-2"); // preserved
    expect(res.candidates.find((c) => c.id === "c-2")!.name).toBe(before[1]!.name);
    // New ones got fresh ids not equal to c-2
    expect(res.candidates.filter((c) => c.id !== "c-2").length).toBeGreaterThan(0);
  });

  test("refine without prior propose returns { error }", async () => {
    const rig = newRig();
    const res = await rig.tools.refine({ slot: "region", deltas: "x" });
    expect("error" in res).toBe(true);
  });

  test("refine on multi slot uses pendingMulti, not session entries", async () => {
    const rig = newRig();
    await rig.tools.propose({ slot: "lore", count: 2 });
    const res = await rig.tools.refine({ slot: "lore", deltas: "darker" });
    expect("error" in res).toBe(false);
    expect(rig.session.getState().multi.lore.entries.length).toBe(0);
  });
});

// ── tool: set_notes ───────────────────────────────────────────────────────

describe("campaign.set_notes", () => {
  test("stores notes on a singleton slot", () => {
    const rig = newRig();
    const res = rig.tools.set_notes({ slot: "faction", notes: "criminal" });
    expect("error" in res).toBe(false);
    expect(rig.session.getState().slots.faction.notes).toBe("criminal");
  });

  test("rejects multi slot", () => {
    const rig = newRig();
    const res = rig.tools.set_notes({ slot: "npcs" as any, notes: "x" });
    expect("error" in res).toBe(true);
  });
});

// ── tool: get_state ───────────────────────────────────────────────────────

describe("campaign.get_state", () => {
  test("returns slots, multi, and the tail of history (last 20)", () => {
    const rig = newRig();
    for (let i = 0; i < 25; i++) {
      rig.session.appendHistory({ kind: "user", text: `m${i}`, ts: "t" });
    }
    const state = rig.tools.get_state();
    expect(state.history.length).toBe(20);
    expect(state.history[0]!.kind).toBe("user");
    expect(Object.keys(state.slots)).toEqual(
      expect.arrayContaining(["region", "location", "event", "faction"])
    );
    expect(Object.keys(state.multi)).toEqual(
      expect.arrayContaining(["npcs", "lore", "hooks"])
    );
  });
});

// ── execute() dispatcher ──────────────────────────────────────────────────

describe("CampaignToolRegistry.execute", () => {
  test("dispatches by tool name", async () => {
    const rig = newRig();
    const res = await rig.tools.execute("campaign.propose", { slot: "region", count: 1 });
    expect((res as any).candidates.length).toBe(1);
  });

  test("unknown tool name returns an error envelope", async () => {
    const rig = newRig();
    const res = await rig.tools.execute("campaign.bogus", {});
    expect((res as any).error).toContain("unknown");
  });
});

// ── prompt sanity check ───────────────────────────────────────────────────

describe("CAMPAIGN_BUILDER_SYSTEM_PROMPT", () => {
  test("is under 1500 characters", () => {
    expect(CAMPAIGN_BUILDER_SYSTEM_PROMPT.length).toBeLessThan(1500);
  });

  test("names every slot kind explicitly", () => {
    for (const slot of ["region", "location", "event", "faction", "npcs", "lore", "hooks"]) {
      expect(CAMPAIGN_BUILDER_SYSTEM_PROMPT.toLowerCase()).toContain(slot);
    }
  });
});

// Suppress unused-import warning for type sanity
const _typeSanity: CampaignToolRegistry | null = null;
beforeEach(() => {
  void _typeSanity;
});
