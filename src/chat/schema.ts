import { z } from "zod";

export const EntityTypeEnum = z.enum(["npc", "faction", "location", "event", "rumor", "hook", "meta", "culture", "religion", "deity", "era", "phenomena", "relation_type", "source_text", "marker", "idea"]);

// Idea pool — short snippets generation agents can weave into outputs
export const IdeaStatusEnum = z.enum(["pending", "used"]);
export const IdeaLabelsStatusEnum = z.enum(["pending", "labeled", "skipped"]);

export const IdeaPayloadSchema = z.object({
  status: IdeaStatusEnum,
  labels: z.array(z.string()),
  labelsStatus: IdeaLabelsStatusEnum,
  usedByEntityId: z.string().optional(),
  usedAt: z.string().optional(),
});

export type IdeaPayload = z.infer<typeof IdeaPayloadSchema>;

// Deity payload schemas
export const DeityRankEnum = z.enum(["supreme", "greater", "lesser", "demigod", "spirit"]);

export const DeityPayloadSchema = z.object({
  rank: DeityRankEnum,
  domains: z.array(z.string()),
  alignment: z.string(),
  symbols: z.array(z.string()),
  titles: z.array(z.string()),
  sacredAnimal: z.string().optional(),
  sacredElement: z.string().optional(),
  festivals: z.array(z.string()).optional(),
  appearance: z.string().optional(),
  mythology: z.string().optional(),
  worshipStyle: z.string().optional(),
});

export type DeityPayload = z.infer<typeof DeityPayloadSchema>;

// Event scope and severity enums
export const EventScopeEnum = z.enum(["neighborhood", "burg", "state", "region", "world"]);
export const EventSeverityEnum = z.enum(["minor", "moderate", "major", "catastrophic"]);
export const EventScaleEnum = z.enum(["covert", "incident", "operation", "crisis", "historic"]);
export const SecrecyLevelEnum = z.enum(["secret", "restricted", "rumored", "public"]);
export const HistoricalRecencyBandEnum = z.enum(["mythic", "ancient", "old", "recent", "living-memory"]);
export const GoalStatusEnum = z.enum(["dormant", "advancing", "blocked", "achieved", "failed"]);

// Event consequence schema
export const EventConsequenceSchema = z.object({
  type: z.string(),
  target: z.string().optional(),
  severity: z.string().optional(),
  effect: z.string().optional(),
});

export const EventAudienceSchema = z.object({
  public: z.boolean().optional(),
  knownFactionIds: z.array(z.string()).optional(),
  knownNpcIds: z.array(z.string()).optional(),
  knownBurgIds: z.array(z.union([z.number(), z.string()])).optional(),
  knownStateIds: z.array(z.union([z.number(), z.string()])).optional(),
  suspectedByFactionIds: z.array(z.string()).optional(),
});

// Event payload schema (stored in entity.payload for event entities)
export const EventPayloadSchema = z.object({
  kind: z.string(),
  scope: EventScopeEnum,
  severity: EventSeverityEnum,
  scale: EventScaleEnum.optional(),
  secrecy: SecrecyLevelEnum.optional(),
  audience: EventAudienceSchema.optional(),
  ongoing: z.boolean(),
  daysAgo: z.number().optional(),
  historical: z.boolean().optional(),
  eraId: z.string().optional(),
  eraLabel: z.string().optional(),
  recencyBand: HistoricalRecencyBandEnum.optional(),
  relativeOrder: z.number().optional(),
  sequenceHint: z.string().optional(),
  participants: z.array(z.string()).optional(),
  outcome: z.string().optional(),
  significance: z.string().optional(),
  consequences: z.array(EventConsequenceSchema).optional(),
});

export type EventPayload = z.infer<typeof EventPayloadSchema>;
export type EventConsequence = z.infer<typeof EventConsequenceSchema>;

export const EraPayloadSchema = z.object({
  relativeOrder: z.number().optional(),
  startLabel: z.string().optional(),
  endLabel: z.string().optional(),
  parentEraId: z.string().optional(),
  notes: z.string().optional(),
});

