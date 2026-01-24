import { bestFuzzyMatch } from "../util/fuzzy";
import { coerceInt } from "../util/args";

export class AzgaarWorldError extends Error {}

export type WorldCounts = {
  cells: number;
  states: number;
  burgs: number;
  cultures: number;
  religions: number;
  rivers: number;
};

export class AzgaarWorld {
  worldPath: string;
  root: any = {};
  pack: any = {};

  private indexesBuilt = false;
  private statesById: Map<number, any> = new Map();
  private burgsById: Map<number, any> = new Map();
  private culturesById: Map<number, any> = new Map();
  private religionsById: Map<number, any> = new Map();
  private riversById: Map<number, any> = new Map();

  private stateNameToId: Map<string, number> = new Map();
  private burgNameToId: Map<string, number> = new Map();

  constructor(worldPath: string) {
    this.worldPath = worldPath;
  }

  static async load(worldPath: string): Promise<AzgaarWorld> {
    const w = new AzgaarWorld(worldPath);
    await w._load();
    return w;
  }

  private async _load() {
    const file = Bun.file(this.worldPath);
    if (!(await file.exists())) {
      throw new AzgaarWorldError(`World file not found: ${this.worldPath}`);
    }
    const txt = await file.text();
    this.root = JSON.parse(txt);

    if (this.root && typeof this.root === "object" && this.root.pack && typeof this.root.pack === "object") {
      this.pack = this.root.pack;
    } else {
      const expected = ["states", "burgs", "cells", "cultures", "religions"]; 
      const keys = this.root && typeof this.root === "object" ? Object.keys(this.root) : [];
      if (expected.some((k) => keys.includes(k))) {
        this.pack = this.root;
      } else {
        throw new AzgaarWorldError("Unsupported Azgaar export structure: couldn't locate pack");
      }
    }
  }

  private buildIndexes() {
    if (this.indexesBuilt) return;

    this.statesById = this.indexArray(this.pack.states);
    this.burgsById = this.indexArray(this.pack.burgs);
    this.culturesById = this.indexArray(this.pack.cultures);
    this.religionsById = this.indexArray(this.pack.religions);
    this.riversById = this.indexArray(this.pack.rivers);

    this.stateNameToId = new Map();
    for (const [id, s] of this.statesById.entries()) {
      if (id === 0) continue;
      if (!s || s.removed) continue;
      const name = (s.name || "").toString().trim().toLowerCase();
      if (name) this.stateNameToId.set(name, id);
    }

    this.burgNameToId = new Map();
    for (const [id, b] of this.burgsById.entries()) {
      if (id === 0) continue;
      if (!b || b.removed) continue;
      const name = (b.name || "").toString().trim().toLowerCase();
      if (name) this.burgNameToId.set(name, id);
    }

    this.indexesBuilt = true;
  }

