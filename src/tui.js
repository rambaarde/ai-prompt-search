/**
 * The interactive picker.
 *
 * Written against `node:readline` and raw ANSI rather than a TUI library,
 * because the whole appeal of this tool is `npx` with nothing behind it — a
 * dependency tree would cost more than the thing it renders.
 *
 * Two interaction decisions worth naming.
 *
 * **It is an omnibox, not a list.** A centred field with its suggestions
 * directly underneath, because that shape is already in everyone's hands —
 * address bar, Spotlight, command palette — so it needs no explaining.
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

const lastSegment = (p) => (p || "").split("/").filter(Boolean).pop() ?? "";

const when = (at) =>
  at ? new Date(at * 1000).toISOString().slice(5, 16).replace("T", " ") : "  --   ";

/**
 * Run the picker.
 *
 * @param {Array} prompts every prompt read from disk
 * @param {{query?: string, agent?: string|null}} opts
 * @returns {Promise<string|null>} the chosen prompt, or null if cancelled
 */
export function pick(prompts, { query = "", scope = null } = {}) {
  return new Promise((resolve) => {
    let q = query;
    let sel = 0;
    let rows = [];
    // Scope is toggleable mid-search: you often only learn you need the wider
    // net after the narrow one comes back empty.
    let here = scope;
    const total = () => search(prompts, { limit: Number.MAX_SAFE_INTEGER, scope: here }).matched;

    /**
     * A centred panel, not a full-screen list.
     *
     * The model is an omnibox: one search field floating in the middle of the
     * screen with its suggestions directly underneath. That shape is worth
     * copying because it is already in everyone's hands — browser address bar,
     * Spotlight, every command palette — so nobody has to be told how to use
     * it, and the eye starts where the typing happens instead of scanning a
     * wall of rows for the input line.
     */
    const BOX = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };
    const box = () => {
      const cols = process.stdout.columns || 100;
      const lines = process.stdout.rows || 24;
      const w = Math.max(46, Math.min(96, cols - 8));
      const listMax = Math.max(3, Math.min(10, lines - 10));
      return { cols, lines, w, listMax, left: Math.max(0, Math.floor((cols - w) / 2)) };
    };

    const rowsVisible = () => box().listMax;

    const refilter = () => {
      const terms = q.split(/\s+/).filter(Boolean);
      rows = search(prompts, { terms, limit: rowsVisible(), scope: here }).rows;
      if (sel > rows.length - 1) sel = Math.max(0, rows.length - 1);
    };

    /** Cut to a printable width, accounting for nothing clever — no wide chars. */
    const fit = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

    const render = () => {
      clear();
      const { cols, lines, w, left } = box();
      const inner = w - 2;
      const pad = " ".repeat(left);
      const out = (s) => process.stdout.write(`${pad}${s}\n`);

      // Vertically centred on the panel's own height, biased slightly up:
      // a box sitting dead-centre reads as lower than centre to most eyes.
      const panelHeight = rows.length + 6;
      const top = Math.max(0, Math.floor((lines - panelHeight) / 2) - 1);
      for (let i = 0; i < top; i++) process.stdout.write("\n");

      out(dim(`${BOX.tl}${BOX.h.repeat(inner)}${BOX.tr}`));

      // The search field, with the caret where the typing is.
      const caret = `${ESC}[7m ${ESC}[0m`;
      const typed = fit(q, inner - 6);
      const fieldPad = " ".repeat(Math.max(0, inner - 4 - typed.length - 1));
      out(`${dim(BOX.v)} ${bold("›")} ${typed}${caret}${fieldPad}${dim(BOX.v)}`);
      out(dim(`${BOX.v}${BOX.h.repeat(inner)}${BOX.v}`));

      if (rows.length === 0) {
        const msg = q
          ? (here ? "nothing here — ^a searches every project" : "no prompt matches")
          : "type to search";
        out(`${dim(BOX.v)} ${dim(fit(msg, inner - 2).padEnd(inner - 2))} ${dim(BOX.v)}`);
      }

      // Suggestions run top-down under the field, newest first — the omnibox
      // order, and the opposite of the old bottom-anchored list.
      rows.forEach((r, i) => {
        const meta = `${when(r.at)} ${r.agent}`;
        const times = r.count > 1 ? ` x${r.count}` : "";
        const room = inner - meta.length - times.length - 5;
        const body = fit(r.text.replace(/\n/g, " ⏎ "), Math.max(10, room));
        const line = ` ${body}${times}`;
        const tail = `${meta} `;
        const gap = " ".repeat(Math.max(1, inner - 2 - line.length - tail.length));

        if (i === sel) {
          const full = `${line}${gap}${tail}`;
          out(`${dim(BOX.v)}${invert(fit(full, inner).padEnd(inner))}${dim(BOX.v)}`);
        } else {
          const painted = `${HUE[r.agent] ?? ""}${body}${ESC}[0m${dim(times)}`;
          out(`${dim(BOX.v)} ${painted}${gap}${dim(tail)}${dim(BOX.v)}`);
        }
      });

      out(dim(`${BOX.bl}${BOX.h.repeat(inner)}${BOX.br}`));

      // Hints sit outside the panel: inside, they compete with the results for
      // the one line the eye is actually scanning.
      const where = here ? `${lastSegment(here)} only` : "all projects";
      const hint = rows.length
        ? `${rows.length} of ${total()} · ${where} · ↑↓ ⏎ copy · ^a scope · esc`
        : `${total()} prompts · ${where} · ^a widen · esc quit`;
      out(dim(fit(hint, w).padStart(Math.floor((w + hint.length) / 2))));
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
      if (key.name === "up" || (key.ctrl && key.name === "p")) sel = Math.max(sel - 1, 0);
      else if (key.name === "down" || (key.ctrl && key.name === "n")) sel = Math.min(sel + 1, rows.length - 1);
      else if (key.ctrl && key.name === "a") { here = here ? null : scope; sel = 0; refilter(); }
      else if (key.name === "backspace") { q = q.slice(0, -1); sel = 0; refilter(); }
      else if (key.ctrl && key.name === "u") { q = ""; sel = 0; refilter(); }
      else if (ch && !key.ctrl && !key.meta && ch >= " ") { q += ch; sel = 0; refilter(); }
      else return;
      render();
    });
  });
}
