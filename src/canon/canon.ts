import { Database } from "bun:sqlite";
import { mergePatch } from "../util/mergePatch";
import { nowIso } from "../util/time";

export type EntityType = "npc" | "faction" | "location" | "event" | "rumor" | "hook" | "meta" | "culture" | "religion" | "deity" | "era" | "phenomena" | "relation_type" | "source_text" | "marker";

export const BUILTIN_RELATION_TYPES = [
  "about",
  "affects",
  "affiliated_with",
  "allied_with",
  "aspect_of",
  "belongs_to",
  "caused_by",
  "child_of",
  "consort_of",
  "controls",
  "dedicated_to",
  "founded",
  "front_for",
  "involves",
  "leads",
  "located_at",
  "located_in",
  "member_of",
  "occurs_in",
  "offered_by",
  "operates",
  "operates_from",
  "owns",
  "parent_of",
  "patron_of",
  "preceded_by",
  "protected_by",
  "related_to",
  "rival_of",
  "rules",
  "secret_member",
  "sealed_by",
  "sibling_of",
  "spread_by",
  "succeeded_by",
  "works_at",
] as const;

export type CanonEntity = {
  id: string;
  type: EntityType;
  name: string;
  summary?: string | null;
  details_md?: string | null;
  tags: string[];
  anchors: Record<string, any>;
  payload: Record<string, any>;
  meta: Record<string, any>;
  provenance: Record<string, any>;
  created_at: string;
  updated_at: string;
};

export type CanonRelation = {
  id: string;
  from_id: string;
  to_id: string;
  rel_type: string;
  strength?: number | null;
  notes?: string | null;
  created_at: string;
};

export type AwarenessLevel = "unknown" | "rumor" | "confirmed" | "intimate";
export type ActorType = "burg" | "state" | "faction" | "npc";

export type AwarenessRecord = {
  id: string;
  actorType: ActorType;
  actorId: string;
  eventId: string;
  level: AwarenessLevel;
  updatedAt: string;
};

const DDL = `
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('npc','faction','location','event','rumor','hook','meta','culture','religion','deity','era','phenomena','relation_type','source_text','marker')),
  name TEXT NOT NULL,
  summary TEXT,
  details_md TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  anchors_json TEXT NOT NULL DEFAULT '{}',
  payload_json TEXT NOT NULL DEFAULT '{}',
  meta_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  to_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  rel_type TEXT NOT NULL,
  strength REAL,
  notes TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_id);
CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_id);
CREATE INDEX IF NOT EXISTS idx_rel_type ON relations(rel_type);

CREATE TABLE IF NOT EXISTS event_awareness (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('burg', 'state', 'faction', 'npc')),
  actor_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  level TEXT NOT NULL CHECK(level IN ('unknown', 'rumor', 'confirmed', 'intimate')),
  updated_at TEXT NOT NULL,
  UNIQUE(actor_type, actor_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_awareness_actor ON event_awareness(actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_awareness_event ON event_awareness(event_id);
`;

function jdumps(v: any): string {
  return JSON.stringify(v ?? {}, null, 0);
}