  private indexArray(arr: any): Map<number, any> {
    const out = new Map<number, any>();
    if (!Array.isArray(arr)) return out;
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (item && typeof item === "object" && !Array.isArray(item)) {
        out.set(i, item);
      }
    }
    return out;
  }

  counts(): WorldCounts {
    this.buildIndexes();
    let cells = 0;
    const packCells = this.pack.cells;
    if (packCells && typeof packCells === "object" && !Array.isArray(packCells)) {
      for (const v of Object.values(packCells)) {
        if (Array.isArray(v)) {
          cells = v.length;
          break;
        }
      }
    }

    const countActive = (m: Map<number, any>) => {
      let n = 0;
      for (const [id, v] of m.entries()) {
        if (id === 0) continue;
        if (v && !v.removed) n++;
      }
      return n;
    };

    return {
      cells,
      states: countActive(this.statesById),
      burgs: countActive(this.burgsById),
      cultures: countActive(this.culturesById),
      religions: countActive(this.religionsById),
      rivers: countActive(this.riversById),
    };
  }

  listStates(): any[] {
    this.buildIndexes();
    const out: any[] = [];
    for (const [id, s] of this.statesById.entries()) {
      if (id === 0) continue;
      if (!s || s.removed) continue;
      out.push({ id, ...s });
    }
    return out;
  }

  listBurgs(): any[] {
    this.buildIndexes();
    const out: any[] = [];
    for (const [id, b] of this.burgsById.entries()) {
      if (id === 0) continue;
      if (!b || b.removed) continue;
      out.push({ id, ...b });
    }
    return out;
  }

  resolveStateId(query: string | number): number | undefined {
    this.buildIndexes();
    if (typeof query === "number") return this.statesById.has(query) ? query : undefined;
    const qi = coerceInt(query);
    if (qi !== undefined) return this.statesById.has(qi) ? qi : undefined;
    const q = (query || "").toString().trim().toLowerCase();
    if (!q) return undefined;
    const direct = this.stateNameToId.get(q);
    if (direct !== undefined) return direct;
    const match = bestFuzzyMatch(q, [...this.stateNameToId.keys()], 0.75);
    return match ? this.stateNameToId.get(match) : undefined;
  }

  resolveBurgId(query: string | number): number | undefined {
    this.buildIndexes();
    if (typeof query === "number") return this.burgsById.has(query) ? query : undefined;
    const qi = coerceInt(query);
    if (qi !== undefined) return this.burgsById.has(qi) ? qi : undefined;
    const q = (query || "").toString().trim().toLowerCase();
    if (!q) return undefined;
    const direct = this.burgNameToId.get(q);
    if (direct !== undefined) return direct;
    const match = bestFuzzyMatch(q, [...this.burgNameToId.keys()], 0.75);
    return match ? this.burgNameToId.get(match) : undefined;
  }

  getState(query: string | number): any | undefined {
    this.buildIndexes();
    const id = this.resolveStateId(query);
    if (id === undefined) return undefined;
    const s = this.statesById.get(id);
    if (!s || typeof s !== "object") return undefined;
    return { id, ...s };
  }

  getBurg(query: string | number): any | undefined {
    this.buildIndexes();
    const id = this.resolveBurgId(query);
    if (id === undefined) return undefined;
    const b = this.burgsById.get(id);
    if (!b || typeof b !== "object") return undefined;
    return { id, ...b };
  }

  getCell(cellId: number): any | undefined {
    const cells = this.pack.cells;
    if (!cells || typeof cells !== "object" || Array.isArray(cells)) return undefined;

    const at = (key: string): any => {
      const arr = (cells as any)[key];
      if (Array.isArray(arr) && cellId >= 0 && cellId < arr.length) return arr[cellId];
      return undefined;
    };

    const biomeId = at("biome");
    const stateId = at("state");
    const cultureId = at("culture");
    const religionId = at("religion");
    const riverId = at("r");
    const elevation = at("h");
    const pop = at("pop");
    const area = at("area");

    this.buildIndexes();
    const out: any = {
      id: cellId,
      elevation,
      population: pop,
      area,
      biomeId,
      stateId,
      cultureId,
      religionId,
      riverId,
    };

    if (typeof stateId === "number") out.stateName = this.statesById.get(stateId)?.name;
    if (typeof cultureId === "number") out.cultureName = this.culturesById.get(cultureId)?.name;
    if (typeof religionId === "number") out.religionName = this.religionsById.get(religionId)?.name;
    if (typeof riverId === "number") out.riverName = this.riversById.get(riverId)?.name;

    return out;
  }

  /**
   * Get the anchor hierarchy for a burg (burgId -> stateId).
   * Useful for scope-aware event queries.
   */
  getAnchorHierarchy(burgId: number): { burgId: number; stateId?: number } {
    this.buildIndexes();
    const burg = this.burgsById.get(burgId);
    if (!burg) return { burgId };
    return {
      burgId,
      stateId: typeof burg.state === "number" ? burg.state : undefined,
    };
  }

  /**
   * Get burgs within a state
   */
  getBurgsByState(stateId: number): any[] {
    this.buildIndexes();
    const out: any[] = [];
    for (const [id, b] of this.burgsById.entries()) {
      if (id === 0) continue;
      if (!b || b.removed) continue;
      if (b.state === stateId) {
        out.push({ id, ...b });
      }
    }
    return out;
  }

  search(term: string, kinds?: string[] | null, limit = 20): any[] {
    this.buildIndexes();
    const q = (term || "").trim().toLowerCase();
    if (!q) return [];
    const ks = kinds && kinds.length ? kinds : ["states", "burgs", "cultures", "religions", "rivers"];

    const results: Array<{ score: number; item: any }> = [];

    const scoreName = (name: string): number => {
      const n = name.toLowerCase();
      if (n === q) return 1.0;
      if (n.startsWith(q)) return 0.9;
      const idx = n.indexOf(q);
      if (idx >= 0) return 0.7 - Math.min(0.2, idx / 1000);
      return 0;
    };

    const pushMatches = (kind: string, map: Map<number, any>) => {
      for (const [id, v] of map.entries()) {
        if (id === 0) continue;
        if (!v || v.removed) continue;
        const name = (v.name || "").toString();
        if (!name) continue;
        const s = scoreName(name);
        if (s <= 0) continue;
        results.push({ score: s, item: { kind, id, name, raw: v } });
      }
    };

    if (ks.includes("states")) pushMatches("state", this.statesById);
    if (ks.includes("burgs")) pushMatches("burg", this.burgsById);
    if (ks.includes("cultures")) pushMatches("culture", this.culturesById);
    if (ks.includes("religions")) pushMatches("religion", this.religionsById);
    if (ks.includes("rivers")) pushMatches("river", this.riversById);

    results.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name));
    return results.slice(0, limit).map((r) => ({ score: r.score, ...r.item }));
  }
}
