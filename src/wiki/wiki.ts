import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AzgaarWorld } from "../world/azgaar";
import { CanonStore } from "../canon/canon";
import { nowIso } from "../util/time";
import { slugify } from "../util/slug";

function frontmatter(d: Record<string, any>): string {
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

  const writeEntity = async (e: any) => {
    const tdir = join(outDir, `${e.type}s`);
    await mkdir(tdir, { recursive: true });
    const fname = `${slugify(e.name)}_${e.id}.md`;
    const path = join(tdir, fname);
    entityPaths[e.id] = join(`${e.type}s`, fname);

    const lines: string[] = [];
    lines.push(
      frontmatter({
        id: e.id,
        type: e.type,
        name: e.name,
        tags: e.tags ?? [],
        anchors: e.anchors ?? {},
        updated_at: e.updated_at,
      })
    );
    lines.push("", `# ${e.name}`, "");

    if (e.summary) lines.push(String(e.summary), "");
    if (e.details_md) lines.push(String(e.details_md), "");

    const payload = e.payload ?? {};
    if (payload && Object.keys(payload).length) {
      lines.push("## Details", "", "```json", JSON.stringify(payload, null, 2), "```", "");
    }

    const outgoing = byFrom[e.id] ?? [];
    const incoming = byTo[e.id] ?? [];
    if (outgoing.length || incoming.length) {
      lines.push("## Links", "");
      if (outgoing.length) {
        lines.push("### Outgoing", "");
        for (const r of outgoing) lines.push(`- **${r.rel_type}** → \`${r.to_id}\``);
        lines.push("");
      }
      if (incoming.length) {
        lines.push("### Incoming", "");
        for (const r of incoming) lines.push(`- \`${r.from_id}\` → **${r.rel_type}**`);
        lines.push("");
      }
    }

    await writeFile(path, lines.join("\n"), "utf8");
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
    const fname = `${slugify(burg.name ?? `burg-${bid}`)}_${bid}.md`;
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

    const lines: string[] = [];
    lines.push(frontmatter({ type: "city", burgId: bid, name: burg.name, exported_at: nowIso() }));
    lines.push("", `# ${burg.name} (Burg ${bid})`, "");
    lines.push("```json", JSON.stringify(basic, null, 2), "```", "");

    if (localEnts.length) {
      lines.push("## Canon entities here", "");
      const sorted = localEnts.slice().sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name));
      for (const e of sorted) {
        const rel = entityPaths[e.id];
        if (rel) lines.push(`- [${e.name}](${rel}) (${e.type})`);
        else lines.push(`- ${e.name} (${e.type})`);
      }
      lines.push("");
    }

    await writeFile(path, lines.join("\n"), "utf8");
    cityWritten++;
  }

  // Index page
  const indexLines: string[] = [];
  indexLines.push(frontmatter({ generated_at: nowIso(), entities: ents.length }));
  indexLines.push("", "# World Wiki", "", "## Sections", "");
  if (cityWritten) indexLines.push("- [Cities](cities/)");
  for (const t of Object.keys(byType).sort()) indexLines.push(`- [${t[0]!.toUpperCase() + t.slice(1)}s](${t}s/)`);
  indexLines.push("", "## Recent canon entities", "");
  const recent = ents.slice().sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? "")).slice(0, 50);
  for (const e of recent) {
    const rel = entityPaths[e.id];
    if (rel) indexLines.push(`- [${e.name}](${rel}) (${e.type})`);
    else indexLines.push(`- ${e.name} (${e.type})`);
  }

  await writeFile(join(outDir, "index.md"), indexLines.join("\n"), "utf8");

  return { entities_written: written, cities_written: cityWritten, out_dir: outDir };
}
