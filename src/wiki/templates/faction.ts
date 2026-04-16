import { TemplateContext, frontmatter, wikilink, generateConnectionsSection } from "./index";

/**
 * Template for Faction wiki pages
 */
export function factionTemplate(ctx: TemplateContext): string {
  const { entity, relations, world, getEntityById } = ctx;
  const payload = entity.payload || {};

  const lines: string[] = [];

  // Frontmatter
  lines.push(
    frontmatter({
      id: entity.id,
      type: "faction",
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

  // Base of operations
  const burgId = entity.anchors?.burgId;
  if (burgId) {
    const burg = world.getBurg(burgId);
    if (burg) {
      lines.push(`**Base:** ${burg.name}`, "");
    }
  }

  // Details
  if (entity.details_md) {
    lines.push("## About", "", entity.details_md, "");
  }

  // Purpose and structure from payload
  if (payload.purpose || payload.structure || payload.goals) {
    lines.push("## Organization", "");
    if (payload.purpose) lines.push(`- **Purpose:** ${payload.purpose}`);
    if (payload.structure) lines.push(`- **Structure:** ${payload.structure}`);
    if (payload.goals) lines.push(`- **Goals:** ${payload.goals}`);
    if (payload.resources) lines.push(`- **Resources:** ${payload.resources}`);
    if (payload.secrets) lines.push(`- **Secrets:** ${payload.secrets}`);
    lines.push("");
  }

  if (Array.isArray(payload.goalProgress) && payload.goalProgress.length) {
    lines.push("## Goal Progress", "");
    for (const progress of payload.goalProgress) {
      const parts = [
        progress.goal || progress.id || "Unnamed goal",
        progress.status ? `status: ${progress.status}` : null,
        progress.progress !== undefined ? `progress: ${progress.progress}%` : null,
        progress.stage ? `stage: ${progress.stage}` : null,
        progress.nextMilestone ? `next: ${progress.nextMilestone}` : null,
        progress.secrecy ? `secrecy: ${progress.secrecy}` : null,
      ].filter(Boolean);
      lines.push(`- ${parts.join(" | ")}`);
    }
    lines.push("");
  }

  // Members (NPCs with member_of relation to this faction)
  const members = relations.incoming.filter((r) => r.rel_type === "member_of");
  if (members.length) {
    lines.push("## Members", "");
    for (const rel of members) {
      const member = getEntityById(rel.from_id);
      if (member && member.type === "npc") {
        const role = rel.notes || "";
        lines.push(`- ${wikilink(member)}${role ? ` - ${role}` : ""}`);
      }
    }
    lines.push("");
  }

  // Controlled locations
  const controlledLocations = relations.outgoing.filter((r) =>
    ["controls", "owns", "front_for", "operates_from"].includes(r.rel_type)
  );
  if (controlledLocations.length) {
    lines.push("## Territories", "");
    for (const rel of controlledLocations) {
      const location = getEntityById(rel.to_id);
      if (location) {
        lines.push(`- ${wikilink(location)} (${rel.rel_type.replace(/_/g, " ")})`);
      }
    }
    lines.push("");
  }

  // Rivals and allies
  const rivals = relations.outgoing.filter((r) => r.rel_type === "rival_of");
  const allies = relations.outgoing.filter((r) => ["allied_with", "affiliated_with"].includes(r.rel_type));

  if (rivals.length || allies.length) {
    lines.push("## Relations", "");
    if (allies.length) {
      lines.push("**Allies:**");
      for (const rel of allies) {
        const ally = getEntityById(rel.to_id);
        lines.push(`- ${wikilink(ally)}`);
      }
    }
    if (rivals.length) {
      lines.push("**Rivals:**");
      for (const rel of rivals) {
        const rival = getEntityById(rel.to_id);
        lines.push(`- ${wikilink(rival)}`);
      }
    }
    lines.push("");
  }

  // Other connections
  lines.push(generateConnectionsSection(ctx));

  return lines.join("\n");
}
