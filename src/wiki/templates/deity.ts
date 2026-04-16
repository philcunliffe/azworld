import { TemplateContext, frontmatter, wikilink, generateConnectionsSection } from "./index";

/**
 * Template for Deity wiki pages
 */
export function deityTemplate(ctx: TemplateContext): string {
  const { entity, relations, world, getEntityById } = ctx;
  const payload = entity.payload || {};
  const anchors = entity.anchors || {};

  const lines: string[] = [];

  // Frontmatter
  lines.push(
    frontmatter({
      id: entity.id,
      type: "deity",
      name: entity.name,
      tags: entity.tags,
      anchors: entity.anchors,
      rank: payload.rank || null,
      domains: payload.domains || [],
      updated_at: entity.updated_at,
    })
  );

  // Title
  lines.push("", `# ${entity.name}`, "");

  // Status line with rank, alignment, domains
  const statusParts: string[] = [];
  if (payload.rank) statusParts.push(payload.rank);
  if (payload.alignment) statusParts.push(payload.alignment);
  if (entity.tags?.length) statusParts.push(...entity.tags);
  if (statusParts.length) {
    lines.push(`*${statusParts.join(" · ")}*`, "");
  }

  // Titles/Epithets
  const titles = payload.titles as string[] | undefined;
  if (titles?.length) {
    lines.push(`> ${titles.join(" · ")}`, "");
  }

  // Summary
  if (entity.summary) {
    lines.push(entity.summary, "");
  }

  // Domains
  const domains = payload.domains as string[] | undefined;
  if (domains?.length) {
    lines.push("## Domains", "");
    lines.push(domains.map(d => `- ${d}`).join("\n"), "");
  }

  // Sacred Symbols
  const symbols = payload.symbols as string[] | undefined;
  if (symbols?.length) {
    lines.push("## Sacred Symbols", "");
    lines.push(symbols.map(s => `- ${s}`).join("\n"), "");
  }

  // Sacred creature/element
  if (payload.sacredAnimal || payload.sacredElement) {
    lines.push("## Sacred Associations", "");
    if (payload.sacredAnimal) lines.push(`- **Sacred Animal:** ${payload.sacredAnimal}`);
    if (payload.sacredElement) lines.push(`- **Sacred Element:** ${payload.sacredElement}`);
    lines.push("");
  }

  // Appearance
  if (payload.appearance) {
    lines.push("## Appearance", "", String(payload.appearance), "");
  }

  // Mythology
  if (payload.mythology) {
    lines.push("## Mythology", "", String(payload.mythology), "");
  }

  // Description
  if (entity.details_md) {
    lines.push("## Description", "", entity.details_md, "");
  }

  // Worship
  if (payload.worshipStyle) {
    lines.push("## Worship", "", String(payload.worshipStyle), "");
  }

  // Festivals
  const festivals = payload.festivals as string[] | undefined;
  if (festivals?.length) {
    lines.push("## Festivals", "");
    lines.push(festivals.map(f => `- ${f}`).join("\n"), "");
  }

  // Parent religion
  if (anchors.azgaarReligionId !== undefined) {
    const religion = world.getReligion(anchors.azgaarReligionId);
    if (religion) {
      lines.push("## Religion", "", `Part of the **${religion.name}** faith.`, "");
    }
  }

  // Divine relations (parent_of, sibling_of, consort_of, etc.)
  const divineRels = [...relations.outgoing, ...relations.incoming].filter(r =>
    ["parent_of", "child_of", "sibling_of", "consort_of", "rival_of", "aspect_of"].includes(r.rel_type)
  );
  if (divineRels.length) {
    lines.push("## Divine Relations", "");
    for (const rel of divineRels) {
      const isOutgoing = rel.from_id === entity.id;
      const otherId = isOutgoing ? rel.to_id : rel.from_id;
      const other = getEntityById(otherId);
      const relLabel = rel.rel_type.replace(/_/g, " ");
      if (isOutgoing) {
        lines.push(`- **${relLabel}** ${wikilink(other)}`);
      } else {
        lines.push(`- ${wikilink(other)} **${relLabel}** this deity`);
      }
    }
    lines.push("");
  }

  // Other connections
  lines.push(generateConnectionsSection(ctx));

  return lines.join("\n");
}