export type EraPayload = z.infer<typeof EraPayloadSchema>;

export const PhenomenaPayloadSchema = z.object({
  category: z.string().optional(),
  nature: z.string().optional(),
  scope: EventScopeEnum.optional(),
  dangerLevel: z.string().optional(),
  stability: z.string().optional(),
  visibility: SecrecyLevelEnum.optional(),
  effects: z.array(z.string()).optional(),
  triggers: z.array(z.string()).optional(),
  manifestations: z.array(z.string()).optional(),
  origin: z.string().optional(),
  interactionNotes: z.string().optional(),
});

export type PhenomenaPayload = z.infer<typeof PhenomenaPayloadSchema>;

export const RelationTypePayloadSchema = z.object({
  inverseName: z.string().optional(),
  domainTypes: z.array(EntityTypeEnum).optional(),
  rangeTypes: z.array(EntityTypeEnum).optional(),
  symmetric: z.boolean().optional(),
  transitive: z.boolean().optional(),
  usageNotes: z.string().optional(),
  examples: z.array(z.string()).optional(),
});

export type RelationTypePayload = z.infer<typeof RelationTypePayloadSchema>;

// Rumor schemas
export const RumorTruthLevelEnum = z.enum(["false", "distorted", "mostly-true", "true"]);
export const RumorSpreadLevelEnum = z.enum(["whisper", "local", "regional", "widespread"]);
export const RumorSourceTypeEnum = z.enum(["gossip", "observation", "leak", "planted", "unknown"]);

export const RumorPayloadSchema = z.object({
  truthLevel: RumorTruthLevelEnum,
  spreadLevel: RumorSpreadLevelEnum,
  sourceType: RumorSourceTypeEnum,
  secrecy: SecrecyLevelEnum.optional(),
  ageDays: z.number().optional(),
  linkedEventId: z.string().optional(),
  linkedNpcId: z.string().optional(),
  actualTruth: z.string().optional(), // GM-only: what's really true
});

export type RumorPayload = z.infer<typeof RumorPayloadSchema>;

export const FactionGoalProgressSchema = z.object({
  id: z.string(),
  goal: z.string(),
  status: GoalStatusEnum,
  progress: z.number().min(0).max(100),
  priority: z.number().min(1).max(5).optional(),
  horizonDays: z.number().optional(),
  stage: z.string().optional(),
  completedMilestones: z.array(z.string()).optional(),
  nextMilestone: z.string().optional(),
  blockers: z.array(z.string()).optional(),
  secrecy: SecrecyLevelEnum.optional(),
  evidence: z.array(z.string()).optional(),
  knownBy: z.array(z.string()).optional(),
  lastAdvancedDay: z.number().optional(),
});

export type FactionGoalProgress = z.infer<typeof FactionGoalProgressSchema>;

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

// Marker payload schema - wilderness/map locations outside of burgs
export const MarkerKindEnum = z.enum([
  "ruin", "tower", "dungeon", "shrine", "cave", "camp",
  "monument", "grove", "mine", "bridge", "battlefield",
  "portal", "lair", "oasis", "lighthouse", "shipwreck", "other"
]);

export const MarkerPayloadSchema = z.object({
  kind: MarkerKindEnum,
  icon: z.string().optional(),             // Emoji icon for map display
  cellId: z.number().optional(),           // Azgaar cell ID for precise placement
  x: z.number().optional(),               // Map x coordinate
  y: z.number().optional(),               // Map y coordinate
  condition: z.string().optional(),        // "intact", "ruined", "hidden", "overgrown", etc.
  dangerLevel: z.string().optional(),      // "safe", "cautious", "dangerous", "deadly"
  discoverable: z.boolean().optional(),    // Whether it's known or must be found
  physicalDescription: z.string().optional(),
  atmosphere: z.string().optional(),
  features: z.array(z.string()).optional(),
  inhabitants: z.string().optional(),      // Who/what lives there
  loot: z.string().optional(),
  history: z.string().optional(),
});

export type MarkerPayload = z.infer<typeof MarkerPayloadSchema>;

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
