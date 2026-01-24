import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AzgaarWorld } from "../world/azgaar";
import { CanonStore, CanonEntity } from "../canon/canon";
import { nowIso } from "../util/time";
import { slugify } from "../util/slug";
import { stableFilename, getTemplate, frontmatter, TemplateContext } from "./templates";

/**
 * Legacy frontmatter function for city pages
 */
function legacyFrontmatter(d: Record<string, any>): string {
  const lines = ["---"];
  for (const [k, v] of Object.entries(d)) {
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

export async function exportWiki(outDir: string, world: AzgaarWorld, canon: CanonStore): Promise<any> {
  await mkdir(outDir, { recursive: true });

  const ents = canon.listEntities({ limit: 100000 });
  const rels = canon.listRelations({ limit: 200000 });

  // Build entity index for lookups
  const entityById = new Map<string, CanonEntity>();
  for (const e of ents) {
    entityById.set(e.id, e);
  }

  const byFrom: Record<string, any[]> = {};
  const byTo: Record<string, any[]> = {};
  for (const r of rels) {
    (byFrom[r.from_id] ??= []).push(r);
    (byTo[r.to_id] ??= []).push(r);
  }

  const byType: Record<string, any[]> = {};
  for (const e of ents) {
    (byType[e.type] ??= []).push(e);
  }

  let written = 0;
  const entityPaths: Record<string, string> = {};

  // Helper to get filename for an entity
  const filenameForEntity = (e: CanonEntity) => stableFilename(e);

  const writeEntity = async (e: CanonEntity) => {
    const tdir = join(outDir, `${e.type}s`);
    await mkdir(tdir, { recursive: true });
    const fname = stableFilename(e);
    const path = join(tdir, fname);
    entityPaths[e.id] = join(`${e.type}s`, fname);

    // Build template context
    const ctx: TemplateContext = {
      entity: e,
      relations: {
        outgoing: byFrom[e.id] ?? [],
        incoming: byTo[e.id] ?? [],
      },
      world,
      getEntityById: (id: string) => entityById.get(id),
      filenameForEntity,
    };

    // Get and apply template
    const template = getTemplate(e.type);
    const content = template(ctx);

    await writeFile(path, content, "utf8");
    written++;
  };

  for (const t of Object.keys(byType).sort()) {
    const lst = byType[t]!.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const e of lst) await writeEntity(e);
  }

  // City pages for referenced burgIds
  const burgIds = new Set<number>();
  for (const e of ents) {
    const bid = e.anchors?.burgId;
    if (typeof bid === "number") burgIds.add(bid);
  }

  const citiesDir = join(outDir, "cities");
  await mkdir(citiesDir, { recursive: true });
  let cityWritten = 0;

  for (const bid of [...burgIds].sort((a, b) => a - b)) {
    const burg = world.getBurg(bid);
    if (!burg) continue;
    // Stable filename for cities
    const fname = `city-${slugify(burg.name ?? `burg-${bid}`)}-${bid}.md`;
    const path = join(citiesDir, fname);

    const localEnts = ents.filter((e) => e.anchors?.burgId === bid);

    const basic = {
      population: burg.population ?? burg.pop,
      stateId: burg.state,
      cultureId: burg.culture,
      x: burg.x,
      y: burg.y,
      capital: burg.capital,
      port: burg.port,
    };

    const state = typeof burg.state === "number" ? world.getState(burg.state) : undefined;

    const lines: string[] = [];
    lines.push(legacyFrontmatter({ type: "city", burgId: bid, name: burg.name, exported_at: nowIso() }));
    lines.push("", `# ${burg.name}`, "");
    if (state) lines.push(`*${state.name}*`, "");
    lines.push("");

    // Summary stats
    lines.push("## Overview", "");
    lines.push(`- **Population:** ${basic.population || "unknown"}`);
    if (basic.capital) lines.push("- **Capital city**");
    if (basic.port) lines.push("- **Port city**");
    lines.push("");

    // Canon entities by type
    if (localEnts.length) {
      lines.push("## Canon Entities", "");
      const byEntityType: Record<string, CanonEntity[]> = {};
      for (const e of localEnts) {
        (byEntityType[e.type] ??= []).push(e);
      }
      for (const type of Object.keys(byEntityType).sort()) {
        lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s`, "");
        for (const e of byEntityType[type]!.sort((a, b) => a.name.localeCompare(b.name))) {
          const rel = entityPaths[e.id];
          const link = rel ? `[[../${rel.replace(/\.md$/, "")}|${e.name}]]` : e.name;
          lines.push(`- ${link}`);
        }
        lines.push("");
      }
    }

    await writeFile(path, lines.join("\n"), "utf8");
    cityWritten++;
  }

  // Index page
  const indexLines: string[] = [];
  indexLines.push(legacyFrontmatter({ generated_at: nowIso(), entities: ents.length }));
  indexLines.push("", "# World Wiki", "");
  indexLines.push(`*Generated: ${nowIso()}*`, "");
  indexLines.push(`*Entities: ${ents.length} | Cities: ${cityWritten}*`, "");
  indexLines.push("");

  // Sections
  indexLines.push("## Sections", "");
  if (cityWritten) indexLines.push("- [[cities/|Cities]]");
  for (const t of Object.keys(byType).sort()) {
    const count = byType[t]!.length;
    indexLines.push(`- [[${t}s/|${t.charAt(0).toUpperCase() + t.slice(1)}s]] (${count})`);
  }
  indexLines.push("");

  // Recent entities
  indexLines.push("## Recent Updates", "");
  const recent = ents.slice().sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")).slice(0, 30);
  for (const e of recent) {
    const rel = entityPaths[e.id];
    const link = rel ? `[[${rel.replace(/\.md$/, "")}|${e.name}]]` : e.name;
    indexLines.push(`- ${link} *(${e.type})*`);
  }
  indexLines.push("");

  // Events summary if any
  const events = byType["event"] || [];
  if (events.length) {
    indexLines.push("## Active Events", "");
    const activeEvents = events
      .filter((e) => e.payload?.ongoing || (e.payload?.daysAgo ?? 999) < 30)
      .sort((a, b) => (a.payload?.daysAgo ?? 0) - (b.payload?.daysAgo ?? 0))
      .slice(0, 10);
    for (const e of activeEvents) {
      const rel = entityPaths[e.id];
      const link = rel ? `[[${rel.replace(/\.md$/, "")}|${e.name}]]` : e.name;
      const daysAgo = e.payload?.daysAgo ?? 0;
      const when = daysAgo === 0 ? "now" : `${daysAgo}d ago`;
      indexLines.push(`- ${link} *(${e.payload?.scope || "?"}, ${when})*`);
    }
    indexLines.push("");
  }

  await writeFile(join(outDir, "index.md"), indexLines.join("\n"), "utf8");

  return { entities_written: written, cities_written: cityWritten, out_dir: outDir };
}
