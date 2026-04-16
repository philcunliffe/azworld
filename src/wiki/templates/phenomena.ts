import { TemplateContext, frontmatter, generateConnectionsSection } from "./index";

export function phenomenaTemplate(ctx: TemplateContext): string {
  const { entity, world } = ctx;
  const payload = entity.payload || {};
  const lines: string[] = [];

  lines.push(
    frontmatter({
      id: entity.id,
      type: "phenomena",
      name: entity.name,
      tags: entity.tags,
      anchors: entity.anchors,
      category: payload.category || null,
      nature: payload.nature || null,
      dangerLevel: payload.dangerLevel || null,
      stability: payload.stability || null,
      visibility: payload.visibility || null,
      updated_at: entity.updated_at,
    })
  );

  lines.push("", `# ${entity.name}`, "");

  const status: string[] = [];
  if (payload.category) status.push(payload.category);
  if (payload.nature) status.push(payload.nature);
  if (payload.dangerLevel) status.push(payload.dangerLevel);
  if (payload.stability) status.push(payload.stability);
  if (payload.visibility) status.push(payload.visibility);
  if (status.length) lines.push(`*${status.join(" · ")}*`, "");

  if (entity.summary) lines.push(entity.summary, "");

  const burgId = entity.anchors?.burgId;
  const stateId = entity.anchors?.stateId;
  if (burgId || stateId) {
    lines.push("## Location", "");
    if (burgId) {
      const burg = world.getBurg(burgId);
      if (burg) lines.push(`- **City:** ${burg.name}`);
    }
    if (stateId) {
      const state = world.getState(stateId);
      if (state) lines.push(`- **State:** ${state.name}`);
    }
    lines.push("");
  }

  const details: string[] = [];
  if (payload.origin) details.push(`- **Origin:** ${payload.origin}`);
  if (payload.scope) details.push(`- **Scope:** ${payload.scope}`);
  if (payload.interactionNotes) details.push(`- **Interaction:** ${payload.interactionNotes}`);
  if (details.length) lines.push("## Nature", "", ...details, "");

  if (Array.isArray(payload.effects) && payload.effects.length) {
    lines.push("## Effects", "");
    for (const effect of payload.effects) lines.push(`- ${effect}`);
    lines.push("");
  }

  if (Array.isArray(payload.triggers) && payload.triggers.length) {
    lines.push("## Triggers", "");
    for (const trigger of payload.triggers) lines.push(`- ${trigger}`);
    lines.push("");
  }

  if (Array.isArray(payload.manifestations) && payload.manifestations.length) {
    lines.push("## Manifestations", "");
    for (const manifestation of payload.manifestations) lines.push(`- ${manifestation}`);
    lines.push("");
  }

  if (entity.details_md) lines.push("## Description", "", entity.details_md, "");

  lines.push(generateConnectionsSection(ctx));
  return lines.join("\n");
}
