export function jsonDumps(v: unknown, pretty = false): string {
  return JSON.stringify(v, null, pretty ? 2 : 0);
}

/**
 * Remove markdown code fences from text.
 * Handles: ```json ... ```, ```JSON ... ```, ``` ... ```
 */
function stripCodeFences(text: string): string {
  // Pattern: ```json or ```JSON or just ``` at start, ``` at end
  const fenceMatch = text.match(/^[\s\n]*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```[\s\n]*$/);
  if (fenceMatch) {
    return fenceMatch[1];
  }
  return text;
}

/**
 * Fix common JSON issues that LLMs produce:
 * - Trailing commas before } or ]
 * - Control characters in strings (unescaped newlines)
 */
function fixCommonJsonIssues(text: string): string {
  // Remove trailing commas before } or ] (with optional whitespace)
  let fixed = text.replace(/,(\s*[}\]])/g, "$1");
  return fixed;
}

export function parseJsonLoose(text: string): unknown {
  // 1) Straight parse
  try {
    return JSON.parse(text);
  } catch {
    // continue with recovery strategies
  }

  // 2) Strip markdown code fences
  let cleaned = stripCodeFences(text.trim());

  // 3) Try to parse the cleaned text directly
  try {
    return JSON.parse(cleaned);
  } catch {
    // continue
  }

  // 4) Try to extract the first JSON object/array
  const objStart = cleaned.indexOf("{");
  const objEnd = cleaned.lastIndexOf("}");
  if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
    let slice = cleaned.slice(objStart, objEnd + 1);
    try {
      return JSON.parse(slice);
    } catch {
      // 5) Try fixing common issues
      const fixed = fixCommonJsonIssues(slice);
      try {
        return JSON.parse(fixed);
      } catch {
        // keep going
      }
    }
  }

  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
    let slice = cleaned.slice(arrStart, arrEnd + 1);
    try {
      return JSON.parse(slice);
    } catch {
      const fixed = fixCommonJsonIssues(slice);
      try {
        return JSON.parse(fixed);
      } catch {
        // fallthrough
      }
    }
  }

  throw new Error("Failed to parse JSON");
}
