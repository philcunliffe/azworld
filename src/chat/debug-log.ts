import { mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";

let logFile: string | undefined;
let debugEnabled = false;

/**
 * Initialize debug logging for this session.
 * Creates a timestamped log file in the logs directory.
 */
export function initDebugLog(enabled: boolean, logsDir = "./logs"): string | undefined {
  debugEnabled = enabled;
  if (!enabled) {
    logFile = undefined;
    return undefined;
  }

  // Create logs directory if needed
  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    // ignore if exists
  }

  // Generate timestamped filename
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  logFile = join(logsDir, `session-${ts}.log`);

  // Write header
  const header = `=== azchat debug session started ${new Date().toISOString()} ===\n\n`;
  appendFileSync(logFile, header);

  return logFile;
}

/**
 * Set debug mode on/off (can toggle mid-session).
 */
export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
}

/**
 * Check if debug mode is enabled.
 */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/**
 * Get the current log file path (or undefined if not logging).
 */
export function getLogFile(): string | undefined {
  return debugEnabled ? logFile : undefined;
}

/**
 * Write a debug message to log file (if debug enabled).
 */
export function debugLog(message: string): void {
  if (!debugEnabled || !logFile) return;

  try {
    appendFileSync(logFile, message + "\n");
  } catch {
    // ignore write errors
  }
}

/**
 * Write to log file only (not console). Useful for verbose data.
 */
export function debugLogFile(message: string): void {
  if (!debugEnabled || !logFile) return;

  try {
    appendFileSync(logFile, message + "\n");
  } catch {
    // ignore write errors
  }
}

/**
 * Log a tool call with full arguments to file.
 */
export function debugToolCall(name: string, args: Record<string, any>): void {
  if (!debugEnabled || !logFile) return;

  const argsStr = JSON.stringify(args, null, 2);
  try {
    appendFileSync(logFile, `  [tool] ${name}(${argsStr})\n`);
  } catch {
    // ignore
  }
}

/**
 * Log a tool result to file.
 */
export function debugToolResult(name: string, result: any, elapsedMs: number): void {
  if (!debugEnabled || !logFile) return;

  const resultStr = JSON.stringify(result, null, 2);
  try {
    appendFileSync(logFile, `  [done] ${name} (${elapsedMs}ms)\n`);
    appendFileSync(logFile, `  [result] ${resultStr}\n`);
  } catch {
    // ignore
  }
}

/**
 * Log token usage to file.
 */
export function debugTokens(usage: { totalTokens: number; promptTokens: number; completionTokens: number }): void {
  if (!debugEnabled || !logFile) return;

  const msg = `  [tokens] +${usage.totalTokens} (${usage.promptTokens}/${usage.completionTokens})`;
  try {
    appendFileSync(logFile, msg + "\n");
  } catch {
    // ignore
  }
}

/**
 * Log LLM request/response details (file only for verbose data).
 */
export function debugLLMCall(label: string, data: any): void {
  if (!debugEnabled || !logFile) return;

  try {
    const dataStr = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    appendFileSync(logFile, `[${label}] ${dataStr}\n`);
  } catch {
    // ignore
  }
}
