export type Globals = {
  world?: string;
  canon?: string;
  json?: boolean;
  pretty?: boolean;
  limit?: number;
};

export function extractGlobals(argv: string[]): { globals: Globals; rest: string[] } {
  const globals: Globals = {};
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--json") {
      globals.json = true;
      continue;
    }
    if (a === "--pretty") {
      globals.pretty = true;
      continue;
    }
    if (a.startsWith("--world=")) {
      globals.world = a.split("=", 2)[1];
      continue;
    }
    if (a === "--world") {
      globals.world = argv[++i];
      continue;
    }
    if (a.startsWith("--canon=")) {
      globals.canon = a.split("=", 2)[1];
      continue;
    }
    if (a === "--canon") {
      globals.canon = argv[++i];
      continue;
    }
    if (a.startsWith("--limit=")) {
      globals.limit = Number(a.split("=", 2)[1]);
      continue;
    }
    if (a === "--limit") {
      globals.limit = Number(argv[++i]);
      continue;
    }

    rest.push(a);
  }

  return { globals, rest };
}

export function readJsonArg(s?: string): unknown {
  if (!s) return undefined;
  const t = s.trim();
  if (t.startsWith("@")) {
    const path = t.slice(1);
    const text = Bun.file(path).text();
    // Bun.file().text() returns Promise, but in Bun you can use await.
    // We'll handle this in callers by using readJsonArgAsync.
    throw new Error("readJsonArg requires async; call readJsonArgAsync instead");
  }
  return JSON.parse(t);
}

export async function readJsonArgAsync(s?: string): Promise<unknown> {
  if (!s) return undefined;
  const t = s.trim();
  if (t.startsWith("@")) {
    const path = t.slice(1);
    const txt = await Bun.file(path).text();
    return JSON.parse(txt);
  }
  return JSON.parse(t);
}

export function coerceInt(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isInteger(n)) return n;
  }
  return undefined;
}
