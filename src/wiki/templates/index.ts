import { CanonEntity, CanonRelation } from "../../canon/canon";
import { AzgaarWorld } from "../../world/azgaar";
import { slugify } from "../../util/slug";

export type TemplateContext = {
  entity: CanonEntity;
  relations: {
    outgoing: CanonRelation[];
    incoming: CanonRelation[];
  };
  world: AzgaarWorld;
  getEntityById: (id: string) => CanonEntity | undefined;
  filenameForEntity: (entity: CanonEntity) => string;
};

export type EntityTemplate = (ctx: TemplateContext) => string;

/**
 * Generate a stable filename for an entity.
 * Format: {type}-{slugified-name}-{short-id}.md
 */
export function stableFilename(entity: CanonEntity): string {
  const parts = entity.id.split("_");
  const shortId = parts.length > 1 ? parts[1]?.slice(0, 8) : entity.id.slice(0, 8);
  const slug = slugify(entity.name);
  return `${entity.type}-${slug}-${shortId}.md`;
}

/**
 * Generate wikilink reference for an entity
 */
export function wikilink(entity: CanonEntity | undefined, label?: string): string {
  if (!entity) return label || "(unknown)";
  const filename = stableFilename(entity).replace(/\.md$/, "");
  const displayLabel = label || entity.name;
  return `[[${filename}|${displayLabel}]]`;
}

/**
 * Generate YAML frontmatter
 */
export function frontmatter(data: Record<string, any>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---");
  return lines.join("\n");
}

/**
 * Generate backlinks/connections section from relations
 */
export function generateConnectionsSection(ctx: TemplateContext): string {
  const { relations, getEntityById } = ctx;
  const { outgoing, incoming } = relations;

  if (!outgoing.length && !incoming.length) return "";

  const lines = ["", "## Connections", ""];

  if (outgoing.length) {
    for (const rel of outgoing) {
      const target = getEntityById(rel.to_id);
      const link = wikilink(target);
      lines.push(`- **${rel.rel_type}** → ${link}`);
    }
  }

  if (incoming.length) {
    for (const rel of incoming) {
      const source = getEntityById(rel.from_id);
      const link = wikilink(source);
      lines.push(`- ${link} → **${rel.rel_type}**`);
    }
  }

  return lines.join("\n");
}

// Re-export individual templates
export { npcTemplate } from "./npc";
export { factionTemplate } from "./faction";
export { locationTemplate } from "./location";
export { eventTemplate } from "./event";
export { rumorTemplate } from "./rumor";
export { hookTemplate } from "./hook";

/**
 * Get the appropriate template for an entity type
 */
export function getTemplate(type: string): EntityTemplate {
  switch (type) {
    case "npc":
      return require("./npc").npcTemplate;
    case "faction":
      return require("./faction").factionTemplate;
    case "location":
      return require("./location").locationTemplate;
    case "event":
      return require("./event").eventTemplate;
    case "rumor":
      return require("./rumor").rumorTemplate;
    case "hook":
      return require("./hook").hookTemplate;
    default:
      return defaultTemplate;
  }
}

/**
 * Default template for entities without a specific template
 */
function defaultTemplate(ctx: TemplateContext): string {
  const { entity } = ctx;

  const lines: string[] = [];

  lines.push(
    frontmatter({
      id: entity.id,
      type: entity.type,
      name: entity.name,
      tags: entity.tags,
      anchors: entity.anchors,
      updated_at: entity.updated_at,
    })
  );

  lines.push("", `# ${entity.name}`, "");

  if (entity.summary) {
    lines.push(entity.summary, "");
  }

  if (entity.details_md) {
    lines.push(entity.details_md, "");
  }

  const payload = entity.payload || {};
  if (Object.keys(payload).length) {
    lines.push("## Details", "", "```json", JSON.stringify(payload, null, 2), "```", "");
  }

  lines.push(generateConnectionsSection(ctx));

  return lines.join("\n");
}
