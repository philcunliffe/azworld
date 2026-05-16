import type { LLMClient } from "../../llm/providers";
import type { CanonStore } from "../../canon/canon";
import { CampaignStore } from "../../campaign/store";
import { createWebCampaignGenerators } from "./generators";
import {
  type CampaignWebDeps,
  handleArchive,
  handleCreate,
  handleDetail,
  handleList,
  handleNewForm,
  handleSay,
} from "./handlers";

export interface RegisterCampaignRoutesOpts {
  canon: CanonStore;
  llm: LLMClient;
  generationLlm?: LLMClient;
}

export type CampaignRouteHandler = (url: URL, request: Request) => Promise<Response | null>;

export function registerCampaignRoutes(opts: RegisterCampaignRoutesOpts): CampaignRouteHandler {
  const campaignStore = new CampaignStore(opts.canon.db);
  campaignStore.initDb();

  const llmForGeneration = opts.generationLlm ?? opts.llm;
  const generators = createWebCampaignGenerators(llmForGeneration, opts.canon);

  const deps: CampaignWebDeps = {
    campaignStore,
    canon: opts.canon,
    generators,
    llm: opts.llm,
  };

  return async (url, request) => {
    const { pathname } = url;
    const method = request.method.toUpperCase();

    if (pathname === "/campaign" && method === "GET") {
      return handleList(deps, url);
    }
    if (pathname === "/campaign/new" && method === "GET") {
      return handleNewForm();
    }
    if (pathname === "/campaign/new" && method === "POST") {
      return handleCreate(deps, request);
    }

    const idMatch = pathname.match(/^\/campaign\/([^/]+)(\/[^/]+)?$/);
    if (idMatch) {
      const id = decodeURIComponent(idMatch[1]!);
      const sub = idMatch[2] ?? "";
      if (sub === "" && method === "GET") {
        return handleDetail(deps, id);
      }
      if (sub === "/say" && method === "POST") {
        return handleSay(deps, id, request);
      }
      if (sub === "/archive" && method === "POST") {
        return handleArchive(deps, id);
      }
    }

    return null;
  };
}
