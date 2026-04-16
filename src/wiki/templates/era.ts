import { TemplateContext, frontmatter, generateConnectionsSection, wikilink } from "./index";

export function eraTemplate(ctx: TemplateContext): string {
  const { entity, relations, getEntityById } = ctx;
  const payload = entity.payload || {};
  const lines: string[] = [];

  lines.push(
    frontmatter({
      id: entity.id,
      type: "era",
      name: entity.name,
      tags: entity.tags,
      anchors: entity.anchors,
      relativeOrder: payload.relativeOrder ?? null,
      updated_at: entity.updated_at,
    })
  );

  lines.push("", `# ${entity.name}`, "");

  if (entity.summary) lines.push(entity.summary, "");

  const timeline: string[] = [];
  if (typeof payload.relativeOrder === "number") timeline.push(`- **Order:** ${payload.relativeOrder}`);
  if (payload.startLabel) timeline.push(`- **Begins:** ${payload.startLabel}`);
  if (payload.endLabel) timeline.push(`- **Ends:** ${payload.endLabel}`);
  if (payload.parentEraId) {
    timeline.push(`- **Parent Era:** ${wikilink(getEntityById(payload.parentEraId))}`);
  }
  if (timeline.length) {
    lines.push("## Timeline", "", ...timeline, "");
  }

  if (entity.details_md) lines.push("## Description", "", entity.details_md, "");

  const relatedEvents = relations.incoming.filter((rel) => rel.rel_type === "occurs_in");
  if (relatedEvents.length) {
    lines.push("## Historical Events", "");
    for (const rel of relatedEvents) {
      lines.push(`- ${wikilink(getEntityById(rel.from_id))}`);
    }
    lines.push("");
  }

  lines.push(generateConnectionsSection(ctx));
  return lines.join("\n");
}
