import { z } from "zod";
import { CanonStore, CanonEntity, CanonRelation, EntityType } from "./canon";
import { AzgaarWorld } from "../world/azgaar";
import { LLMClient, completeJsonWithUsage, TokenUsage } from "../llm/providers";

const IngestEntityTypeEnum = z.enum([
  "npc", "faction", "location", "event", "rumor", "hook", "meta", "culture",
  "religion", "deity", "era", "phenomena", "relation_type",
]);

const CreateEntitySchema = z.object({
  key: z.string(),
  type: IngestEntityTypeEnum,
  name: z.string(),
  summary: z.string().optional(),
  details_md: z.string().optional(),
  tags: z.array(z.string()).optional(),
  anchors: z.record(z.any()).optional(),
  payload: z.record(z.any()).optional(),
  rationale: z.string().optional(),
});

const UpdateEntitySchema = z.object({
  entityId: z.string(),
  patch: z.object({
    name: z.string().optional(),
    summary: z.string().nullable().optional(),
    details_md: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    anchors: z.record(z.any()).optional(),
    payload: z.record(z.any()).optional(),
  }),
  rationale: z.string().optional(),
});

const RelationRefSchema = z.object({
  from: z.string(),
  to: z.string(),
  rel_type: z.string(),
  strength: z.number().optional(),
  notes: z.string().optional(),
  rationale: z.string().optional(),
});

const RelationTypeDefinitionSchema = z.object({
  name: z.string(),
  summary: z.string(),
  inverseName: z.string().optional(),
  domainTypes: z.array(IngestEntityTypeEnum).optional(),
  rangeTypes: z.array(IngestEntityTypeEnum).optional(),
  symmetric: z.boolean().optional(),
  transitive: z.boolean().optional(),
  usageNotes: z.string().optional(),
  examples: z.array(z.string()).optional(),
});

const IngestPlanSchema = z.object({
  summary: z.string(),
  creates: z.array(CreateEntitySchema).default([]),
  updates: z.array(UpdateEntitySchema).default([]),
  relations: z.array(RelationRefSchema).default([]),
  relationTypeDefinitions: z.array(RelationTypeDefinitionSchema).default([]),
  unresolvedReferences: z.array(z.string()).default([]),
  cautions: z.array(z.string()).default([]),
});

export type IngestPlan = z.infer<typeof IngestPlanSchema>;

export type IngestContext = {
  canon: CanonStore;
  world: AzgaarWorld;
  llm: LLMClient;
};

export type IngestOptions = {
  name?: string;
  text: string;
  scope?: string;
  anchors?: Record<string, any>;
  apply?: boolean;
};

export type IngestResult = {
  sourceText: CanonEntity;
  plan: IngestPlan;
  applied: boolean;
  usage?: TokenUsage;
  createdEntities?: CanonEntity[];
  updatedEntities?: CanonEntity[];
  createdRelations?: CanonRelation[];
  definedRelationTypes?: CanonEntity[];
};

function buildEntityContext(entity: CanonEntity): Record<string, any> {
  return {
    id: entity.id,
    type: entity.type,
    name: entity.name,
    summary: entity.summary || null,
    tags: entity.tags || [],
    anchors: entity.anchors || {},
    payload: entity.payload || {},
  };
}

function buildCandidateContext(canon: CanonStore, anchors: Record<string, any>): Record<string, any> {
  const candidates: CanonEntity[] = [];
  const seen = new Set<string>();
  const types: EntityType[] = [
    "era", "phenomena", "relation_type", "event", "location", "faction", "npc", "religion", "deity",
  ];

  for (const type of types) {
    const anchored = canon.listEntities({ type, anchors, limit: 20 });
    for (const entity of anchored) {
      if (seen.has(entity.id)) continue;
      seen.add(entity.id);
      candidates.push(entity);
    }
  }

  const recent = canon.listEntities({ limit: 60 });
  for (const entity of recent) {
    if (entity.type === "source_text") continue;
    if (seen.has(entity.id)) continue;
    seen.add(entity.id);
    candidates.push(entity);
    if (candidates.length >= 80) break;
  }

  return {
    entities: candidates.map(buildEntityContext),
    relationTypes: canon.listRelationTypeDefinitions().map((entity) => ({
      id: entity.id,
      name: entity.name,
      summary: entity.summary || null,
      payload: entity.payload || {},
    })),
  };
}

