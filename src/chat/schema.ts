import { z } from "zod";

export const EntityTypeEnum = z.enum(["npc", "faction", "location", "event", "rumor", "hook", "meta"]);

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
