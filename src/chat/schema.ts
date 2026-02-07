import { z } from "zod";

export const EntityTypeEnum = z.enum(["npc", "faction", "location", "event", "rumor", "hook", "meta", "culture", "religion"]);

// Event scope and severity enums
export const EventScopeEnum = z.enum(["neighborhood", "burg", "state", "region", "world"]);
export const EventSeverityEnum = z.enum(["minor", "moderate", "major", "catastrophic"]);

// Event consequence schema
export const EventConsequenceSchema = z.object({
  type: z.string(),
  target: z.string().optional(),
  severity: z.string().optional(),
  effect: z.string().optional(),
});

// Event payload schema (stored in entity.payload for event entities)
export const EventPayloadSchema = z.object({
  kind: z.string(),
  scope: EventScopeEnum,
  severity: EventSeverityEnum,
  ongoing: z.boolean(),
  daysAgo: z.number(),
  consequences: z.array(EventConsequenceSchema).optional(),
});

export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type EventConsequence = z.infer<typeof EventConsequenceSchema>;

// Rumor schemas
export const RumorTruthLevelEnum = z.enum(["false", "distorted", "mostly-true", "true"]);
export const RumorSpreadLevelEnum = z.enum(["whisper", "local", "regional", "widespread"]);
export const RumorSourceTypeEnum = z.enum(["gossip", "observation", "leak", "planted", "unknown"]);

export const RumorPayloadSchema = z.object({
  truthLevel: RumorTruthLevelEnum,
  spreadLevel: RumorSpreadLevelEnum,
  sourceType: RumorSourceTypeEnum,
  linkedEventId: z.string().optional(),
  linkedNpcId: z.string().optional(),
  actualTruth: z.string().optional(), // GM-only: what's really true
});

export type RumorPayload = z.infer<typeof RumorPayloadSchema>;

// Hook (quest/adventure) schemas
export const HookTypeEnum = z.enum([
  "investigation", "rescue", "exploration", "negotiation",
  "combat", "heist", "escort", "delivery", "mystery", "social"
]);
export const HookUrgencyEnum = z.enum(["background", "whenever", "soon", "urgent", "critical"]);
export const HookDifficultyEnum = z.enum(["trivial", "easy", "moderate", "hard", "deadly"]);
export const HookRewardTypeEnum = z.enum(["gold", "information", "favor", "item", "reputation", "mixed"]);

export const HookPayloadSchema = z.object({
  hookType: HookTypeEnum,
  urgency: HookUrgencyEnum,
  difficulty: HookDifficultyEnum,
  rewardType: HookRewardTypeEnum,
  rewardDetails: z.string().optional(),
  linkedEventId: z.string().optional(),
  linkedNpcId: z.string().optional(),
  linkedFactionId: z.string().optional(),
  complications: z.array(z.string()).optional(), // Potential twists
  failureConsequences: z.string().optional(),
});

export type HookPayload = z.infer<typeof HookPayloadSchema>;

// Reaction schemas for LLM-assisted reactions
export const ReactionCategoryEnum = z.enum(["political", "economic", "social", "factional"]);
export const ReactionIntensityEnum = z.enum(["subtle", "moderate", "dramatic"]);

export const ReactionOutcomeSchema = z.object({
  type: z.enum(["relation", "rumor", "event"]),
  description: z.string(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  relationType: z.string().optional(),
});

export const ReactionCandidateSchema = z.object({
  description: z.string(),
  category: ReactionCategoryEnum,
  intensity: ReactionIntensityEnum,
  publiclyVisible: z.boolean(),
  creates: z.array(ReactionOutcomeSchema).optional(),
});

export const ReactionGenerationResultSchema = z.object({
  actorName: z.string(),
  eventName: z.string(),
  candidates: z.array(ReactionCandidateSchema),
});

export type ReactionCandidate = z.infer<typeof ReactionCandidateSchema>;
export type ReactionOutcome = z.infer<typeof ReactionOutcomeSchema>;

// Campaign settings schemas
export const ContentRatingEnum = z.enum(["pg", "teen", "mature", "explicit"]);
export const CampaignSettingsSchema = z.object({
  worldVibe: z.string().optional(),
  culturalTouchpoints: z.string().optional(),
  campaignArc: z.string().optional(),
  userNotes: z.string().optional(),
  contentTone: z.number().min(1).max(5).optional(),
  rating: ContentRatingEnum.optional(),
});
export type CampaignSettings = z.infer<typeof CampaignSettingsSchema>;
