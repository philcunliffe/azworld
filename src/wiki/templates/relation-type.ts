import { TemplateContext, frontmatter, generateConnectionsSection } from "./index";

export function relationTypeTemplate(ctx: TemplateContext): string {
  const { entity } = ctx;
  const payload = entity.payload || {};
  const lines: string[] = [];

  lines.push(
    frontmatter({
      id: entity.id,
      type: "relation_type",
      name: entity.name,
      tags: entity.tags,
      inverseName: payload.inverseName || null,
      updated_at: entity.updated_at,
    })
  );

  lines.push("", `# ${entity.name}`, "");
  if (entity.summary) lines.push(entity.summary, "");

  const attrs: string[] = [];
  if (payload.inverseName) attrs.push(`- **Inverse:** ${payload.inverseName}`);
  if (Array.isArray(payload.domainTypes) && payload.domainTypes.length) attrs.push(`- **From:** ${payload.domainTypes.join(", ")}`);
  if (Array.isArray(payload.rangeTypes) && payload.rangeTypes.length) attrs.push(`- **To:** ${payload.rangeTypes.join(", ")}`);
  if (payload.symmetric) attrs.push("- **Symmetric:** yes");
  if (payload.transitive) attrs.push("- **Transitive:** yes");
  if (attrs.length) lines.push("## Definition", "", ...attrs, "");

  if (payload.usageNotes) lines.push("## Usage Notes", "", payload.usageNotes, "");

  if (Array.isArray(payload.examples) && payload.examples.length) {
    lines.push("## Examples", "");
    for (const example of payload.examples) lines.push(`- ${example}`);
    lines.push("");
  }

  lines.push(generateConnectionsSection(ctx));
  return lines.join("\n");
}