function jloads(s: any, fallback: any): any {
  if (typeof s !== "string" || !s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function makeId(prefix: string): string {
  // Bun has crypto.randomUUID()
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `${prefix}_${uuid.slice(0, 12)}`;
}

export class CanonStore {
  path: string;
  db: Database;

  constructor(path: string) {
    this.path = path;
    this.db = new Database(this.path);
  }

  initDb(): void {
    this.db.exec(DDL);
    this.ensureEntityTypeMigration();
  }

  close(): void {
    this.db.close();
  }

  addEntity(opts: {
    type: EntityType;
    name: string;
    summary?: string | null;
    details_md?: string | null;
    tags?: string[];
    anchors?: Record<string, any>;
    payload?: Record<string, any>;
    meta?: Record<string, any>;
    provenance?: Record<string, any>;
    entity_id?: string;
  }): CanonEntity {
    const eid = opts.entity_id ?? makeId(opts.type);
    const ts = nowIso();
    this.db.prepare(
      `INSERT INTO entities (id,type,name,summary,details_md,tags_json,anchors_json,payload_json,meta_json,provenance_json,created_at,updated_at)
       VALUES ($id,$type,$name,$summary,$details_md,$tags_json,$anchors_json,$payload_json,$meta_json,$provenance_json,$created_at,$updated_at)`
    ).run({
      $id: eid,
      $type: opts.type,
      $name: opts.name,
      $summary: opts.summary ?? null,
      $details_md: opts.details_md ?? null,
      $tags_json: JSON.stringify(opts.tags ?? []),
      $anchors_json: JSON.stringify(opts.anchors ?? {}),
      $payload_json: JSON.stringify(opts.payload ?? {}),
      $meta_json: JSON.stringify(opts.meta ?? {}),
      $provenance_json: JSON.stringify(opts.provenance ?? {}),
      $created_at: ts,
      $updated_at: ts,
    });
    const e = this.getEntity(eid);
    if (!e) throw new Error("Failed to re-load inserted entity");
    return e;
  }

  getEntity(entityId: string): CanonEntity | undefined {
    const row = this.db.prepare("SELECT * FROM entities WHERE id = ?").get(entityId) as any;
    if (!row) return undefined;
    return this.rowToEntity(row);
  }

  listEntities(opts: {
    type?: EntityType;
    tag?: string;
    text?: string;
    limit?: number;
    anchors?: Record<string, any>;
  } = {}): CanonEntity[] {
    const where: string[] = [];
    const params: any[] = [];

    if (opts.type) {
      where.push("type = ?");
      params.push(opts.type);
    }

    if (opts.text) {
      where.push("(name LIKE ? OR summary LIKE ? OR details_md LIKE ?)");
      const like = `%${opts.text}%`;
      params.push(like, like, like);
    }

    if (opts.tag) {
      where.push("tags_json LIKE ?");
      // naive contains
      params.push(`%${JSON.stringify(opts.tag).slice(1, -1)}%`);
    }

    if (opts.anchors) {
      for (const [k, v] of Object.entries(opts.anchors)) {
        if (v === undefined || v === null) continue;
        where.push("anchors_json LIKE ?");
        if (typeof v === "number") {
          params.push(`%\"${k}\":${v}%`);
        } else {
          params.push(`%\"${k}\":\"${String(v)}\"%`);
        }
      }
    }

    let sql = "SELECT * FROM entities";
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY updated_at DESC LIMIT ?";
    params.push(opts.limit ?? 50);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToEntity(r));
  }

  patchEntity(entityId: string, patch: Partial<CanonEntity> & Record<string, any>): CanonEntity | undefined {
    const existing = this.getEntity(entityId);
    if (!existing) return undefined;

    const name = patch.name ?? existing.name;
    const summary = patch.summary ?? existing.summary ?? null;
    const details_md = patch.details_md ?? existing.details_md ?? null;

    const tags = Array.isArray((patch as any).tags) ? (patch as any).tags : existing.tags;

    let anchors = existing.anchors;
    if (patch.anchors && typeof patch.anchors === "object" && !Array.isArray(patch.anchors)) {
      anchors = mergePatch(anchors, patch.anchors);
    }

    let payload = existing.payload;
    if (patch.payload && typeof patch.payload === "object" && !Array.isArray(patch.payload)) {
      payload = mergePatch(payload, patch.payload);
    }

    let meta = existing.meta;
    if (patch.meta && typeof patch.meta === "object" && !Array.isArray(patch.meta)) {
      meta = mergePatch(meta, patch.meta);
    }

    let provenance = existing.provenance;
    if (patch.provenance && typeof patch.provenance === "object" && !Array.isArray(patch.provenance)) {
      provenance = mergePatch(provenance, patch.provenance);
    }

    this.db
      .prepare(
        `UPDATE entities
         SET name=?, summary=?, details_md=?, tags_json=?, anchors_json=?, payload_json=?, meta_json=?, provenance_json=?, updated_at=?
         WHERE id=?`
      )
      .run(
        name,
        summary,
        details_md,
        JSON.stringify(tags ?? []),
        JSON.stringify(anchors ?? {}),
        JSON.stringify(payload ?? {}),
        JSON.stringify(meta ?? {}),
        JSON.stringify(provenance ?? {}),
        nowIso(),
        entityId
      );

    return this.getEntity(entityId);
  }

  addRelation(opts: {
    from_id: string;
    to_id: string;
    rel_type: string;
    strength?: number | null;
    notes?: string | null;
    relation_id?: string;
  }): CanonRelation {
    const rid = opts.relation_id ?? makeId("rel");
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO relations (id,from_id,to_id,rel_type,strength,notes,created_at)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(rid, opts.from_id, opts.to_id, opts.rel_type, opts.strength ?? null, opts.notes ?? null, ts);
    const r = this.getRelation(rid);
    if (!r) throw new Error("Failed to re-load inserted relation");
    return r;
  }

  getRelation(relationId: string): CanonRelation | undefined {
    const row = this.db.prepare("SELECT * FROM relations WHERE id = ?").get(relationId) as any;
    if (!row) return undefined;
    return this.rowToRelation(row);
  }

  listRelations(opts: { entity_id?: string; limit?: number } = {}): CanonRelation[] {
    let sql = "SELECT * FROM relations";
    const params: any[] = [];
    if (opts.entity_id) {
      sql += " WHERE from_id = ? OR to_id = ?";
      params.push(opts.entity_id, opts.entity_id);
    }
    sql += " ORDER BY created_at DESC LIMIT ?";
    params.push(opts.limit ?? 200);

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToRelation(r));
  }

  /**
   * Get active events affecting a location, querying upward through scopes.
   * Events are filtered by recency and scope matching.
   */
  getActiveEvents(opts: {
    burgId?: number;
    stateId?: number;
    neighborhoodId?: string;
    includeParentScopes?: boolean;
    recencyDays?: number;
  }): CanonEntity[] {
    const { burgId, stateId, neighborhoodId, recencyDays = 90 } = opts;
    const includeParentScopes = opts.includeParentScopes !== false;

    // Get all events
    const allEvents = this.listEntities({ type: "event", limit: 500 });

    const matchingEvents: CanonEntity[] = [];

    for (const event of allEvents) {
      const payload = event.payload || {};
      const scope = (payload.scope as string) || "burg";
      const daysAgo = typeof payload.daysAgo === "number" ? payload.daysAgo : 0;

      // Filter by recency
      if (daysAgo > recencyDays) continue;

      // Check scope matching
      let matches = false;

      if (scope === "world") {
        // World events always match
        matches = true;
      } else if (scope === "region" && includeParentScopes) {
        // Region events match if parent scopes included
        matches = true;
      } else if (scope === "state") {
        const eventStateId = event.anchors?.stateId;
        if (eventStateId !== undefined && eventStateId === stateId) {
          matches = true;
        } else if (eventStateId === undefined && includeParentScopes) {
          // State-scope event without specific anchor matches broadly
          matches = true;
        }
      } else if (scope === "burg") {
        const eventBurgId = event.anchors?.burgId;
        if (eventBurgId !== undefined && eventBurgId === burgId) {
          matches = true;
        }
      } else if (scope === "neighborhood") {
        const eventNeighborhoodId = event.anchors?.neighborhoodId;
        if (eventNeighborhoodId && eventNeighborhoodId === neighborhoodId) {
          matches = true;
        }
      }

      if (matches) {
        matchingEvents.push(event);
      }
    }

    // Sort by daysAgo ascending (most recent first)
    matchingEvents.sort((a, b) => {
      const aDays = (a.payload?.daysAgo as number) ?? 0;
      const bDays = (b.payload?.daysAgo as number) ?? 0;
      return aDays - bDays;
    });

    return matchingEvents;
  }

  getHistoricalEvents(opts: {
    burgId?: number;
    stateId?: number;
    eraId?: string;
    recencyBands?: string[];
    includeParentScopes?: boolean;
    limit?: number;
  } = {}): CanonEntity[] {
    const {
      burgId,
      stateId,
      eraId,
      recencyBands,
      limit = 100,
    } = opts;
    const includeParentScopes = opts.includeParentScopes !== false;

    const events = this.listEntities({ type: "event", limit: 5000 }).filter((event) => {
      const payload = event.payload || {};
      if (!payload.historical) return false;

      if (eraId && event.anchors?.eraId !== eraId && payload.eraId !== eraId) {
        return false;
      }

      if (Array.isArray(recencyBands) && recencyBands.length) {
        const band = typeof payload.recencyBand === "string" ? payload.recencyBand : undefined;
        if (!band || !recencyBands.includes(band)) return false;
      }

      const scope = (payload.scope as string) || "burg";
      if (scope === "world") return true;
      if (scope === "region") return includeParentScopes;
      if (scope === "state") {
        const eventStateId = event.anchors?.stateId;
        return eventStateId === undefined ? includeParentScopes : eventStateId === stateId;
      }
      if (scope === "burg") {
        return event.anchors?.burgId === burgId;
      }
      return true;
    });

    events.sort((a, b) => {
      const aOrder = typeof a.payload?.relativeOrder === "number" ? a.payload.relativeOrder : Number.MAX_SAFE_INTEGER;
      const bOrder = typeof b.payload?.relativeOrder === "number" ? b.payload.relativeOrder : Number.MAX_SAFE_INTEGER;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.name.localeCompare(b.name);
    });

    return events.slice(0, limit);
  }

  listRelationTypeDefinitions(): CanonEntity[] {
    return this.listEntities({ type: "relation_type", limit: 5000 }).sort((a, b) => a.name.localeCompare(b.name));
  }

  getRelationTypeDefinition(name: string): CanonEntity | undefined {
    const normalized = name.trim().toLowerCase();
    return this.listRelationTypeDefinitions().find((entity) => entity.name.trim().toLowerCase() === normalized);
  }

  isKnownRelationType(name: string): boolean {
    const normalized = name.trim().toLowerCase();
    return BUILTIN_RELATION_TYPES.includes(normalized as typeof BUILTIN_RELATION_TYPES[number]) || !!this.getRelationTypeDefinition(normalized);
  }

  /**
   * Delete an entity and its relations
   */
  deleteEntity(entityId: string): boolean {
    const entity = this.getEntity(entityId);
    if (!entity) return false;

    // Relations will be cascade-deleted due to FK
    this.db.prepare("DELETE FROM entities WHERE id = ?").run(entityId);
    return true;
  }

  /**
   * Delete a relation by ID
   */
  deleteRelation(relationId: string): boolean {
    const result = this.db.prepare("DELETE FROM relations WHERE id = ?").run(relationId);
    return result.changes > 0;
  }

  /**
   * Set or update awareness level for an actor about an event
   */
  setAwareness(opts: {
    actorType: ActorType;
    actorId: string;
    eventId: string;
    level: AwarenessLevel;
  }): AwarenessRecord {
    const id = makeId("aware");
    const ts = nowIso();

    this.db.prepare(`
      INSERT INTO event_awareness (id, actor_type, actor_id, event_id, level, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(actor_type, actor_id, event_id) DO UPDATE SET
        level = excluded.level,
        updated_at = excluded.updated_at
    `).run(id, opts.actorType, opts.actorId, opts.eventId, opts.level, ts);

    // Return the record
    const row = this.db.prepare(
      "SELECT * FROM event_awareness WHERE actor_type = ? AND actor_id = ? AND event_id = ?"
    ).get(opts.actorType, opts.actorId, opts.eventId) as any;

    return this.rowToAwareness(row);
  }

  /**
   * Get awareness records with optional filters
   */
  getAwareness(opts: {
    actorType?: ActorType;
    actorId?: string;
    eventId?: string;
    minLevel?: AwarenessLevel;
  } = {}): AwarenessRecord[] {
    const where: string[] = [];
    const params: any[] = [];

    if (opts.actorType) {
      where.push("actor_type = ?");
      params.push(opts.actorType);
    }
    if (opts.actorId) {
      where.push("actor_id = ?");
      params.push(opts.actorId);
    }
    if (opts.eventId) {
      where.push("event_id = ?");
      params.push(opts.eventId);
    }
    if (opts.minLevel) {
      const levelOrder = ["unknown", "rumor", "confirmed", "intimate"];
      const minIdx = levelOrder.indexOf(opts.minLevel);
      const validLevels = levelOrder.slice(minIdx);
      where.push(`level IN (${validLevels.map(() => "?").join(",")})`);
      params.push(...validLevels);
    }

    let sql = "SELECT * FROM event_awareness";
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY updated_at DESC";

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToAwareness(r));
  }

  /**
   * Get all events an actor knows about with their awareness levels
   */
  getActorKnowledge(actorType: ActorType, actorId: string): Array<{ event: CanonEntity; level: AwarenessLevel }> {
    const awareness = this.getAwareness({ actorType, actorId });
    const results: Array<{ event: CanonEntity; level: AwarenessLevel }> = [];

    for (const a of awareness) {
      if (a.level === "unknown") continue;
      const event = this.getEntity(a.eventId);
      if (event && event.type === "event") {
        results.push({ event, level: a.level });
      }
    }

    return results;
  }

  private rowToAwareness(row: any): AwarenessRecord {
    return {
      id: String(row.id),
      actorType: row.actor_type as ActorType,
      actorId: String(row.actor_id),
      eventId: String(row.event_id),
      level: row.level as AwarenessLevel,
      updatedAt: String(row.updated_at),
    };
  }

  /**
   * Get all neighborhoods (locations with kind: "neighborhood") in a burg
   */
  getNeighborhoods(burgId: number): CanonEntity[] {
    const locations = this.listEntities({ type: "location", anchors: { burgId }, limit: 500 });
    return locations.filter((l) => l.payload?.kind === "neighborhood");
  }

  /**
   * Get all locations within a specific neighborhood
   */
  getLocationsInNeighborhood(neighborhoodId: string): CanonEntity[] {
    return this.listEntities({ type: "location", anchors: { neighborhoodId }, limit: 200 });
  }

  exportSnapshot(): { entities: CanonEntity[]; relations: CanonRelation[] } {
    const ents = this.listEntities({ limit: 100000 });
    const rels = this.listRelations({ limit: 200000 });
    return { entities: ents, relations: rels };
  }

  importSnapshot(snapshot: any, mode: "upsert" | "insert" = "upsert"): { entities: number; relations: number } {
    const ents = Array.isArray(snapshot?.entities) ? snapshot.entities : [];
    const rels = Array.isArray(snapshot?.relations) ? snapshot.relations : [];

    this.db.exec("BEGIN");
    let eCount = 0;
    let rCount = 0;

    try {
      for (const e of ents) {
        if (!e || typeof e !== "object") continue;
        const row = this.entityToRow(e as any);
        if (mode === "upsert") {
          this.db
            .prepare(
              `INSERT INTO entities (id,type,name,summary,details_md,tags_json,anchors_json,payload_json,meta_json,provenance_json,created_at,updated_at)
               VALUES ($id,$type,$name,$summary,$details_md,$tags_json,$anchors_json,$payload_json,$meta_json,$provenance_json,$created_at,$updated_at)
               ON CONFLICT(id) DO UPDATE SET
                 type=excluded.type,
                 name=excluded.name,
                 summary=excluded.summary,
                 details_md=excluded.details_md,
                 tags_json=excluded.tags_json,
                 anchors_json=excluded.anchors_json,
                 payload_json=excluded.payload_json,
                 meta_json=excluded.meta_json,
                 provenance_json=excluded.provenance_json,
                 updated_at=excluded.updated_at`
            )
            .run(row);
        } else {
          this.db
            .prepare(
              `INSERT INTO entities (id,type,name,summary,details_md,tags_json,anchors_json,payload_json,meta_json,provenance_json,created_at,updated_at)
               VALUES ($id,$type,$name,$summary,$details_md,$tags_json,$anchors_json,$payload_json,$meta_json,$provenance_json,$created_at,$updated_at)`
            )
            .run(row);
        }
        eCount++;
      }

      for (const r of rels) {
        if (!r || typeof r !== "object") continue;
        const row = this.relationToRow(r as any);
        if (mode === "upsert") {
          this.db
            .prepare(
              `INSERT INTO relations (id,from_id,to_id,rel_type,strength,notes,created_at)
               VALUES ($id,$from_id,$to_id,$rel_type,$strength,$notes,$created_at)
               ON CONFLICT(id) DO UPDATE SET
                 from_id=excluded.from_id,
                 to_id=excluded.to_id,
                 rel_type=excluded.rel_type,
                 strength=excluded.strength,
                 notes=excluded.notes`
            )
            .run(row);
        } else {
          this.db
            .prepare(
              `INSERT INTO relations (id,from_id,to_id,rel_type,strength,notes,created_at)
               VALUES ($id,$from_id,$to_id,$rel_type,$strength,$notes,$created_at)`
            )
            .run(row);
        }
        rCount++;
      }

      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }

    return { entities: eCount, relations: rCount };
  }

  private rowToEntity(row: any): CanonEntity {
    return {
      id: String(row.id),
      type: row.type as EntityType,
      name: String(row.name),
      summary: row.summary ?? null,
      details_md: row.details_md ?? null,
      tags: jloads(row.tags_json, []),
      anchors: jloads(row.anchors_json, {}),
      payload: jloads(row.payload_json, {}),
      meta: jloads(row.meta_json, {}),
      provenance: jloads(row.provenance_json, {}),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  private rowToRelation(row: any): CanonRelation {
    return {
      id: String(row.id),
      from_id: String(row.from_id),
      to_id: String(row.to_id),
      rel_type: String(row.rel_type),
      strength: row.strength ?? null,
      notes: row.notes ?? null,
      created_at: String(row.created_at),
    };
  }

  private entityToRow(e: any): Record<string, any> {
    const created = typeof e.created_at === "string" ? e.created_at : nowIso();
    const updated = typeof e.updated_at === "string" ? e.updated_at : created;
    return {
      $id: String(e.id ?? makeId(e.type ?? "meta")),
      $type: String(e.type),
      $name: String(e.name ?? ""),
      $summary: e.summary ?? null,
      $details_md: e.details_md ?? null,
      $tags_json: JSON.stringify(Array.isArray(e.tags) ? e.tags : []),
      $anchors_json: JSON.stringify(e.anchors ?? {}),
      $payload_json: JSON.stringify(e.payload ?? {}),
      $meta_json: JSON.stringify(e.meta ?? {}),
      $provenance_json: JSON.stringify(e.provenance ?? {}),
      $created_at: created,
      $updated_at: updated,
    };
  }

  private relationToRow(r: any): Record<string, any> {
    return {
      $id: String(r.id ?? makeId("rel")),
      $from_id: String(r.from_id),
      $to_id: String(r.to_id),
      $rel_type: String(r.rel_type),
      $strength: r.strength ?? null,
      $notes: r.notes ?? null,
      $created_at: typeof r.created_at === "string" ? r.created_at : nowIso(),
    };
  }

  private ensureEntityTypeMigration(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entities'")
      .get() as { sql?: string } | undefined;
    const sql = row?.sql || "";
    if (sql.includes("'era'") && sql.includes("'phenomena'") && sql.includes("'relation_type'") && sql.includes("'source_text'")) return;

    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        CREATE TABLE entities_new (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK(type IN ('npc','faction','location','event','rumor','hook','meta','culture','religion','deity','era','phenomena','relation_type','source_text','marker')),
          name TEXT NOT NULL,
          summary TEXT,
          details_md TEXT,
          tags_json TEXT NOT NULL DEFAULT '[]',
          anchors_json TEXT NOT NULL DEFAULT '{}',
          payload_json TEXT NOT NULL DEFAULT '{}',
          meta_json TEXT NOT NULL DEFAULT '{}',
          provenance_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      this.db.exec(`
        INSERT INTO entities_new (id, type, name, summary, details_md, tags_json, anchors_json, payload_json, meta_json, provenance_json, created_at, updated_at)
        SELECT id, type, name, summary, details_md, tags_json, anchors_json, payload_json, meta_json, provenance_json, created_at, updated_at
        FROM entities;
      `);
      this.db.exec("DROP TABLE entities;");
      this.db.exec("ALTER TABLE entities_new RENAME TO entities;");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
