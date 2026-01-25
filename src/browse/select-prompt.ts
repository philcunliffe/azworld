/**
 * Arrow-key based selection prompt for terminal UI
 */

// ANSI codes
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const MOVE_UP = (n: number) => `\x1b[${n}A`;
const MOVE_TO_COL = (n: number) => `\x1b[${n}G`;

export type SelectOption<T = string> = {
  label: string;
  value: T;
  hint?: string;
};

export type SelectPromptOptions<T> = {
  message?: string;
  options: SelectOption<T>[];
  useColors?: boolean;
  defaultIndex?: number;
};

/**
 * Display an arrow-key selection prompt and return the selected value.
 * Uses raw mode to capture arrow keys without requiring enter.
 */
export async function selectPrompt<T = string>(
  opts: SelectPromptOptions<T>
): Promise<T | null> {
  const { options, useColors = true, defaultIndex = 0, message } = opts;

  if (options.length === 0) {
    return null;
  }

  const stdin = process.stdin;
  const stdout = process.stdout;

  // Check if we can use raw mode
  if (!stdin.isTTY || !stdin.setRawMode) {
    // Fallback to simple prompt
    return fallbackPrompt(opts);
  }

  let selectedIndex = Math.max(0, Math.min(defaultIndex, options.length - 1));
  let result: T | null = null;
  let cancelled = false;

  const render = () => {
    // Move cursor to start and clear
    stdout.write(MOVE_TO_COL(1));

    const lines: string[] = [];

    if (message) {
      lines.push(useColors ? `${CYAN}${message}${RESET}` : message);
    }

    for (let i = 0; i < options.length; i++) {
      const opt = options[i];
      const isSelected = i === selectedIndex;
      const marker = isSelected ? (useColors ? `${GREEN}❯${RESET}` : ">") : " ";
      const label = isSelected && useColors ? `${BOLD}${opt.label}${RESET}` : opt.label;
      const hint = opt.hint ? (useColors ? ` ${DIM}${opt.hint}${RESET}` : ` (${opt.hint})`) : "";
      lines.push(`${marker} ${label}${hint}`);
    }

    lines.push("");
    lines.push(useColors
      ? `${DIM}↑/↓ navigate • enter select • esc cancel${RESET}`
      : "(up/down to navigate, enter to select, esc to cancel)"
    );

    stdout.write(lines.join("\n"));
  };

  const clearDisplay = () => {
    const totalLines = options.length + (message ? 1 : 0) + 2; // +2 for blank line and help text
    stdout.write(MOVE_UP(totalLines - 1));
    for (let i = 0; i < totalLines; i++) {
      stdout.write(CLEAR_LINE + "\n");
    }
    stdout.write(MOVE_UP(totalLines));
  };

  return new Promise((resolve) => {
    // Save terminal state
    const wasRaw = stdin.isRaw;

    stdin.setRawMode(true);
    stdin.resume();
    stdout.write(HIDE_CURSOR);

    render();

    const handleKey = (key: Buffer) => {
      const str = key.toString();

      // Escape sequences for arrow keys
      if (str === "\x1b[A" || str === "k") {
        // Up arrow or k
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        clearDisplay();
        render();
      } else if (str === "\x1b[B" || str === "j") {
        // Down arrow or j
        selectedIndex = (selectedIndex + 1) % options.length;
        clearDisplay();
        render();
      } else if (str === "\r" || str === "\n") {
        // Enter
        result = options[selectedIndex].value;
        cleanup();
      } else if (str === "\x1b" || str === "\x03") {
        // Escape or Ctrl+C
        cancelled = true;
        cleanup();
      } else if (str === "y" || str === "Y") {
        // Quick select first option (typically "yes/create")
        result = options[0].value;
        cleanup();
      } else if (str === "n" || str === "N") {
        // Quick select cancel (find option with "cancel" in label)
        const cancelIdx = options.findIndex(o =>
          o.label.toLowerCase().includes("cancel") ||
          o.value === "cancel" ||
          o.value === "n"
        );
        if (cancelIdx >= 0) {
          result = options[cancelIdx].value;
        } else {
          cancelled = true;
        }
        cleanup();
      }
    };

    const cleanup = () => {
      stdin.removeListener("data", handleKey);
      stdin.setRawMode(wasRaw);
      stdout.write(SHOW_CURSOR);
      clearDisplay();

      // Show what was selected
      if (cancelled) {
        stdout.write(useColors ? `${DIM}(Cancelled)${RESET}\n` : "(Cancelled)\n");
        resolve(null);
      } else if (result !== null) {
        const selectedOpt = options.find(o => o.value === result);
        stdout.write(useColors
          ? `${GREEN}✓${RESET} ${selectedOpt?.label || String(result)}\n`
          : `> ${selectedOpt?.label || String(result)}\n`
        );
        resolve(result);
      } else {
        resolve(null);
      }
    };

    stdin.on("data", handleKey);
  });
}

/**
 * Fallback prompt for non-TTY environments
 */
async function fallbackPrompt<T>(opts: SelectPromptOptions<T>): Promise<T | null> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const { options, message } = opts;

  console.log(message || "Select an option:");
  options.forEach((opt, i) => {
    console.log(`  ${i + 1}. ${opt.label}${opt.hint ? ` (${opt.hint})` : ""}`);
  });

  return new Promise((resolve) => {
    rl.question("Enter number (or 'c' to cancel): ", (answer) => {
      rl.close();

      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "c" || trimmed === "cancel") {
        resolve(null);
        return;
      }

      const num = parseInt(trimmed, 10);
      if (num >= 1 && num <= options.length) {
        resolve(options[num - 1].value);
      } else {
        // Default to first option
        resolve(options[0].value);
      }
    });
  });
}
