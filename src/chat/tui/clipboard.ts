import { spawn } from "child_process";

/**
 * Detect the platform and return the appropriate clipboard command
 */
function getClipboardCommand(): { cmd: string; args: string[] } | null {
  const platform = process.platform;

  switch (platform) {
    case "darwin":
      // macOS
      return { cmd: "pbcopy", args: [] };
    case "linux":
      // Try xclip first, then xsel
      // Check if running in WSL
      if (process.env.WSL_DISTRO_NAME) {
        return { cmd: "clip.exe", args: [] };
      }
      // Prefer xclip, fallback to xsel
      return { cmd: "xclip", args: ["-selection", "clipboard"] };
    case "win32":
      // Windows
      return { cmd: "clip", args: [] };
    default:
      return null;
  }
}

/**
 * Copy text to system clipboard
 * Returns true on success, false on failure
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const clipCmd = getClipboardCommand();

  if (!clipCmd) {
    console.error("Clipboard not supported on this platform");
    return false;
  }

  return new Promise((resolve) => {
    try {
      const proc = spawn(clipCmd.cmd, clipCmd.args, {
        stdio: ["pipe", "ignore", "ignore"],
      });

      proc.stdin?.write(text);
      proc.stdin?.end();

      proc.on("close", (code) => {
        resolve(code === 0);
      });

      proc.on("error", (err) => {
        // If xclip fails, try xsel on Linux
        if (clipCmd.cmd === "xclip" && process.platform === "linux") {
          const xselProc = spawn("xsel", ["--clipboard", "--input"], {
            stdio: ["pipe", "ignore", "ignore"],
          });
          xselProc.stdin?.write(text);
          xselProc.stdin?.end();
          xselProc.on("close", (c) => resolve(c === 0));
          xselProc.on("error", () => resolve(false));
        } else {
          resolve(false);
        }
      });
    } catch {
      resolve(false);
    }
  });
}

/**
 * Read text from system clipboard
 * Returns the clipboard content or null on failure
 */
export async function readFromClipboard(): Promise<string | null> {
  const platform = process.platform;

  let cmd: string;
  let args: string[];

  switch (platform) {
    case "darwin":
      cmd = "pbpaste";
      args = [];
      break;
    case "linux":
      if (process.env.WSL_DISTRO_NAME) {
        cmd = "powershell.exe";
        args = ["-command", "Get-Clipboard"];
      } else {
        cmd = "xclip";
        args = ["-selection", "clipboard", "-o"];
      }
      break;
    case "win32":
      cmd = "powershell";
      args = ["-command", "Get-Clipboard"];
      break;
    default:
      return null;
  }

  return new Promise((resolve) => {
    try {
      const proc = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "ignore"],
      });

      let output = "";
      proc.stdout?.on("data", (data) => {
        output += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          resolve(null);
        }
      });

      proc.on("error", (err) => {
        // Try xsel as fallback on Linux
        if (cmd === "xclip" && platform === "linux") {
          const xselProc = spawn("xsel", ["--clipboard", "--output"], {
            stdio: ["ignore", "pipe", "ignore"],
          });
          let xselOutput = "";
          xselProc.stdout?.on("data", (data) => {
            xselOutput += data.toString();
          });
          xselProc.on("close", (c) => {
            resolve(c === 0 ? xselOutput : null);
          });
          xselProc.on("error", () => resolve(null));
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}
