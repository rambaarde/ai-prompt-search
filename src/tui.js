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
import { basename } from "node:path";
import { search } from "./search.js";

const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const alt = (out, on) => out.write(`${ESC}[?1049${on ? "h" : "l"}`);
const cursor = (out, on) => out.write(`${ESC}[?25${on ? "h" : "l"}`);
const clear = (out) => out.write(`${ESC}[2J${ESC}[H`);

/**
 * Colour, entirely from the terminal's own palette.
 *
 * The panel used to paint a filled surface, and then had to work out what
 * colour that surface should be — which meant asking the terminal for its
 * background and deriving a scheme from it. All of that machinery existed to
 * solve a problem the design created.
 *
 * A transparent panel with a border does not have the problem. The interior is
 * whatever is behind it, the border and text are the terminal's own colours,
 * and there is nothing left that can clash with a theme. It is also how every
 * picker in a terminal already looks — Telescope, fzf, lazygit — so it reads as
 * native rather than as something pasted on top.
 */
const DIM = `${ESC}[2m`;
const ACCENT = `${ESC}[34m`;

/** Each agent gets a hue, taken from the palette your scheme already defines. */
const HUE = { claude: `${ESC}[35m`, codex: `${ESC}[36m`, opencode: `${ESC}[33m` };

/**
 * Printable width, ignoring the colour codes woven through a line.
 *
 * Everything below builds strings that switch colour mid-line and never emit a
 * full reset — a reset would drop the panel background and punch a hole in the
 * surface. So padding cannot use `String.length`, and this is the one helper
 * that makes the rest of the layout arithmetic honest.
 */
const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

const lastSegment = (p) => (p ? basename(p) : "");

const when = (at) =>
  at ? new Date(at * 1000).toISOString().slice(5, 16).replace("T", " ") : "  --   ";

/**
 * Run the picker.
 *
 * `out` is the terminal to draw on, and it is a parameter for one reason: a
 * shell or tmux binding has to capture the chosen prompt from stdout, which
 * means stdout is a pipe and cannot also carry the interface. Handing the
 * picker an explicit handle on /dev/tty separates the two — the panel goes to
 * the screen, the answer goes to whoever asked.
 *
 * @param {Array} prompts every prompt read from disk
 * @param {{query?: string, scope?: string|null, screen?: NodeJS.WriteStream}} opts
 * @returns {Promise<string|null>} the chosen prompt, or null if cancelled
 */
