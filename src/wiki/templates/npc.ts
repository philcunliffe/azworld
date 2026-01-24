import { TemplateContext, frontmatter, wikilink, generateConnectionsSection } from "./index";

/**
 * Template for NPC wiki pages
 */
export function npcTemplate(ctx: TemplateContext): string {
  const { entity, relations, world, getEntityById } = ctx;
  const payload = entity.payload || {};

  const lines: string[] = [];

  // Frontmatter
  lines.push(
    frontmatter({
      id: entity.id,
      type: "npc",
      name: entity.name,
      tags: entity.tags,
      anchors: entity.anchors,
      role: payload.role || null,
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

  // Location info
  const burgId = entity.anchors?.burgId;
  if (burgId) {
    const burg = world.getBurg(burgId);
    if (burg) {
      lines.push(`**Location:** ${burg.name}`, "");
    }
  }

  // Details
  if (entity.details_md) {
    lines.push("## Description", "", entity.details_md, "");
  }

  // Role and characteristics from payload
  if (payload.role || payload.occupation || payload.personality) {
    lines.push("## Characteristics", "");
    if (payload.role) lines.push(`- **Role:** ${payload.role}`);
    if (payload.occupation) lines.push(`- **Occupation:** ${payload.occupation}`);
    if (payload.personality) lines.push(`- **Personality:** ${payload.personality}`);
    if (payload.appearance) lines.push(`- **Appearance:** ${payload.appearance}`);
    if (payload.secret) lines.push(`- **Secret:** ${payload.secret}`);
    lines.push("");
  }

  // Affiliations from relations
  const affiliations = relations.outgoing.filter((r) =>
    ["member_of", "works_at", "affiliated_with", "loyal_to"].includes(r.rel_type)
  );
  if (affiliations.length) {
    lines.push("## Affiliations", "");
    for (const rel of affiliations) {
      const target = getEntityById(rel.to_id);
      lines.push(`- ${wikilink(target)} (${rel.rel_type.replace(/_/g, " ")})`);
    }
    lines.push("");
  }

  // Connections (other relations)
  lines.push(generateConnectionsSection(ctx));

  return lines.join("\n");
}
