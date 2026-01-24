// RFC 7396-ish merge patch for plain objects.
export function mergePatch(base: any, patch: any): any {
  if (patch === null || patch === undefined) return patch;
  if (typeof patch !== "object" || Array.isArray(patch)) {
    return patch;
  }

  const out: any = { ...(typeof base === "object" && base && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
    } else if (typeof v === "object" && v && !Array.isArray(v)) {
      out[k] = mergePatch(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