export function pick(prompts, {
  query = "", scope = null, session = null, screen = process.stdout, keep = false,
} = {}) {
  return new Promise((resolve) => {
    let q = query;
    let sel = 0;
    let rows = [];

    /**
     * How wide to look, narrowest first.
     *
     * Three levels rather than two, because "this project" is not narrow enough
     * when two panes are open on the same repository — that is one project and
     * two conversations, and the prompts you want back are the ones from the
     * pane you are actually in. The session level only exists when something
     * knows which session this is, which is the wrapper.
     *
     * Widening is one key away because you often only discover you need the
     * bigger net after the small one comes back empty.
     */
    const LEVELS = [
      ...(session ? [{ key: "session", session, scope }] : []),
      ...(scope ? [{ key: "project", session: null, scope }] : []),
      { key: "all", session: null, scope: null },
    ];
    let level = 0;
    const at = () => LEVELS[level];

    const total = () =>
      search(prompts, { limit: Number.MAX_SAFE_INTEGER, scope: at().scope, session: at().session }).matched;

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
      const cols = screen.columns || 100;
      const lines = screen.rows || 24;
      const w = Math.max(44, Math.min(68, cols - 6));
      const listMax = Math.max(3, Math.min(8, lines - 8));
      return { cols, lines, w, listMax, left: Math.max(0, Math.floor((cols - w) / 2)) };
    };

    // How many matched, as opposed to how many fit on screen. The panel shows
    // eight rows; saying "8" while a search narrowed twenty thousand prompts to
    // forty tells you nothing about whether the search is working.
    let matched = 0;

    const refilter = () => {
      const terms = q.split(/\s+/).filter(Boolean);
      const found = search(prompts, { terms, limit: box().listMax, scope: at().scope, session: at().session });
      rows = found.rows;
      matched = found.matched;
      if (sel > rows.length - 1) sel = Math.max(0, rows.length - 1);
    };

    /** Cut to a printable width. No wide-character handling — none is needed. */
    const fit = (s, n) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

    const render = () => {
      clear(screen);
      const { lines, w, left } = box();
      const pad = " ".repeat(left);
      const inner = w - 2;
      const body = inner - 2; // one column of breathing room inside each edge
      const out = (s) => screen.write(`${pad}${s}\n`);

      // Biased a little above centre: a panel sitting dead-centre reads as low.
      const height = (rows.length || 1) + 4;
      const top = Math.max(0, Math.floor((lines - height) / 2) - 1);
      for (let i = 0; i < top; i++) screen.write("\n");

      // A title set into the top edge, the way every picker in a terminal does
      // it. It also removes the need for a placeholder to explain the field.
      const title = ` prompts `;
      const before = Math.max(1, Math.floor((inner - title.length) / 2));
      const after = Math.max(1, inner - title.length - before);
      out(`${DIM}╭${"─".repeat(before)}${RESET}${ACCENT}${title}${RESET}${DIM}${"─".repeat(after)}╮${RESET}`);

      // The field. `❯` rather than a magnifying glass: it is a prompt, and the
      // count belongs on this line because it answers "is my search working".
      const shown = `${matched}/${total()}`;
      const typed = q || "";
      const room = body - 2 - shown.length - 2;
      const caret = `${ESC}[7m ${RESET}`;
      const field = ` ${ACCENT}❯${RESET} ${fit(typed, Math.max(8, room))}${caret}`;
      out(`${DIM}│${RESET}${field}${" ".repeat(Math.max(1, inner - visible(field) - shown.length - 1))}${DIM}${shown} │${RESET}`);
      out(`${DIM}├${"─".repeat(inner)}┤${RESET}`);

      if (rows.length === 0) {
        const msg = q
          ? level < LEVELS.length - 1
            ? "nothing here — ^a widens the search"
            : "no prompt matches"
          : "type to search";
        out(`${DIM}│${RESET} ${DIM}${fit(msg, body).padEnd(body)}${RESET} ${DIM}│${RESET}`);
      }

      rows.forEach((r, i) => {
        const chosen = i === sel;
        const dot = `${HUE[r.agent] ?? DIM}●${RESET}`;
        const meta = `${r.agent} · ${when(r.at)}`;
        const times = r.count > 1 ? ` ×${r.count}` : "";
        const room = body - 3 - meta.length - times.length - 2;
        const text = fit(r.text.replace(/\n/g, " ⏎ "), Math.max(12, room));

        if (chosen) {
          // The selected row reverses the terminal's own colours rather than
          // painting one. Whatever your scheme is, its foreground on its
          // background is by definition readable — no palette to get wrong,
          // on any theme, including ones nobody here has seen.
          //
          // The dot is kept, uncoloured. Dropping it shifted the text two
          // columns left, so the row you were on was the one that did not line
          // up with the rest — the opposite of what a selection should do.
          const line = ` ● ${text}${times}`;
          const gap = " ".repeat(Math.max(1, inner - line.length - meta.length - 1));
          out(`${DIM}│${RESET}${ESC}[7m${line}${gap}${meta} ${RESET}${DIM}│${RESET}`);
        } else {
          const line = ` ${dot} ${text}${DIM}${times}${RESET}`;
          const gap = " ".repeat(Math.max(1, inner - visible(line) - meta.length - 1));
          out(`${DIM}│${RESET}${line}${gap}${DIM}${meta} │${RESET}`);
        }
      });

      // The state that does not fit anywhere else goes into the bottom edge,
      // which costs no row of its own: which project, and the way out of it.
      const where = {
        session: "this session",
        project: `${lastSegment(scope)} only`,
        all: "all projects",
      }[at().key];
      const label = ` ${where} · ^a · esc `;
      const lead = Math.max(1, inner - label.length - 2);
      out(`${DIM}╰${"─".repeat(2)}${label}${"─".repeat(lead)}╯${RESET}`);
    };

    /**
     * Leave the terminal, and the process, as they were found.
     *
     * `keep` matters when the picker is opened more than once in one process —
     * which is exactly what the wrapper does, every time you press the hotkey.
     * Without removing this listener, the second run would have two, the third
     * three, and every keystroke would be handled once per past invocation. It
     * also leaves stdin alive for the caller, who still needs the keyboard.
     */
    const finish = (value) => {
      process.stdin.off("keypress", onKeypress);
      if (!keep) {
        process.stdin.setRawMode?.(false);
        process.stdin.pause();
      }
      cursor(screen, true);
      alt(screen, false);
      resolve(value);
    };

    const onKeypress = (ch, key) => {
      if (!key) return;
      if (key.name === "escape" || (key.ctrl && (key.name === "c" || key.name === "d"))) {
        return finish(null);
      }
      if (key.name === "return") {
        return finish(rows[sel]?.text ?? null);
      }
      if (key.name === "up" || (key.ctrl && key.name === "p")) sel = Math.max(sel - 1, 0);
      else if (key.name === "down" || (key.ctrl && key.name === "n")) sel = Math.min(sel + 1, rows.length - 1);
      else if (key.ctrl && key.name === "a") {
        level = (level + 1) % LEVELS.length;
        sel = 0;
        refilter();
      }
      else if (key.name === "backspace") { q = q.slice(0, -1); sel = 0; refilter(); }
      else if (key.ctrl && key.name === "u") { q = ""; sel = 0; refilter(); }
      else if (ch && !key.ctrl && !key.meta && ch >= " ") { q += ch; sel = 0; refilter(); }
      else return;
      render();
    };

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    alt(screen, true);
    cursor(screen, false);
    refilter();
    render();
    process.stdin.on("keypress", onKeypress);
  });
}
