/**
 * The interactive picker.
 *
 * Written against `node:readline` and raw ANSI rather than a TUI library,
 * because the whole appeal of this tool is `npx` with nothing behind it — a
 * dependency tree would cost more than the thing it renders.
 *
 * Two interaction decisions worth naming.
 *
 * **The list grows upward from the prompt.** The newest and best match sits at
 * the bottom, directly above the input line, where the cursor already is. A
 * conventional top-down list puts the most likely answer furthest from the eye
 * and makes every selection start with a journey.
 *
 * **Filtering is live and local.** Every keystroke re-filters an array already
 * in memory. There is no index to warm and nothing to wait for, which is what
 * makes typing three letters and hitting Enter faster than pressing up-arrow
 * even twice.
 */
import { emitKeypressEvents } from "node:readline";
import { search } from "./search.js";

const ESC = "\x1b";
const alt = (on) => process.stdout.write(`${ESC}[?1049${on ? "h" : "l"}`);
const cursor = (on) => process.stdout.write(`${ESC}[?25${on ? "h" : "l"}`);
const clear = () => process.stdout.write(`${ESC}[2J${ESC}[H`);
const dim = (s) => `${ESC}[2m${s}${ESC}[0m`;
const bold = (s) => `${ESC}[1m${s}${ESC}[0m`;
const invert = (s) => `${ESC}[7m${s}${ESC}[0m`;

const HUE = { claude: `${ESC}[35m`, codex: `${ESC}[36m`, opencode: `${ESC}[33m` };

const when = (at) =>
  at ? new Date(at * 1000).toISOString().slice(5, 16).replace("T", " ") : "  --   ";

/**
 * Run the picker.
 *
 * @param {Array} prompts every prompt read from disk
 * @param {{query?: string, agent?: string|null}} opts
 * @returns {Promise<string|null>} the chosen prompt, or null if cancelled
 */
export function pick(prompts, { query = "", agent = null } = {}) {
  return new Promise((resolve) => {
    let q = query;
    let sel = 0;
    let rows = [];

    const rowsVisible = () => Math.max(3, (process.stdout.rows || 24) - 4);

    const refilter = () => {
      const terms = q.split(/\s+/).filter(Boolean);
      rows = search(prompts, { terms, limit: rowsVisible() }).rows;
      // Selection counts from the bottom, where the newest row is.
      if (sel > rows.length - 1) sel = Math.max(0, rows.length - 1);
    };

    const render = () => {
      clear();
      const width = process.stdout.columns || 100;
      const visible = [...rows].reverse();           // newest last, nearest the input
      const selIndex = visible.length - 1 - sel;

      const pad = rowsVisible() - visible.length;
      for (let i = 0; i < pad; i++) process.stdout.write("\n");

      visible.forEach((r, i) => {
        const head = `${when(r.at)} ${r.agent.padEnd(8)}`;
        const times = r.count > 1 ? ` x${r.count}` : "";
        const room = Math.max(20, width - head.length - times.length - 4);
        const body = r.text.length > room ? `${r.text.slice(0, room)}…` : r.text;
        const line = ` ${head} ${body}${times}`;
        process.stdout.write(
          i === selIndex
            ? `${invert(line.padEnd(width - 1))}\n`
            : `${dim(when(r.at))} ${HUE[r.agent] ?? ""}${r.agent.padEnd(8)}${ESC}[0m ${body}${dim(times)}\n`,
        );
      });

      const count = rows.length === 0 ? "no match" : `${rows.length} shown`;
      process.stdout.write(dim(`\n  ${count}  ·  ↑↓ move  ·  ⏎ copy  ·  esc quit\n`));
      process.stdout.write(`${bold("  search")} ${q}${ESC}[7m ${ESC}[0m`);
    };

    const finish = (value) => {
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      cursor(true);
      alt(false);
      resolve(value);
    };

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    alt(true);
    cursor(false);
    refilter();
    render();

    process.stdin.on("keypress", (ch, key) => {
      if (!key) return;
      if (key.name === "escape" || (key.ctrl && (key.name === "c" || key.name === "d"))) {
        return finish(null);
      }
      if (key.name === "return") {
        return finish(rows[sel]?.text ?? null);
      }
      if (key.name === "up" || (key.ctrl && key.name === "p")) sel = Math.min(sel + 1, rows.length - 1);
      else if (key.name === "down" || (key.ctrl && key.name === "n")) sel = Math.max(sel - 1, 0);
      else if (key.name === "backspace") { q = q.slice(0, -1); sel = 0; refilter(); }
      else if (key.ctrl && key.name === "u") { q = ""; sel = 0; refilter(); }
      else if (ch && !key.ctrl && !key.meta && ch >= " ") { q += ch; sel = 0; refilter(); }
      else return;
      render();
    });
  });
}
