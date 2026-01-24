import { TemplateContext, frontmatter, wikilink, generateConnectionsSection } from "./index";

/**
 * Template for Location wiki pages
 */
export function locationTemplate(ctx: TemplateContext): string {
  const { entity, relations, world, getEntityById } = ctx;
  const payload = entity.payload || {};

  const lines: string[] = [];

  // Frontmatter
  lines.push(
    frontmatter({
      id: entity.id,
      type: "location",
      name: entity.name,
      tags: entity.tags,
      anchors: entity.anchors,
      kind: payload.kind || null,
      updated_at: entity.updated_at,
    })
  );

  // Title
  lines.push("", `# ${entity.name}`, "");

  // Tags line
  if (entity.tags?.length) {
    lines.push(`*${entity.tags.join(" · ")}*`, "");
  }

  // Summary
  if (entity.summary) {
    lines.push(entity.summary, "");
  }

  // City info
  const burgId = entity.anchors?.burgId;
  if (burgId) {
    const burg = world.getBurg(burgId);
    if (burg) {
      const state = typeof burg.state === "number" ? world.getState(burg.state) : undefined;
      let locationStr = `**City:** ${burg.name}`;
      if (state) locationStr += ` (${state.name})`;
      lines.push(locationStr, "");
    }
  }

  // Neighborhood info
  const neighborhoodId = entity.anchors?.neighborhoodId;
  if (neighborhoodId) {
    const neighborhood = getEntityById(neighborhoodId);
    if (neighborhood) {
      lines.push(`**Neighborhood:** ${wikilink(neighborhood)}`, "");
    }
  }

  // Details
  if (entity.details_md) {
    lines.push("## Description", "", entity.details_md, "");
  }

  // Location characteristics from payload
  if (payload.kind || payload.atmosphere || payload.features) {
    lines.push("## Characteristics", "");
    if (payload.kind) lines.push(`- **Type:** ${payload.kind}`);
    if (payload.atmosphere) lines.push(`- **Atmosphere:** ${payload.atmosphere}`);
    if (payload.features) {
      if (Array.isArray(payload.features)) {
        lines.push(`- **Features:** ${payload.features.join(", ")}`);
      } else {
        lines.push(`- **Features:** ${payload.features}`);
      }
    }
    if (payload.clientele) lines.push(`- **Clientele:** ${payload.clientele}`);
    if (payload.specialty) lines.push(`- **Specialty:** ${payload.specialty}`);
    lines.push("");
  }

  // People here (NPCs with located_at or works_at relation to this location)
  const peopleHere = relations.incoming.filter((r) =>
    ["located_at", "works_at", "owns", "operates"].includes(r.rel_type)
  );
  if (peopleHere.length) {
    lines.push("## People Here", "");
    for (const rel of peopleHere) {
      const person = getEntityById(rel.from_id);
      if (person && person.type === "npc") {
        const role = rel.notes || rel.rel_type.replace(/_/g, " ");
        lines.push(`- ${wikilink(person)} - ${role}`);
      }
    }
    lines.push("");
  }

  // Affiliated factions
  const factionRels = relations.incoming.filter(
    (r) =>
      ["controls", "owns", "front_for", "protected_by", "operates_from"].includes(r.rel_type) &&
      getEntityById(r.from_id)?.type === "faction"
  );
  if (factionRels.length) {
    lines.push("## Factions", "");
    for (const rel of factionRels) {
      const faction = getEntityById(rel.from_id);
      if (faction) {
        lines.push(`- ${wikilink(faction)} (${rel.rel_type.replace(/_/g, " ")})`);
      }
    }
    lines.push("");
  }

  // Child locations (for neighborhoods)
  if (payload.kind === "neighborhood") {
    const childLocations = relations.incoming.filter(
      (r) => r.rel_type === "located_in" || getEntityById(r.from_id)?.anchors?.neighborhoodId === entity.id
    );
    // Also query by anchor
    // Note: In a real implementation, we'd query the canon store directly

    if (childLocations.length) {
      lines.push("## Locations in this Neighborhood", "");
      for (const rel of childLocations) {
        const child = getEntityById(rel.from_id);
        if (child && child.type === "location") {
          lines.push(`- ${wikilink(child)}`);
        }
      }
      lines.push("");
    }
  }

  // Other connections
  lines.push(generateConnectionsSection(ctx));

  return lines.join("\n");
}
