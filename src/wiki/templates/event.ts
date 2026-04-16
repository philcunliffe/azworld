import { TemplateContext, frontmatter, wikilink, generateConnectionsSection } from "./index";

/**
 * Template for Event wiki pages
 */
export function eventTemplate(ctx: TemplateContext): string {
  const { entity, relations, world, getEntityById } = ctx;
  const payload = entity.payload || {};
  const eraId = entity.anchors?.eraId || payload.eraId;
  const eraEntity = eraId ? getEntityById(String(eraId)) : undefined;

  const lines: string[] = [];

  // Frontmatter
  lines.push(
    frontmatter({
      id: entity.id,
      type: "event",
      name: entity.name,
      tags: entity.tags,
      anchors: entity.anchors,
      scope: payload.scope || null,
      severity: payload.severity || null,
      scale: payload.scale || null,
      secrecy: payload.secrecy || null,
      historical: payload.historical ?? false,
      eraId: eraId || null,
      recencyBand: payload.recencyBand || null,
      relativeOrder: payload.relativeOrder ?? null,
      ongoing: payload.ongoing ?? false,
      updated_at: entity.updated_at,
    })
  );

  // Title
  lines.push("", `# ${entity.name}`, "");

  // Tags and status line
  const statusParts: string[] = [];
  if (payload.scope) statusParts.push(payload.scope);
  if (payload.severity) statusParts.push(payload.severity);
  if (payload.scale) statusParts.push(payload.scale);
  if (payload.secrecy) statusParts.push(payload.secrecy);
  if (payload.historical) statusParts.push("historical");
  if (payload.recencyBand) statusParts.push(payload.recencyBand);
  if (payload.ongoing) statusParts.push("ongoing");
  if (entity.tags?.length) statusParts.push(...entity.tags);
  if (statusParts.length) {
    lines.push(`*${statusParts.join(" · ")}*`, "");
  }

  // Summary
  if (entity.summary) {
    lines.push(entity.summary, "");
  }

  // Timeline info
  if (
    payload.daysAgo !== undefined ||
    payload.ongoing !== undefined ||
    payload.historical ||
    payload.sequenceHint ||
    payload.outcome ||
    payload.significance ||
    eraEntity ||
    payload.eraLabel
  ) {
    lines.push("## Timeline", "");
    if (eraEntity) {
      lines.push(`- **Era:** ${wikilink(eraEntity)}`);
    } else if (payload.eraLabel) {
      lines.push(`- **Era:** ${payload.eraLabel}`);
    }
    if (payload.recencyBand) {
      lines.push(`- **Recency:** ${payload.recencyBand}`);
    }
    if (typeof payload.relativeOrder === "number") {
      lines.push(`- **Order:** ${payload.relativeOrder}`);
    }
    if (typeof payload.daysAgo === "number") {
      if (payload.daysAgo === 0) {
        lines.push("- **When:** Today/Now");
      } else {
        lines.push(`- **When:** ${payload.daysAgo} days ago`);
      }
    }
    if (payload.ongoing !== undefined) {
      lines.push(`- **Status:** ${payload.ongoing ? "Ongoing" : "Concluded"}`);
    }
    if (payload.sequenceHint) {
      lines.push(`- **Sequence:** ${payload.sequenceHint}`);
    }
    if (payload.outcome) {
      lines.push(`- **Outcome:** ${payload.outcome}`);
    }
    if (payload.significance) {
      lines.push(`- **Significance:** ${payload.significance}`);
    }
    lines.push("");
  }

  if (payload.scale || payload.secrecy || payload.audience) {
    lines.push("## Visibility", "");
    if (payload.scale) lines.push(`- **Scale:** ${payload.scale}`);
    if (payload.secrecy) lines.push(`- **Secrecy:** ${payload.secrecy}`);
    if (payload.audience?.public) lines.push(`- **Audience:** public knowledge`);
    if (payload.audience?.knownFactionIds?.length) lines.push(`- **Known Factions:** ${payload.audience.knownFactionIds.join(", ")}`);
    if (payload.audience?.knownNpcIds?.length) lines.push(`- **Known NPCs:** ${payload.audience.knownNpcIds.join(", ")}`);
    lines.push("");
  }

  // Location
  const burgId = entity.anchors?.burgId;
  const stateId = entity.anchors?.stateId;
  if (burgId || stateId) {
    lines.push("## Location", "");
    if (burgId) {
      const burg = world.getBurg(burgId);
      if (burg) {
        lines.push(`- **City:** ${burg.name}`);
      }
    }
    if (stateId) {
      const state = world.getState(stateId);
      if (state) {
        lines.push(`- **State:** ${state.name}`);
      }
    }
    lines.push("");
  }

  // Details
  if (entity.details_md) {
    lines.push("## Description", "", entity.details_md, "");
  }

  // Consequences
  const consequences = payload.consequences;
  if (Array.isArray(consequences) && consequences.length) {
    lines.push("## Consequences", "");
    for (const c of consequences) {
      let line = `- **${c.type || "Effect"}**`;
      if (c.target) line += ` on ${c.target}`;
      if (c.severity) line += ` (${c.severity})`;
      if (c.effect) line += `: ${c.effect}`;
      lines.push(line);
    }
    lines.push("");
  }

  // Affected entities from relations
  const affected = relations.outgoing.filter((r) =>
    ["affects", "caused_by", "related_to"].includes(r.rel_type)
  );
  if (affected.length) {
    lines.push("## Affected", "");
    for (const rel of affected) {
      const target = getEntityById(rel.to_id);
      lines.push(`- ${wikilink(target)} (${rel.rel_type.replace(/_/g, " ")})`);
    }
    lines.push("");
  }

  // Other connections
  lines.push(generateConnectionsSection(ctx));

  return lines.join("\n");
}
