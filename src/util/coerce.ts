export function coerceInt(v: any): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return null;
    const n = Number(t);
    if (Number.isInteger(n)) return n;
  }
  return null;
}
