import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export interface SkillMetadata {
  name: string;           // e.g., "generate-town"
  description: string;    // What the skill does
  path: string;           // Absolute path to skill directory
  license?: string;
  compatibility?: string;
  metadata?: Record<string, string>;
}

export interface Skill extends SkillMetadata {
  instructions: string;   // Full SKILL.md body (after frontmatter)
}

// Parse YAML frontmatter from SKILL.md content
function parseFrontmatter(content: string): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  // Simple YAML parsing (name: value, metadata block)
  const yaml = match[1];
  const body = match[2];
  const frontmatter: Record<string, any> = {};

  // Parse key: value pairs (handles multiline for metadata)
  let currentKey = "";
  for (const line of yaml.split("\n")) {
    const kvMatch = line.match(/^(\w[\w-]*?):\s*(.*)$/);
    if (kvMatch && !line.startsWith("  ")) {
      currentKey = kvMatch[1];
      frontmatter[currentKey] = kvMatch[2] || {};
    } else if (line.startsWith("  ") && currentKey === "metadata") {
      const subMatch = line.match(/^\s+(\w[\w-]*?):\s*(.*)$/);
      if (subMatch) {
        if (typeof frontmatter.metadata !== "object") frontmatter.metadata = {};
        frontmatter.metadata[subMatch[1]] = subMatch[2].replace(/^["']|["']$/g, "");
      }
    }
  }

  return { frontmatter, body };
}

// Discover skills from multiple paths
export function discoverSkills(searchPaths: string[]): SkillMetadata[] {
  const skills: SkillMetadata[] = [];

  for (const basePath of searchPaths) {
    if (!existsSync(basePath)) continue;

    for (const entry of readdirSync(basePath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const skillPath = join(basePath, entry.name);
      const skillMdPath = join(skillPath, "SKILL.md");

      if (!existsSync(skillMdPath)) continue;

      try {
        const content = readFileSync(skillMdPath, "utf-8");
        const { frontmatter } = parseFrontmatter(content);

        if (!frontmatter.name || !frontmatter.description) continue;

        // Validate name matches directory
        if (frontmatter.name !== entry.name) {
          console.warn(`Skill name mismatch: ${frontmatter.name} vs directory ${entry.name}`);
        }

        skills.push({
          name: frontmatter.name,
          description: frontmatter.description,
          path: skillPath,
          license: frontmatter.license,
          compatibility: frontmatter.compatibility,
          metadata: frontmatter.metadata,
        });
      } catch (e) {
        console.warn(`Failed to parse skill at ${skillPath}:`, e);
      }
    }
  }

  return skills;
}

// Load full skill content
export function loadSkill(metadata: SkillMetadata): Skill {
  const skillMdPath = join(metadata.path, "SKILL.md");
  const content = readFileSync(skillMdPath, "utf-8");
  const { body } = parseFrontmatter(content);

  return { ...metadata, instructions: body.trim() };
}

// Format skills for director system prompt
export function formatSkillsForPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) return "";

  const skillXml = skills.map(s =>
    `  <skill>
    <name>${s.name}</name>
    <description>${s.description}</description>
    <invoke>/${s.name} [optional context]</invoke>
  </skill>`
  ).join("\n");

  return `
<available_skills>
${skillXml}
</available_skills>

When the user invokes a skill with /<skill-name>, you will receive the skill's full instructions.
Follow those instructions precisely to complete the task.`;
}