function buildWorldScopeContext(world: AzgaarWorld, anchors: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  const burgId = anchors.burgId;
  const stateId = anchors.stateId;
  const eraId = anchors.eraId;
  if (typeof stateId === "number") {
    const state = world.getState(stateId);
    if (state) out.state = { id: state.id, name: state.name, form: state.formName ?? state.form };
  }
  if (typeof burgId === "number") {
    const burg = world.getBurg(burgId);
    if (burg) out.burg = { id: burg.id, name: burg.name, state: burg.state };
  }
  if (typeof eraId === "string") out.eraId = eraId;
  return out;
}

function createSourceTextEntity(canon: CanonStore, opts: IngestOptions): CanonEntity {
  const title = opts.name?.trim() || "Imported Source Text";
  return canon.addEntity({
    type: "source_text",
    name: title,
    summary: `Imported prose for ${opts.scope || "world"} ingestion`,
    details_md: opts.text,
    anchors: opts.anchors || {},
    payload: {
      sourceKind: "ingest",
      scope: opts.scope || "world",
      parseStatus: "planned",
    },
    provenance: {
      generated_by: "canon_ingest",
    },
  });
}

export async function parseSourceText(ctx: IngestContext, opts: IngestOptions): Promise<IngestResult> {
  const anchors = opts.anchors || {};
  const sourceText = createSourceTextEntity(ctx.canon, opts);
  const candidateContext = buildCandidateContext(ctx.canon, anchors);
  const worldContext = buildWorldScopeContext(ctx.world, anchors);

  const system = `You are extracting structured fantasy world canon from raw prose.
The raw prose is source material, not final storage. Output ONLY valid JSON.

Rules:
- Prefer creating structured canon entities over dumping text into details_md.
- Use updates only when a matching existing entity ID from the provided context is clearly the same thing.
- If uncertain, create a new entity or list an unresolved reference.
- Relation types must use an existing built-in or provided custom relation type unless a new relationTypeDefinitions entry is included.
- Do not create source_text entities in the plan.
- Keep names stable and concise.
- For historical material, prefer era and event entities with fuzzy time fields rather than exact years.
- For magical anomalies or oddities, use phenomena.
- For new relation types, define them only when no existing edge fits.
`;

  const prompt = {
    sourceTextId: sourceText.id,
    scope: opts.scope || "world",
    anchors,
    worldContext,
    knownCanon: candidateContext,
    rawText: opts.text,
    outputContract: {
      creates: "new structured entities with keys",
      updates: "patches to existing entity IDs only when confident",
      relations: "edges between create keys or existing entity IDs",
      relationTypeDefinitions: "new custom edge definitions if needed",
      unresolvedReferences: "ambiguous names or claims requiring review",
      cautions: "duplication risks, uncertainty, or interpretation warnings",
    },
  };

  const { data, usage } = await completeJsonWithUsage(ctx.llm, {
    system,
    messages: [{ role: "user", content: JSON.stringify(prompt) }],
    maxTokens: 4000,
    temperature: 0.2,
  });

  const plan = IngestPlanSchema.parse(data);
  ctx.canon.patchEntity(sourceText.id, {
    payload: {
      parseStatus: opts.apply ? "applied" : "planned",
      planSummary: plan.summary,
      proposedCreates: plan.creates.length,
      proposedUpdates: plan.updates.length,
      proposedRelations: plan.relations.length,
    },
    provenance: {
      parserModel: ctx.llm.model,
      parserProvider: ctx.llm.provider,
    },
  });

  const result: IngestResult = { sourceText: ctx.canon.getEntity(sourceText.id)!, plan, applied: false, usage };
  if (!opts.apply) return result;

  return applyIngestPlan(ctx, sourceText.id, plan, usage);
}

