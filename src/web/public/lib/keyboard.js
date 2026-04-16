/**
 * keyboard.js - Global keyboard shortcut handler for the azworld web app.
 *
 * Shortcuts:
 *   Cmd/Ctrl+K          - Search
 *   Cmd/Ctrl+D          - Chat (director mode)
 *   Cmd/Ctrl+Shift+P    - Command palette
 *   [                    - Toggle sidebar (when not in an input)
 *   Escape              - Close overlays
 */

const shortcuts = {};

/**
 * Register a named shortcut handler.
 * @param {string} key - Shortcut name (e.g. "search", "escape", "toggle-sidebar")
 * @param {() => void} handler
 */
export function registerShortcut(key, handler) {
  shortcuts[key] = handler;
}

/**
 * Attach the global keydown listener. Call once at app startup.
 */
export function initKeyboard() {
  document.addEventListener("keydown", (e) => {
    // Cmd/Ctrl+Shift+P = command palette (check before Cmd+P)
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "p") {
      e.preventDefault();
      shortcuts["command-palette"]?.();
      return;
    }

    // Cmd/Ctrl+K = search
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      shortcuts["search"]?.();
      return;
    }

    // Cmd/Ctrl+D = chat director
    if ((e.metaKey || e.ctrlKey) && e.key === "d") {
      e.preventDefault();
      shortcuts["chat-director"]?.();
      return;
    }

    // [ = toggle sidebar (only when not in an input field)
    if (e.key === "[" && !isInputFocused()) {
      e.preventDefault();
      shortcuts["toggle-sidebar"]?.();
      return;
    }

    // Escape = close overlays
    if (e.key === "Escape") {
      shortcuts["escape"]?.();
      return;
    }
  });
}

/**
 * Check whether the currently focused element is a text input,
 * textarea, select, or contentEditable field.
 * @returns {boolean}
 */
function isInputFocused() {
  const tag = document.activeElement?.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    document.activeElement?.isContentEditable
  );
}
