import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nowIso } from "../util/time";
import { slugify } from "../util/slug";
import {
  type Campaign,
  type CampaignState,
  emptyState,
} from "./types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATION_001 = readFileSync(join(__dirname, "migrations", "001_campaigns.sql"), "utf8");

export type CreateCampaignInput = {
  name: string;
  intentMd?: string;
};

export type ListCampaignsFilter = {
  status?: "open" | "archived";
};

export type UpdateCampaignPatch = Partial<Pick<Campaign, "name" | "status" | "state">>;

function randomSlug(): string {
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return uuid.slice(0, 8);
}

function makeCampaignId(name: string): string {
  const base = slugify(name);
  const tail = randomSlug();
  if (!base) return `camp-${tail}`;
  return `camp-${base.slice(0, 32)}-${tail}`;
}

export class CampaignStore {
  readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  initDb(): void {
    this.db.exec(MIGRATION_001);
  }

  createCampaign(input: CreateCampaignInput): Campaign {
    const id = makeCampaignId(input.name);
    const ts = nowIso();
    const state = emptyState();
    const intentMd = input.intentMd ?? "";

    this.db
      .prepare(
        `INSERT INTO campaigns (id, name, status, intent_md, state_json, created_at, updated_at)
         VALUES (?, ?, 'open', ?, ?, ?, ?)`
      )
      .run(id, input.name, intentMd, JSON.stringify(state), ts, ts);

    return {
      id,
      name: input.name,
      status: "open",
      intentMd,
      state,
      createdAt: ts,
      updatedAt: ts,
    };
  }

  getCampaign(id: string): Campaign | null {
    const row = this.db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as any;
    if (!row) return null;
    return this.rowToCampaign(row);
  }

  listCampaigns(filter: ListCampaignsFilter = {}): Campaign[] {
    let sql = "SELECT * FROM campaigns";
    const params: any[] = [];
    if (filter.status) {
      sql += " WHERE status = ?";
      params.push(filter.status);
    }
    sql += " ORDER BY updated_at DESC";
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => this.rowToCampaign(r));
  }

  updateCampaign(id: string, patch: UpdateCampaignPatch): Campaign {
    const existing = this.getCampaign(id);
    if (!existing) {
      throw new Error(`campaign not found: ${id}`);
    }

    const name = patch.name ?? existing.name;
    const status = patch.status ?? existing.status;
    const state = patch.state ?? existing.state;
    const ts = nowIso();

    this.db
      .prepare(
        `UPDATE campaigns
         SET name = ?, status = ?, state_json = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(name, status, JSON.stringify(state), ts, id);

    return {
      ...existing,
      name,
      status,
      state,
      updatedAt: ts,
    };
  }

  deleteCampaign(id: string): void {
    this.db.prepare("DELETE FROM campaigns WHERE id = ?").run(id);
  }

  private rowToCampaign(row: any): Campaign {
    let state: CampaignState;
    try {
      state = JSON.parse(String(row.state_json)) as CampaignState;
    } catch {
      state = emptyState();
    }
    return {
      id: String(row.id),
      name: String(row.name),
      status: row.status === "archived" ? "archived" : "open",
      intentMd: String(row.intent_md ?? ""),
      state,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }
}
