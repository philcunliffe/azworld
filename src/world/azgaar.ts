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

  listCultures(): any[] {
    this.buildIndexes();
    const out: any[] = [];
    for (const [id, c] of this.culturesById.entries()) {
      if (id === 0) continue;
      if (!c || c.removed) continue;
      out.push({ id, ...c });
    }
    return out;
  }

  listReligions(): any[] {
    this.buildIndexes();
    const out: any[] = [];
    for (const [id, r] of this.religionsById.entries()) {
      if (id === 0) continue;
      if (!r || r.removed) continue;
      out.push({ id, ...r });
    }
    return out;
  }

  getCulture(query: string | number): any | undefined {
    this.buildIndexes();
    let id: number | undefined;
    if (typeof query === "number") {
      id = this.culturesById.has(query) ? query : undefined;
    } else {
      const qi = coerceInt(query);
      if (qi !== undefined) {
        id = this.culturesById.has(qi) ? qi : undefined;
      } else {
        const q = (query || "").toString().trim().toLowerCase();
        for (const [cId, c] of this.culturesById.entries()) {
          if (cId === 0) continue;
          if (!c || c.removed) continue;
          if ((c.name || "").toString().trim().toLowerCase() === q) {
            id = cId;
            break;
          }
        }
      }
    }
    if (id === undefined) return undefined;
    const c = this.culturesById.get(id);
    if (!c || typeof c !== "object") return undefined;
    return { id, ...c };
  }

  getReligion(query: string | number): any | undefined {
    this.buildIndexes();
    let id: number | undefined;
    if (typeof query === "number") {
      id = this.religionsById.has(query) ? query : undefined;
    } else {
      const qi = coerceInt(query);
      if (qi !== undefined) {
        id = this.religionsById.has(qi) ? qi : undefined;
      } else {
        const q = (query || "").toString().trim().toLowerCase();
        for (const [rId, r] of this.religionsById.entries()) {
          if (rId === 0) continue;
          if (!r || r.removed) continue;
          if ((r.name || "").toString().trim().toLowerCase() === q) {
            id = rId;
            break;
          }
        }
      }
    }
    if (id === undefined) return undefined;
    const r = this.religionsById.get(id);
    if (!r || typeof r !== "object") return undefined;
    return { id, ...r };
  }

  /**
   * Get rich context for a state including military, diplomacy, capital, provinces, geography
   */
  getStateContext(stateId: number): any | undefined {
    this.buildIndexes();
    const state = this.statesById.get(stateId);
    if (!state || state.removed) return undefined;

    const capital = typeof state.capital === "number" ? this.getBurg(state.capital) : undefined;
    const culture = typeof state.culture === "number" ? this.getCulture(state.culture) : undefined;

    // Aggregate military info
    const military = Array.isArray(state.military) ? state.military : [];
    const militaryBreakdown = {
      regiments: military.length,
      infantry: 0,
      cavalry: 0,
      artillery: 0,
      archers: 0,
      fleet: 0,
      total: 0,
    };
    for (const reg of military) {
      if (reg.u) {
        militaryBreakdown.infantry += reg.u.infantry || 0;
        militaryBreakdown.cavalry += reg.u.cavalry || 0;
        militaryBreakdown.artillery += reg.u.artillery || 0;
        militaryBreakdown.archers += reg.u.archers || 0;
        militaryBreakdown.fleet += reg.u.fleet || 0;
      }
    }
    militaryBreakdown.total = militaryBreakdown.infantry + militaryBreakdown.cavalry +
                              militaryBreakdown.artillery + militaryBreakdown.archers;

    // Get diplomacy with state names
    const diplomacy: Array<{ stateId: number; stateName: string; relation: string }> = [];
    if (Array.isArray(state.diplomacy)) {
      for (let i = 0; i < state.diplomacy.length; i++) {
        const relation = state.diplomacy[i];
        if (relation && relation !== "x") {
          const otherState = this.statesById.get(i);
          if (otherState && !otherState.removed) {
            diplomacy.push({
              stateId: i,
              stateName: otherState.name,
              relation,
            });
          }
        }
      }
    }

    // Determine geographic context
    const burgs = this.getBurgsByState(stateId);
    const isCoastal = burgs.some(b => b.port);
    const hasCapitalPort = capital?.port === true;

    return {
      id: stateId,
      name: state.name,
      fullName: state.fullName,
      form: state.form,
      formName: state.formName,
      color: state.color,
      capital: capital ? { id: capital.id, name: capital.name, population: capital.population ?? capital.pop, port: capital.port } : undefined,
      culture: culture ? { id: culture.id, name: culture.name } : undefined,
      urban: state.urban,
      rural: state.rural,
      area: state.area,
      burgCount: state.burgs || burgs.length,
      provinces: state.provinces,
      military: militaryBreakdown,
      campaigns: state.campaigns || [],
      diplomacy,
      geographic: {
        isCoastal,
        hasCapitalPort,
        neighbors: state.neighbors || [],
      },
    };
  }

  /**
   * Get rich context for a culture including biomes, states, religions
   */
  getCultureContext(cultureId: number): any | undefined {
    this.buildIndexes();
    const culture = this.culturesById.get(cultureId);
    if (!culture || culture.removed) return undefined;

    // Find states using this culture
    const statesUsingCulture: Array<{ id: number; name: string }> = [];
    for (const [id, s] of this.statesById.entries()) {
      if (id === 0) continue;
      if (!s || s.removed) continue;
      if (s.culture === cultureId) {
        statesUsingCulture.push({ id, name: s.name });
      }
    }

    // Find religions associated with this culture
    const associatedReligions: Array<{ id: number; name: string; type: string }> = [];
    for (const [id, r] of this.religionsById.entries()) {
      if (id === 0) continue;
      if (!r || r.removed) continue;
      if (r.culture === cultureId) {
        associatedReligions.push({ id, name: r.name, type: r.type });
      }
    }

    // Get biomes in culture's territory (using cells data)
    const dominantBiomes = this.getBiomesForCulture(cultureId);

    return {
      id: cultureId,
      name: culture.name,
      type: culture.type,
      shield: culture.shield,
      code: culture.code,
      expansionism: culture.expansionism,
      center: culture.center,
      states: statesUsingCulture,
      religions: associatedReligions,
      dominantBiomes,
    };
  }

  /**
   * Get rich context for a religion including type, deity, cultural spread
   */
  getReligionContext(religionId: number): any | undefined {
    this.buildIndexes();
    const religion = this.religionsById.get(religionId);
    if (!religion || religion.removed) return undefined;

    const originCulture = typeof religion.culture === "number"
      ? this.getCulture(religion.culture)
      : undefined;

    // Find all cultures where this religion might have spread
    // (in Azgaar, religions expand based on their expansion type)

    return {
      id: religionId,
      name: religion.name,
      type: religion.type, // Folk, Organized, Cult, Heresy
      form: religion.form, // Shamanism, Polytheism, etc.
      deity: religion.deity,
      code: religion.code,
      expansion: religion.expansion,
      expansionism: religion.expansionism,
      originCulture: originCulture ? { id: originCulture.id, name: originCulture.name } : undefined,
      origins: religion.origins,
    };
  }

  /**
   * Get dominant biomes for a culture's territory
   */
  private getBiomesForCulture(cultureId: number): string[] {
    const cells = this.pack.cells;
    if (!cells || typeof cells !== "object" || Array.isArray(cells)) return [];

    const cultureArr = cells.culture;
    const biomeArr = cells.biome;
    if (!Array.isArray(cultureArr) || !Array.isArray(biomeArr)) return [];

    const biomeNames = this.root.biomesData?.name;
    if (!Array.isArray(biomeNames)) return [];

    // Count cells per biome for this culture
    const biomeCounts: Record<number, number> = {};
    for (let i = 0; i < cultureArr.length; i++) {
      if (cultureArr[i] === cultureId) {
        const biomeId = biomeArr[i];
        if (typeof biomeId === "number") {
          biomeCounts[biomeId] = (biomeCounts[biomeId] || 0) + 1;
        }
      }
    }

    // Sort by count and return top biome names
    const sorted = Object.entries(biomeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return sorted
      .map(([biomeId]) => biomeNames[Number(biomeId)])
      .filter(Boolean);
  }

  /**
   * Detect if cells are stored as full objects (array of cell objects with `c` neighbors)
   * vs the old format (object with parallel arrays for each property).
   */
  private isFullCellFormat(): boolean {
    const cells = this.pack.cells;
    if (!cells) return false;
    // Full format: cells is an array of objects, each with a `c` property (neighbors)
    if (Array.isArray(cells) && cells.length > 0) {
      const first = cells[0];
      return typeof first === "object" && first !== null && Array.isArray(first.c);
    }
    return false;
  }

  /**
   * Get unified cell data from either format.
   * Returns: { id, biome, state, elevation, haven, harbor, river, neighbors[] }
   */
  private getCellFull(cellId: number): {
    id: number;
    biome: number;
    state: number;
    elevation: number;
    haven: number;
    harbor: number;
    river: number;
    neighbors: number[];
  } | undefined {
    const cells = this.pack.cells;
    if (!cells) return undefined;

    if (this.isFullCellFormat()) {
      // Full format: array of cell objects
      const cell = (cells as any[])[cellId];
      if (!cell || typeof cell !== "object") return undefined;
      return {
        id: cellId,
        biome: typeof cell.biome === "number" ? cell.biome : 0,
        state: typeof cell.state === "number" ? cell.state : 0,
        elevation: typeof cell.h === "number" ? cell.h : 0,
        haven: typeof cell.haven === "number" ? cell.haven : 0,
        harbor: typeof cell.harbor === "number" ? cell.harbor : 0,
        river: typeof cell.r === "number" ? cell.r : 0,
        neighbors: Array.isArray(cell.c) ? cell.c : [],
      };
    } else {
      // Old format: object with parallel arrays
      if (typeof cells !== "object" || Array.isArray(cells)) return undefined;
      const at = (key: string): any => {
        const arr = (cells as any)[key];
        if (Array.isArray(arr) && cellId >= 0 && cellId < arr.length) return arr[cellId];
        return undefined;
      };
      return {
        id: cellId,
        biome: typeof at("biome") === "number" ? at("biome") : 0,
        state: typeof at("state") === "number" ? at("state") : 0,
        elevation: typeof at("h") === "number" ? at("h") : 0,
        haven: typeof at("haven") === "number" ? at("haven") : 0,
        harbor: typeof at("harbor") === "number" ? at("harbor") : 0,
        river: typeof at("r") === "number" ? at("r") : 0,
        neighbors: [], // Old format doesn't have neighbor data readily available
      };
    }
  }

  /**
   * Get biome name by ID from biomesData.name array.
   */
  private getBiomeName(biomeId: number): string {
    const names = this.root.biomesData?.name;
    if (Array.isArray(names) && names[biomeId]) {
      return names[biomeId];
    }
    return "unknown terrain";
  }

  /**
   * Get a narrative-ready geographic description for a burg.
   * Analyzes the burg's cell and surrounding cells to generate descriptive text.
   *
   * Example output:
   * "Port settlement on the coast in temperate rainforest. Home to the Thaxning people (River culture). Part of the Kingdom of Aldoria. On the Stapton river. Near the border with Dalborland."
   */
  getBurgGeographicContext(burgId: number): string {
    this.buildIndexes();
    const burg = this.burgsById.get(burgId);
    if (!burg || burg.removed) return "";

    const cellId = burg.cell;
    if (typeof cellId !== "number") return "";

    const cell = this.getCellFull(cellId);
    if (!cell) return "";

    const parts: string[] = [];

    // Determine if coastal
    const isPort = burg.port && burg.port !== "0";
    const isCoastal = cell.haven > 0 || cell.harbor > 0 || isPort;

    // Primary biome
    const biomeName = this.getBiomeName(cell.biome);

    // Build settlement description
    const settlementType = isCoastal ? "Port settlement on the coast" : "Inland settlement";
    parts.push(`${settlementType} in ${biomeName}.`);

    // Add culture context
    if (typeof burg.culture === "number" && burg.culture > 0) {
      const culture = this.culturesById.get(burg.culture);
      if (culture && culture.name) {
        const cultureType = culture.type ? ` (${culture.type} culture)` : "";
        parts.push(`Home to the ${culture.name} people${cultureType}.`);
      }
    }

    // Add state/political context
    if (typeof burg.state === "number" && burg.state > 0) {
      const state = this.statesById.get(burg.state);
      if (state && state.name) {
        const fullName = state.fullName || state.name;
        parts.push(`Part of ${fullName}.`);
      }
    }

    // Check for river
    if (cell.river > 0) {
      const river = this.riversById.get(cell.river);
      if (river && river.name) {
        parts.push(`On the ${river.name} river.`);
      }
    }

    // Analyze neighbors (only available in full format)
    if (cell.neighbors.length > 0) {
      const neighborBiomes = new Map<string, number>();
      let hasBorderState = false;
      let borderStateName = "";
      const burgState = burg.state;

      for (const neighborId of cell.neighbors) {
        const neighborCell = this.getCellFull(neighborId);
        if (!neighborCell) continue;

        // Count biomes (excluding the primary biome)
        const nBiome = this.getBiomeName(neighborCell.biome);
        if (nBiome !== biomeName && nBiome !== "unknown terrain") {
          neighborBiomes.set(nBiome, (neighborBiomes.get(nBiome) || 0) + 1);
        }

        // Check for state boundary
        if (neighborCell.state !== burgState && neighborCell.state > 0) {
          hasBorderState = true;
          const otherState = this.statesById.get(neighborCell.state);
          if (otherState && otherState.name && !borderStateName) {
            borderStateName = otherState.name;
          }
        }
      }

      // Add surrounding terrain info
      if (neighborBiomes.size > 0) {
        const sortedBiomes = [...neighborBiomes.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([name]) => name);
        parts.push(`Surrounding terrain includes ${sortedBiomes.join(" and ")}.`);
      }

      // Add border info
      if (hasBorderState && borderStateName) {
        parts.push(`Near the border with ${borderStateName}.`);
      }
    }

    return parts.join(" ");
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
