/**
 * The clipboard, such as it is.
 *
 * There is no cross-platform clipboard in Node, and the packages that offer one
 * are a dependency tree in exchange for spawning the same three binaries. So we
 * spawn them.
 *
 * Lives here rather than in the CLI because the wrapper needs it too: copying
 * the draft you just typed happens inside a running agent, nowhere near the
 * argument parser.
 */
import { spawn } from "node:child_process";
import { platform } from "node:process";

/**
 * Put text on the clipboard.
 *
 * Resolves false when the platform's clipboard tool is missing — Linux without
 * xclip, mainly. That is a normal state on a server, not an error worth
 * throwing: the caller can print the text instead and lose nothing.
 *
 * @returns {Promise<boolean>} whether it was copied
 */
export function toClipboard(text) {
  const cmd = platform === "darwin" ? "pbcopy" : platform === "win32" ? "clip" : "xclip";
  const args = platform === "linux" ? ["-selection", "clipboard"] : [];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  });
}
