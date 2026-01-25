import readline from "node:readline";
import { CanonStore } from "../canon/canon";
import { CampaignSettings, CampaignSettingsSchema } from "./schema";

export type GenerationFlags = {
  states?: boolean;
  religions?: boolean;
  cultures?: boolean;
};

export type OnboardingResult = {
  settings: CampaignSettings | undefined;
  generate?: GenerationFlags;
};

const CAMPAIGN_SETTINGS_NAME = "campaign-settings";

/**
 * Retrieve existing campaign settings from canon meta entity.
 */
export function getCampaignSettings(canon: CanonStore): CampaignSettings | undefined {
  const entities = canon.listEntities({ type: "meta", limit: 100 });
  const settingsEntity = entities.find((e) => e.name === CAMPAIGN_SETTINGS_NAME);
  if (!settingsEntity) return undefined;

  const parsed = CampaignSettingsSchema.safeParse(settingsEntity.payload);
  if (!parsed.success) return undefined;
  return parsed.data;
}

/**
 * Save campaign settings as a meta entity.
 */
export function saveCampaignSettings(canon: CanonStore, settings: CampaignSettings): void {
  const entities = canon.listEntities({ type: "meta", limit: 100 });
  const existing = entities.find((e) => e.name === CAMPAIGN_SETTINGS_NAME);

  if (existing) {
    canon.patchEntity(existing.id, {
      payload: settings,
      meta: { updatedAt: new Date().toISOString() },
    });
  } else {
    canon.addEntity({
      type: "meta",
      name: CAMPAIGN_SETTINGS_NAME,
      summary: "Campaign-wide settings for LLM generation",
      payload: settings,
      tags: ["system"],
      provenance: { source: "onboarding", intent: "Configure campaign tone and style" },
    });
  }
}

/**
 * Interactive onboarding flow to gather campaign settings.
 */
export async function runOnboarding(
  rl: readline.Interface,
  canon: CanonStore
): Promise<OnboardingResult> {
  const ask = (q: string) => new Promise<string>((resolve) => rl.question(q, resolve));

  console.log("\n=== Campaign Settings ===");
  console.log("These settings shape how AI generates content for your world.");
  console.log("Press Enter to skip any field.\n");

  // World Vibe
  console.log("1. WORLD VIBE");
  console.log("   The overall feel of your world.");
  const worldVibe = (await ask('   World vibe (e.g., "Dark medieval with lingering magic", "High fantasy with ancient ruins"): ')).trim() || undefined;

  // Cultural Touchpoints
  console.log("\n2. CULTURAL TOUCHPOINTS");
  console.log("   Inspirations for tone and style.");
  const culturalTouchpoints = (await ask('   Inspirations (e.g., "Game of Thrones politics", "Tolkien grandeur", "Dark Souls bleakness"): ')).trim() || undefined;

  // Campaign Arc
  console.log("\n3. CAMPAIGN ARC");
  console.log('   What are the heroes working toward? (e.g., "Stop the lich king from rising",');
  console.log('   "Unite the fractured kingdoms", "Survive the apocalypse")');
  const campaignArc = (await ask("   Campaign arc: ")).trim() || undefined;

  // User Notes
  console.log("\n4. ADDITIONAL NOTES");
  console.log("   Any other context the AI should know (house rules, banned content, etc.)");
  const userNotes = (await ask("   Notes: ")).trim() || undefined;

  // Content Tone
  console.log("\n5. CONTENT TONE (1-5)");
  console.log("   1 = Gritty/Dark (violence, despair, moral ambiguity)");
  console.log("   3 = Balanced (adventure with consequences)");
  console.log("   5 = Lighthearted (heroic, comedic, hopeful)");
  const toneInput = (await ask("   Tone [1-5, default 3]: ")).trim();
  let contentTone: number | undefined;
  if (toneInput) {
    const parsed = parseInt(toneInput, 10);
    if (parsed >= 1 && parsed <= 5) contentTone = parsed;
  }

  // Rating
  console.log("\n6. CONTENT RATING");
  console.log("   pg       - Family friendly, no violence or mature themes");
  console.log("   teen     - Mild violence, no explicit content (default)");
  console.log("   mature   - Blood, darker themes, implied adult content");
  console.log("   explicit - No restrictions");
  const ratingInput = (await ask("   Rating [pg/teen/mature/explicit, default teen]: ")).trim().toLowerCase();
  let rating: "pg" | "teen" | "mature" | "explicit" | undefined;
  if (["pg", "teen", "mature", "explicit"].includes(ratingInput)) {
    rating = ratingInput as typeof rating;
  }

  const settings: CampaignSettings = {
    worldVibe,
    culturalTouchpoints,
    campaignArc,
    userNotes,
    contentTone,
    rating,
  };

  // Check if anything was provided
  const hasContent = Object.values(settings).some((v) => v !== undefined);
  if (!hasContent) {
    console.log("\n(No settings provided. Using defaults.)");
  } else {
    // Save settings
    saveCampaignSettings(canon, settings);
    console.log("\n(Campaign settings saved!)");
  }

  // World generation questions
  console.log("\n=== World Generation ===");
  console.log("Generate initial world content from Azgaar map data.");
  console.log("This creates factions, NPCs, and lore based on your map.\n");

  const parseYesNo = (input: string): boolean => {
    const v = input.trim().toLowerCase();
    return v === "y" || v === "yes";
  };

  // 7. Generate State/Government content
  console.log("7. GENERATE GOVERNMENTS & RULERS");
  console.log("   Creates a faction for each state's government and a ruler NPC.");
  console.log("   Determines industries based on geography, ports, military.");
  const genStatesInput = (await ask("   Generate governments? [y/N]: ")).trim();
  const genStates = parseYesNo(genStatesInput);

  // 8. Generate Religion content
  console.log("\n8. GENERATE RELIGIONS");
  console.log("   Creates a faction for each religion with high priests/prophets.");
  console.log("   Adds details about practices, holy sites, and beliefs.");
  const genReligionsInput = (await ask("   Generate religions? [y/N]: ")).trim();
  const genReligions = parseYesNo(genReligionsInput);

  // 9. Generate Culture content
  console.log("\n9. GENERATE CULTURES");
  console.log("   Creates culture entities describing each culture's customs.");
  console.log("   Considers climate, biomes, geography, and nearby religions.");
  const genCulturesInput = (await ask("   Generate cultures? [y/N]: ")).trim();
  const genCultures = parseYesNo(genCulturesInput);

  const generate: GenerationFlags = {};
  if (genStates) generate.states = true;
  if (genReligions) generate.religions = true;
  if (genCultures) generate.cultures = true;

  const hasGeneration = Object.keys(generate).length > 0;

  return {
    settings: hasContent ? settings : undefined,
    generate: hasGeneration ? generate : undefined,
  };
}

