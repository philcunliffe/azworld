import { AzgaarWorld } from "../../world/azgaar";
import { CanonStore, CanonEntity } from "../../canon/canon";
import { LLMClient, ToolDefinition } from "../../llm/providers";
import { ChatState } from "../director";

export type ToolContext = {
  world: AzgaarWorld;
  canon: CanonStore;
  llm: LLMClient;
  state: ChatState;
};

export type ToolHandler = (args: Record<string, any>, ctx: ToolContext) => Promise<any>;

export type RegisteredTool = {
  definition: ToolDefinition;
  handler: ToolHandler;
};

export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();

  register(name: string, definition: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(name, { definition, handler });
  }

  getDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  getHandler(name: string): ToolHandler | undefined {
    return this.tools.get(name)?.handler;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  async execute(name: string, args: Record<string, any>, ctx: ToolContext): Promise<any> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return tool.handler(args, ctx);
  }
}

// Re-export tool registration functions
export { registerWorldTools } from "./world-tools";
export { registerCanonTools } from "./canon-tools";
export { registerGenerateTools } from "./generate-tools";
export { registerSessionTools } from "./session-tools";

// Create and configure a full director tool registry
export function createDirectorRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // Import and register all tools
  const { registerWorldTools } = require("./world-tools");
  const { registerCanonTools } = require("./canon-tools");
  const { registerGenerateTools } = require("./generate-tools");
  const { registerSessionTools } = require("./session-tools");

  registerWorldTools(registry);
  registerCanonTools(registry);
  registerGenerateTools(registry);
  registerSessionTools(registry);

  return registry;
}
