import { z } from "zod";

export const EntityTypeEnum = z.enum(["npc", "faction", "location", "event", "rumor", "hook", "meta"]);

export const SceneEntitySchema = z.object({
  key: z.string().min(1),
  type: EntityTypeEnum,
  name: z.string().min(1),
  summary: z.string().optional(),
  details_md: z.string().optional(),
  tags: z.array(z.string()).optional(),
  payload: z.record(z.any()).optional(),
});

export const SceneRelationSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  rel_type: z.string().min(1),
  strength: z.number().optional(),
  notes: z.string().optional(),
});

export const SceneGenResultSchema = z.object({
  entities: z.array(SceneEntitySchema),
  relations: z.array(SceneRelationSchema),
  narration: z.string().min(1),
});

export type SceneGenResult = z.infer<typeof SceneGenResultSchema>;

// A conservative JSON Schema object that both OpenAI Structured Outputs and Ollama's `format` schema tend to accept.
// We avoid advanced constructs (`oneOf`, patternProperties, etc.) for better compatibility.
export const SCENE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string" },
          type: { type: "string" },
          name: { type: "string" },
          summary: { type: "string" },
          details_md: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          payload: { type: "object" },
        },
        required: ["key", "type", "name"],
      },
    },
    relations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          rel_type: { type: "string" },
          strength: { type: "number" },
          notes: { type: "string" },
        },
        required: ["from", "to", "rel_type"],
      },
    },
    narration: { type: "string" },
  },
  required: ["entities", "relations", "narration"],
};