/**
 * Format campaign settings for injection into system prompts.
 */
export function formatSettingsForPrompt(settings: CampaignSettings | undefined): string {
  if (!settings) return "";

  const lines: string[] = ["CAMPAIGN CONTEXT:"];

  if (settings.worldVibe) {
    lines.push(`World Vibe: ${settings.worldVibe}`);
  }

  if (settings.culturalTouchpoints) {
    lines.push(`Inspirations: ${settings.culturalTouchpoints}`);
  }

  if (settings.campaignArc) {
    lines.push(`Campaign Arc: ${settings.campaignArc}`);
  }

  if (settings.userNotes) {
    lines.push(`GM Notes: ${settings.userNotes}`);
  }

  // Tone guidance
  const tone = settings.contentTone ?? 3;
  if (tone <= 2) {
    lines.push("Tone: GRITTY - Emphasize danger, moral complexity, and harsh consequences. NPCs are suspicious and self-interested. Victory comes at a cost.");
  } else if (tone >= 4) {
    lines.push("Tone: LIGHTHEARTED - Emphasize heroism, humor, and hope. NPCs are generally friendly or entertainingly villainous. Good tends to prevail.");
  } else {
    lines.push("Tone: BALANCED - Mix adventure with consequences. NPCs have varied motivations. Stakes are real but not oppressive.");
  }

  // Rating constraints
  const rating = settings.rating ?? "teen";
  const ratingConstraints: Record<string, string> = {
    pg: "Content Rating: PG - Avoid violence, death, romance, alcohol, gambling, or anything unsuitable for children. Keep it wholesome.",
    teen: "Content Rating: TEEN - Mild combat and danger are fine. Avoid graphic violence, gore, explicit romance, or heavy substance use.",
    mature: "Content Rating: MATURE - Violence, blood, darker themes, and implied adult content are allowed. No explicit sexual content.",
    explicit: "Content Rating: EXPLICIT - No content restrictions. Generate appropriate to the scene.",
  };
  lines.push(ratingConstraints[rating]);

  if (lines.length === 1) return "";
  return lines.join("\n");
}

/**
 * Format settings specifically for generation tools (more concise).
 */
export function formatSettingsForGeneration(settings: CampaignSettings | undefined): string {
  if (!settings) return "";

  const parts: string[] = [];

  if (settings.worldVibe) {
    parts.push(`Vibe: ${settings.worldVibe}`);
  }

  if (settings.culturalTouchpoints) {
    parts.push(`Style: ${settings.culturalTouchpoints}`);
  }

  const tone = settings.contentTone ?? 3;
  if (tone <= 2) {
    parts.push("Tone: gritty/dark");
  } else if (tone >= 4) {
    parts.push("Tone: lighthearted/heroic");
  }

  const rating = settings.rating ?? "teen";
  if (rating === "pg") {
    parts.push("Rating: PG (family-friendly)");
  } else if (rating === "mature") {
    parts.push("Rating: mature (darker themes ok)");
  } else if (rating === "explicit") {
    parts.push("Rating: no restrictions");
  }

  return parts.length ? parts.join(". ") + "." : "";
}
