import type { LLMClient } from "../../llm/providers";
import type { CanonStore } from "../../canon/canon";
import { CampaignStore } from "../../campaign/store";
import { CampaignSession } from "../../campaign/session";
import { createCampaignToolRegistry, type CampaignGenerators } from "../../campaign/tools";
import { runOneTurn } from "../../campaign/turn";
import { renderListPage } from "./views/list";
import { renderNewPage } from "./views/new";
import { renderDetailPage } from "./views/detail";

export interface CampaignWebDeps {
  campaignStore: CampaignStore;
  canon: CanonStore;
  generators: CampaignGenerators;
  llm: LLMClient;
}

function html(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function redirect(location: string): Response {
  return new Response("", {
    status: 303,
    headers: { location },
  });
}

function parseFilter(url: URL): "open" | "archived" | "all" {
  const raw = url.searchParams.get("status") ?? "open";
  if (raw === "archived") return "archived";
  if (raw === "all") return "all";
  return "open";
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const ct = request.headers.get("content-type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    return new URLSearchParams(text);
  }
  if (ct.includes("multipart/form-data")) {
    const fd = await request.formData();
    const params = new URLSearchParams();
    for (const [k, v] of fd.entries()) {
      params.append(k, typeof v === "string" ? v : "");
    }
    return params;
  }
  // Fallback: try query/body parsing.
  try {
    const text = await request.text();
    return new URLSearchParams(text);
  } catch {
    return new URLSearchParams();
  }
}

export async function handleList(deps: CampaignWebDeps, url: URL): Promise<Response> {
  const filter = parseFilter(url);
  const all = deps.campaignStore.listCampaigns(filter === "all" ? {} : { status: filter });
  return html(renderListPage({ campaigns: all, filter }));
}

export function handleNewForm(): Response {
  return html(renderNewPage({}));
}

export async function handleCreate(deps: CampaignWebDeps, request: Request): Promise<Response> {
  const form = await readForm(request);
  const name = (form.get("name") ?? "").trim();
  const intent = (form.get("intent") ?? "").trim();
  if (!name) {
    return html(renderNewPage({ error: "Name is required.", intent }), { status: 400 });
  }
  const session = CampaignSession.create(deps.campaignStore, { name, intentMd: intent });
  return redirect(`/campaign/${encodeURIComponent(session.id)}`);
}

function loadSessionOr404(deps: CampaignWebDeps, id: string): CampaignSession | Response {
  try {
    return CampaignSession.load(deps.campaignStore, id);
  } catch {
    return html(renderListPage({
      campaigns: deps.campaignStore.listCampaigns(),
      filter: "open",
    }).replace("<h1>Campaigns</h1>", `<h1>Campaigns</h1><p style="color:#b91c1c">Campaign <code>${id}</code> not found.</p>`), { status: 404 });
  }
}

export function handleDetail(deps: CampaignWebDeps, id: string, opts: { error?: string; notice?: string } = {}): Response {
  const session = loadSessionOr404(deps, id);
  if (session instanceof Response) return session;
  return html(renderDetailPage({
    campaign: session.getCampaign() as any,
    canon: deps.canon,
    error: opts.error,
    notice: opts.notice,
  }));
}

export async function handleSay(deps: CampaignWebDeps, id: string, request: Request): Promise<Response> {
  const form = await readForm(request);
  const text = (form.get("text") ?? "").trim();
  const session = loadSessionOr404(deps, id);
  if (session instanceof Response) return session;

  if (!text) {
    return html(renderDetailPage({
      campaign: session.getCampaign() as any,
      canon: deps.canon,
      error: "Empty turn — type a message before sending.",
    }), { status: 400 });
  }

  const registry = createCampaignToolRegistry({
    session,
    canon: deps.canon,
    generators: deps.generators,
  });

  try {
    await runOneTurn({
      session,
      registry,
      llm: deps.llm,
      userText: text,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return html(renderDetailPage({
      campaign: session.getCampaign() as any,
      canon: deps.canon,
      error: `Turn failed: ${msg}`,
    }), { status: 500 });
  }

  return redirect(`/campaign/${encodeURIComponent(id)}`);
}

export async function handleArchive(deps: CampaignWebDeps, id: string): Promise<Response> {
  const session = loadSessionOr404(deps, id);
  if (session instanceof Response) return session;
  session.archive();
  return redirect("/campaign?status=archived");
}
