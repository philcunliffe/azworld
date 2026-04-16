import { TemplateContext, frontmatter, wikilink, generateConnectionsSection } from "./index";

/**
 * Template for Rumor wiki pages
 */
export function rumorTemplate(ctx: TemplateContext): string {
  const { entity, relations, world, getEntityById } = ctx;
  const payload = entity.payload || {};

  const lines: string[] = [];

  // Frontmatter
  lines.push(
    frontmatter({
      id: entity.id,
      type: "rumor",
      name: entity.name,
      tags: entity.tags,
      anchors: entity.anchors,
      truthLevel: payload.truthLevel || null,
      spreadLevel: payload.spreadLevel || null,
      sourceType: payload.sourceType || null,
      secrecy: payload.secrecy || null,
      ageDays: payload.ageDays ?? null,
      updated_at: entity.updated_at,
    })
  );

  // Title
  lines.push("", `# ${entity.name}`, "");

  // Status line with truth/spread indicators
  const statusParts: string[] = [];
  if (payload.truthLevel) {
    const truthMap: Record<string, string> = {
      "false": "false",
      "distorted": "distorted",
      "mostly-true": "mostly true",
      "true": "true",
    };
    statusParts.push(truthMap[payload.truthLevel as string] || payload.truthLevel);
  }
  if (payload.spreadLevel) statusParts.push(payload.spreadLevel);
  if (payload.sourceType) statusParts.push(payload.sourceType);
  if (payload.secrecy) statusParts.push(payload.secrecy);
  if (entity.tags?.length) statusParts.push(...entity.tags);
  if (statusParts.length) {
    lines.push(`*${statusParts.join(" · ")}*`, "");
  }

  // Summary (what people are saying)
  if (entity.summary) {
    lines.push("## What People Say", "", entity.summary, "");
  }

  // Spread details
  if (payload.spreadLevel || payload.sourceType) {
    lines.push("## Spread", "");
    if (payload.spreadLevel) {
      const spreadMap: Record<string, string> = {
        "whisper": "Only a few people know this",
        "local": "Common knowledge in this burg",
        "regional": "Known throughout the state",
        "widespread": "Has spread far and wide",
      };
      const spreadDesc = spreadMap[payload.spreadLevel as string] || payload.spreadLevel;
      lines.push(`- **Reach:** ${spreadDesc}`);
    }
    if (payload.sourceType) {
      lines.push(`- **Origin:** ${payload.sourceType}`);
    }
    if (payload.secrecy) {
      lines.push(`- **Secrecy:** ${payload.secrecy}`);
    }
    if (payload.ageDays !== undefined) {
      lines.push(`- **Age:** ${payload.ageDays} day(s)`);
    }
    lines.push("");
  }

  // Location
  const burgId = entity.anchors?.burgId;
  if (burgId) {
    const burg = world.getBurg(burgId);
    if (burg) {
      lines.push("## Location", "", `Circulating in **${burg.name}**`, "");
    }
  }

  // Detailed variations (if any)
  if (entity.details_md) {
    lines.push("## Variations", "", entity.details_md, "");
  }

  // GM-only: The actual truth
  if (payload.actualTruth) {
    lines.push("## The Truth (GM Only)", "", `> ${payload.actualTruth}`, "");
  }

  // Linked entities
  const linkedEvent = entity.anchors?.linkedEventId;
  const linkedNpc = entity.anchors?.linkedNpcId;
  if (linkedEvent || linkedNpc) {
    lines.push("## Related", "");
    if (linkedEvent) {
      const event = getEntityById(linkedEvent);
      if (event) {
        lines.push(`- **Related Event:** ${wikilink(event)}`);
      }
    }
    if (linkedNpc) {
      const npc = getEntityById(linkedNpc);
      if (npc) {
        lines.push(`- **Source/Subject:** ${wikilink(npc)}`);
      }
    }
    lines.push("");
  }

  // Other connections
  lines.push(generateConnectionsSection(ctx));

  return lines.join("\n");
}
