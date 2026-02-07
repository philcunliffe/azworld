import { TemplateContext, frontmatter, wikilink, generateConnectionsSection } from "./index";

/**
 * Template for Hook (quest/adventure) wiki pages
 */
export function hookTemplate(ctx: TemplateContext): string {
  const { entity, relations, world, getEntityById } = ctx;
  const payload = entity.payload || {};

  const lines: string[] = [];

  // Frontmatter
  lines.push(
    frontmatter({
      id: entity.id,
      type: "hook",
      name: entity.name,
      tags: entity.tags,
      anchors: entity.anchors,
      hookType: payload.hookType || null,
      urgency: payload.urgency || null,
      difficulty: payload.difficulty || null,
      rewardType: payload.rewardType || null,
      updated_at: entity.updated_at,
    })
  );

  // Title
  lines.push("", `# ${entity.name}`, "");

  // Status line
  const statusParts: string[] = [];
  if (payload.hookType) statusParts.push(payload.hookType);
  if (payload.difficulty) statusParts.push(payload.difficulty);
  if (payload.urgency && payload.urgency !== "whenever") statusParts.push(payload.urgency);
  if (entity.tags?.length) statusParts.push(...entity.tags);
  if (statusParts.length) {
    lines.push(`*${statusParts.join(" · ")}*`, "");
  }

  // Summary (player-facing pitch)
  if (entity.summary) {
    lines.push("## The Hook", "", entity.summary, "");
  }

  // Quick reference table
  lines.push("## At a Glance", "");
  if (payload.hookType) lines.push(`- **Type:** ${payload.hookType}`);
  if (payload.urgency) {
    const urgencyMap: Record<string, string> = {
      "background": "No time pressure",
      "whenever": "Do it when convenient",
      "soon": "Should be addressed soon",
      "urgent": "Time-sensitive",
      "critical": "Immediate action required",
    };
    const urgencyDesc = urgencyMap[payload.urgency as string] || payload.urgency;
    lines.push(`- **Urgency:** ${urgencyDesc}`);
  }
  if (payload.difficulty) {
    const difficultyMap: Record<string, string> = {
      "trivial": "Very easy",
      "easy": "Straightforward",
      "moderate": "Challenging",
      "hard": "Difficult",
      "deadly": "Extremely dangerous",
    };
    const difficultyDesc = difficultyMap[payload.difficulty as string] || payload.difficulty;
    lines.push(`- **Difficulty:** ${difficultyDesc}`);
  }
  if (payload.rewardType) {
    lines.push(`- **Reward:** ${payload.rewardType}`);
  }
  if (payload.rewardDetails) {
    lines.push(`- **Reward Details:** ${payload.rewardDetails}`);
  }
  lines.push("");

  // Location
  const burgId = entity.anchors?.burgId;
  if (burgId) {
    const burg = world.getBurg(burgId);
    if (burg) {
      lines.push("## Location", "", `Available in **${burg.name}**`, "");
    }
  }

  // GM Details
  if (entity.details_md) {
    lines.push("## GM Details", "", entity.details_md, "");
  }

  // Complications
  const complications = payload.complications;
  if (Array.isArray(complications) && complications.length) {
    lines.push("## Potential Complications", "");
    for (const c of complications) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  // Failure consequences
  if (payload.failureConsequences) {
    lines.push("## If They Fail or Ignore", "", payload.failureConsequences, "");
  }

  // Linked entities
  const linkedEvent = entity.anchors?.linkedEventId;
  const linkedNpc = entity.anchors?.linkedNpcId;
  const linkedFaction = entity.anchors?.linkedFactionId;
  if (linkedEvent || linkedNpc || linkedFaction) {
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
        lines.push(`- **Quest Giver:** ${wikilink(npc)}`);
      }
    }
    if (linkedFaction) {
      const faction = getEntityById(linkedFaction);
      if (faction) {
        lines.push(`- **Faction Involved:** ${wikilink(faction)}`);
      }
    }
    lines.push("");
  }

  // Other connections
  lines.push(generateConnectionsSection(ctx));

  return lines.join("\n");
}
