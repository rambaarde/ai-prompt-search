/**
 * The interactive picker.
 *
 * Written against `node:readline` and raw ANSI rather than a TUI library,
 * because the whole appeal of this tool is `npx` with nothing behind it — a
 * dependency tree would cost more than the thing it renders.
 *
 * Three interaction decisions worth naming.
 *
 * **It is an omnibox, not a list.** A small field floating in the middle of the
 * screen with its suggestions directly underneath, because that shape is
 * already in everyone's hands — address bar, Spotlight, command palette — so it
 * needs no explaining, and the eye starts where the typing happens instead of
 * scanning a wall of rows for the input line.
 *
 * **A surface, not a frame.** Box-drawing characters make a terminal panel look
 * like a form. A filled background with a shadow beneath it reads as something
 * floating *over* the session, which is what this is: a thing you open, take one
 * line from, and dismiss. It also frees the two columns a border would eat.
 *
 * **Filtering is live and local.** Every keystroke re-filters an array already
 * in memory. There is no index to warm and nothing to wait for, which is what
 * makes typing three letters and hitting Enter faster than pressing up-arrow
 * even twice.
 */
import { emitKeypressEvents } from "node:readline";
import { search } from "./search.js";

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const alt = (on) => process.stdout.write(`${ESC}[?1049${on ? "h" : "l"}`);
const cursor = (on) => process.stdout.write(`${ESC}[?25${on ? "h" : "l"}`);
const clear = () => process.stdout.write(`${ESC}[2J${ESC}[H`);

const bg = (n) => `${ESC}[48;5;${n}m`;
const fg = (n) => `${ESC}[38;5;${n}m`;

/**
 * The palette, as named steps rather than numbers scattered through the render.
 *
 * 256-colour rather than the 16 theme colours on purpose: the panel has to look
 * deliberately like a surface laid over the session, and a theme colour would
 * make it whatever the user's scheme decided — sometimes indistinguishable from
 * the terminal behind it, which is the one thing a floating panel must not be.
 */
const C = {
  surface: 235,
  selected: 238,
  shadow: 233,
  rule: 238,
  text: 252,
  bright: 255,
  muted: 245,
  faint: 240,
  caret: 250,
};

/** Each agent gets a hue, carried by the dot at the head of its rows. */
const HUE = { claude: 175, codex: 110, opencode: 179 };

/**
 * Printable width, ignoring the colour codes woven through a line.
 *
 * Everything below builds strings that switch colour mid-line and never emit a
 * full reset — a reset would drop the panel background and punch a hole in the
 * surface. So padding cannot use `String.length`, and this is the one helper
 * that makes the rest of the layout arithmetic honest.
 */
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

const lastSegment = (p) => (p || "").split("/").filter(Boolean).pop() ?? "";

const when = (at) =>
  at ? new Date(at * 1000).toISOString().slice(5, 16).replace("T", " ") : "  --   ";

/**
 * Run the picker.
 *
 * @param {Array} prompts every prompt read from disk
 * @param {{query?: string, scope?: string|null}} opts
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
     * Panel geometry.
     *
     * Narrow and short by design. A browser's suggestion list shows five or six
     * results at about half the window width, and that restraint is the point:
     * the answer is nearly always in the first few rows, so a taller panel only
     * buys more to read past. 68 columns also keeps a prompt readable on the
     * split-pane terminals people actually run an agent in.
     */
    const box = () => {
      const cols = process.stdout.columns || 100;
      const lines = process.stdout.rows || 24;
      const w = Math.max(44, Math.min(68, cols - 6));
      const listMax = Math.max(3, Math.min(8, lines - 8));
      return { cols, lines, w, listMax, left: Math.max(0, Math.floor((cols - w) / 2)) };
    };

    const refilter = () => {
      const terms = q.split(/\s+/).filter(Boolean);
      rows = search(prompts, { terms, limit: box().listMax, scope: here }).rows;
      if (sel > rows.length - 1) sel = Math.max(0, rows.length - 1);
    };

    /** Cut to a printable width. No wide-character handling — none is needed. */
    const fit = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

    const render = () => {
      clear();
      const { lines, w, left } = box();
      const pad = " ".repeat(left);
      const body = w - 4; // two columns of breathing room on each side

      // The shadow is offset down and right, as a real one is. It is what makes
      // the panel read as lying over the session rather than cut into it.
      const shade = `${bg(C.shadow)}  ${RESET}`;
      let first = true;
      const out = (content, surface = C.surface) => {
        const fill = " ".repeat(Math.max(0, w - visible(content)));
        process.stdout.write(`${pad}${bg(surface)}${fg(C.text)}${content}${fill}${RESET}`);
        process.stdout.write(first ? "\n" : `${shade}\n`);
        first = false;
      };

      // Biased a little above centre: a panel sitting dead-centre reads as low.
      const height = (rows.length || 1) + 6;
      const top = Math.max(0, Math.floor((lines - height) / 2) - 1);
      for (let i = 0; i < top; i++) process.stdout.write("\n");

      out("");

      // The field. A placeholder rather than an empty line, because an empty
      // field with a caret in it does not say what it searches.
      const caret = `${bg(C.caret)} ${bg(C.surface)}`;
      const typed = q
        ? `${fg(C.bright)}${fit(q, body - 4)}`
        : `${fg(C.faint)}Search my prompts…`;
      out(`  ${fg(C.muted)}⌕ ${typed}${q ? caret : ""}`);

      // A rule instead of a border: it separates what you type from what you
      // get, which is the only division in here that carries meaning.
      out(`  ${fg(C.rule)}${"─".repeat(body)}`);

      if (rows.length === 0) {
        const msg = q
          ? here
            ? "nothing in this project — ^a searches every project"
            : "no prompt matches"
          : "type to search";
        out(`  ${fg(C.faint)}${fit(msg, body)}`);
      }

      rows.forEach((r, i) => {
        const chosen = i === sel;
        const surface = chosen ? C.selected : C.surface;
        const dot = `${fg(HUE[r.agent] ?? C.muted)}●`;

        // The right-hand label mirrors a browser suggestion: metadata normally,
        // and on the row you have landed on, the action Enter will take.
        const tail = chosen ? "⏎ copy" : `${r.agent} · ${when(r.at)}`;
        const times = r.count > 1 ? ` ×${r.count}` : "";
        const room = body - 2 - tail.length - times.length - 2;
        const text = fit(r.text.replace(/\n/g, " ⏎ "), Math.max(12, room));

        const head = `  ${dot} ${fg(chosen ? C.bright : C.text)}${text}${fg(C.faint)}${times}`;
        const gap = " ".repeat(Math.max(1, w - 2 - visible(head) - tail.length));
        out(`${head}${gap}${fg(chosen ? C.muted : C.faint)}${tail}`, surface);
      });

      out("");

      // The footer earns its line by answering the two questions the panel
      // cannot: how much you are not seeing, and which project you are inside.
      const where = here ? `${lastSegment(here)} only` : "all projects";
      const shown = rows.length ? `${rows.length} of ${total()}` : `${total()} prompts`;
      const keys = here ? "^a all projects" : "^a this project";
      out(`  ${fg(C.faint)}${fit(`${shown} · ${where} · ↑↓ · ${keys} · esc`, body)}`);
      out("");
      // Close the shadow off under the panel, indented so it starts where the
      // offset does.
      process.stdout.write(`${pad}  ${bg(C.shadow)}${" ".repeat(w)}${RESET}\n`);
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