export function applyIngestPlan(
  ctx: IngestContext,
  sourceTextId: string,
  plan: IngestPlan,
  usage?: TokenUsage
): IngestResult {
  const keyToId = new Map<string, string>();
  const createdEntities: CanonEntity[] = [];
  const updatedEntities: CanonEntity[] = [];
  const createdRelations: CanonRelation[] = [];
  const definedRelationTypes: CanonEntity[] = [];

  for (const def of plan.relationTypeDefinitions) {
    const existing = ctx.canon.getRelationTypeDefinition(def.name);
    if (existing) {
      const updated = ctx.canon.patchEntity(existing.id, {
        summary: def.summary,
        payload: {
          inverseName: def.inverseName,
          domainTypes: def.domainTypes,
          rangeTypes: def.rangeTypes,
          symmetric: def.symmetric,
          transitive: def.transitive,
          usageNotes: def.usageNotes,
          examples: def.examples,
        },
        provenance: {
          sourceTextId,
          method: "llm-ingest",
        },
      });
      if (updated) definedRelationTypes.push(updated);
    } else {
      definedRelationTypes.push(ctx.canon.addEntity({
        type: "relation_type",
        name: def.name,
        summary: def.summary,
        payload: {
          inverseName: def.inverseName,
          domainTypes: def.domainTypes,
          rangeTypes: def.rangeTypes,
          symmetric: def.symmetric,
          transitive: def.transitive,
          usageNotes: def.usageNotes,
          examples: def.examples,
        },
        provenance: {
          sourceTextId,
          method: "llm-ingest",
        },
      }));
    }
  }

  for (const create of plan.creates) {
    const entity = ctx.canon.addEntity({
      type: create.type as EntityType,
      name: create.name,
      summary: create.summary || null,
      details_md: create.details_md || null,
      tags: create.tags || [],
      anchors: create.anchors || {},
      payload: create.payload || {},
      provenance: {
        sourceTextId,
        method: "llm-ingest",
        rationale: create.rationale,
      },
    });
    keyToId.set(create.key, entity.id);
    createdEntities.push(entity);
  }

  for (const update of plan.updates) {
    const patched = ctx.canon.patchEntity(update.entityId, {
      ...update.patch,
      provenance: {
        sourceTextId,
        method: "llm-ingest",
        rationale: update.rationale,
      },
    });
    if (patched) updatedEntities.push(patched);
  }

  for (const rel of plan.relations) {
    const fromId = keyToId.get(rel.from) || rel.from;
    const toId = keyToId.get(rel.to) || rel.to;
    if (!ctx.canon.getEntity(fromId) || !ctx.canon.getEntity(toId)) continue;
    if (!ctx.canon.isKnownRelationType(rel.rel_type)) continue;
    createdRelations.push(ctx.canon.addRelation({
      from_id: fromId,
      to_id: toId,
      rel_type: rel.rel_type,
      strength: rel.strength ?? null,
      notes: rel.notes || rel.rationale || null,
    }));
  }

  const sourceText = ctx.canon.patchEntity(sourceTextId, {
    payload: {
      parseStatus: "applied",
      appliedCreates: createdEntities.length,
      appliedUpdates: updatedEntities.length,
      appliedRelations: createdRelations.length,
      appliedRelationTypeDefinitions: definedRelationTypes.length,
    },
  })!;

  return {
    sourceText,
    plan,
    applied: true,
    usage,
    createdEntities,
    updatedEntities,
    createdRelations,
    definedRelationTypes,
  };
}
