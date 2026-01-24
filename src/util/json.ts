export function jsonDumps(v: unknown, pretty = false): string {
  return JSON.stringify(v, null, pretty ? 2 : 0);
}

export function parseJsonLoose(text: string): unknown {
  // 1) Straight parse
  try {
    return JSON.parse(text);
  } catch {
    // 2) Try to extract the first JSON object/array in the text
    const objStart = text.indexOf("{");
    const objEnd = text.lastIndexOf("}");
    if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
      const slice = text.slice(objStart, objEnd + 1);
      try {
        return JSON.parse(slice);
      } catch {
        // keep going
      }
    }

    const arrStart = text.indexOf("[");
    const arrEnd = text.lastIndexOf("]");
    if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
      const slice = text.slice(arrStart, arrEnd + 1);
      try {
        return JSON.parse(slice);
      } catch {
        // fallthrough
      }
    }
  }

  throw new Error("Failed to parse JSON");
}
