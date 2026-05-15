import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CampaignStore } from "../src/campaign/store";
import { CampaignSession } from "../src/campaign/session";
import {
  CampaignStateError,
  type Candidate,
  emptyState,
} from "../src/campaign/types";

function freshStore(): CampaignStore {
  const db = new Database(":memory:");
  const store = new CampaignStore(db);
  store.initDb();
  return store;
}

function makeCandidate(id: string, name = `cand-${id}`): Candidate {
  return { id, name, summary: `${name} summary`, payload: { kind: "test" } };
}

describe("emptyState()", () => {
  test("singleton slots are open and multi slots have empty entries", () => {
    const state = emptyState();
    for (const kind of ["region", "location", "event", "faction"] as const) {
      expect(state.slots[kind]).toEqual({ status: "open" });
    }
    for (const kind of ["npcs", "lore", "hooks"] as const) {
      expect(state.multi[kind]).toEqual({ entries: [] });
    }
    expect(state.history).toEqual([]);
  });
});

describe("CampaignSession slot lifecycle", () => {
  test("setSlotProposed flips open to proposed and stores candidates", () => {
    const store = freshStore();
    const session = CampaignSession.create(store, { name: "Test 1" });
    const candidates = [makeCandidate("c-1"), makeCandidate("c-2")];

    session.setSlotProposed("region", candidates);

    const slot = session.getState().slots.region;
    expect(slot.status).toBe("proposed");
    expect(slot.candidates).toEqual(candidates);
  });

  test("calling setSlotProposed again replaces candidates", () => {
    const store = freshStore();
    const session = CampaignSession.create(store, { name: "Test 2" });

    session.setSlotProposed("region", [makeCandidate("c-1")]);
    const replacement = [makeCandidate("c-2"), makeCandidate("c-3")];
    session.setSlotProposed("region", replacement);

    const slot = session.getState().slots.region;
    expect(slot.status).toBe("proposed");
    expect(slot.candidates).toEqual(replacement);
  });

  test("setSlotProposed on an accepted slot throws CampaignStateError", () => {
    const store = freshStore();
    const session = CampaignSession.create(store, { name: "Test 3" });
    session.setSlotProposed("region", [makeCandidate("c-1")]);
    session.acceptSlot("region", "c-1");

    expect(() => session.setSlotProposed("region", [makeCandidate("c-9")])).toThrow(
      CampaignStateError
    );
  });

  test("acceptSlot flips proposed to accepted, sets acceptedCandidateId, clears candidates", () => {
    const store = freshStore();
    const session = CampaignSession.create(store, { name: "Test 4" });
    session.setSlotProposed("location", [makeCandidate("c-1"), makeCandidate("c-2")]);

    session.acceptSlot("location", "c-2");

    const slot = session.getState().slots.location;
    expect(slot.status).toBe("accepted");
    expect(slot.acceptedCandidateId).toBe("c-2");
    expect(slot.candidates).toBeUndefined();
  });

  test("acceptSlot stamps entityId when provided", () => {
    const store = freshStore();
    const session = CampaignSession.create(store, { name: "Test 4b" });
    session.setSlotProposed("event", [makeCandidate("c-1")]);

    session.acceptSlot("event", "c-1", "ent-42");

    const slot = session.getState().slots.event;
    expect(slot.entityId).toBe("ent-42");
  });

  test("acceptSlot with unknown candidateId throws", () => {
    const store = freshStore();
    const session = CampaignSession.create(store, { name: "Test 5" });
    session.setSlotProposed("event", [makeCandidate("c-1")]);

    expect(() => session.acceptSlot("event", "c-bogus")).toThrow(CampaignStateError);
  });

  test("acceptSlot on an open slot throws", () => {
    const store = freshStore();
    const session = CampaignSession.create(store, { name: "Test 6" });

    expect(() => session.acceptSlot("faction", "c-1")).toThrow(CampaignStateError);
  });
});

describe("CampaignSession persistence", () => {
  test("flush persists and load returns equivalent state", () => {
    const store = freshStore();
    const session = CampaignSession.create(store, { name: "Persist 1", intentMd: "intent" });
    session.setSlotProposed("region", [makeCandidate("c-1"), makeCandidate("c-2")]);
    session.acceptSlot("region", "c-1", "ent-7");
    session.setSlotNotes("location", "more dangerous");
    session.addMultiEntry("npcs", { candidateId: "n-1", entityId: "ent-99" });
    session.appendHistory({ kind: "user", text: "hello", ts: "2026-05-15T00:00:00Z" });
    session.flush();

    const reloaded = CampaignSession.load(store, session.id);
    expect(reloaded.getState()).toEqual(session.getState());
    expect(reloaded.getCampaign().intentMd).toBe("intent");
    expect(reloaded.getCampaign().name).toBe("Persist 1");
  });
});

describe("CampaignSession multi slots", () => {
  for (const slot of ["npcs", "lore", "hooks"] as const) {
    test(`addMultiEntry then removeMultiEntry round-trips for ${slot}`, () => {
      const store = freshStore();
      const session = CampaignSession.create(store, { name: `multi-${slot}` });

      session.addMultiEntry(slot, { candidateId: "x-1", notes: "note" });
      session.addMultiEntry(slot, { candidateId: "x-2", entityId: "ent-2" });
      expect(session.getState().multi[slot].entries.length).toBe(2);

      session.removeMultiEntry(slot, "x-1");
      const entries = session.getState().multi[slot].entries;
      expect(entries.length).toBe(1);
      expect(entries[0]?.candidateId).toBe("x-2");

      // no-op for missing id
      session.removeMultiEntry(slot, "nope");
      expect(session.getState().multi[slot].entries.length).toBe(1);
    });
  }
});

describe("CampaignSession.archive", () => {
  test("sets status archived and survives reload", () => {
    const store = freshStore();
    const session = CampaignSession.create(store, { name: "Archive 1" });

    session.archive();

    const reloaded = CampaignSession.load(store, session.id);
    expect(reloaded.getCampaign().status).toBe("archived");
  });
});
