/**
 * Running an agent with a hotkey attached.
 *
 * The problem this solves is not search — search already worked. It is that
 * while an agent is running, it holds the keyboard in raw mode, so nothing
 * outside it can see a keypress. A hotkey that opens the picker *during* a
 * conversation therefore has to come from something sitting between the
 * terminal and the agent.
 *
 * tmux is one such thing, which is why the tmux binding exists and works. But
 * requiring a multiplexer to get the headline feature of a tool you just
 * installed is a bad trade, so this is the other option: `aps` becomes that
 * middle layer itself, for one command.
 *
 * The zero-dependency route was tried first and does not work. The `script`
 * utility can allocate a pty, but on macOS it insists its own stdin be a
 * terminal — `tcgetattr/ioctl: Operation not supported on socket` — and being
 * in the middle means handing it a pipe. Node cannot allocate a pty itself.
 * Hence node-pty, and hence it being optional: nothing else in this package
 * needs it, so nothing else should pay for it.
 *
 * Two properties are worth more than the feature here, because this sits on the
 * keyboard during real work:
 *
 * **Fail open.** Anything that is not the hotkey is forwarded byte-for-byte,
 * untouched, in the same order. A wrapper that swallows a keystroke during a
 * conversation is worse than no wrapper.
 *
 * **Fail loudly, early.** If the pty module is missing, say so before the agent
 * starts, not once you are three prompts deep.
 */
import { pick } from "./tui.js";
import { inScope } from "./search.js";
import { EMPTY, feed, draftText, draftRaw } from "./draft.js";
import { saveDraft } from "./sources.js";
import { toClipboard } from "./clipboard.js";
import { chmodSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Recognising ctrl-p, whatever your terminal decided that means.
 *
 * There is no single byte sequence for a modified key. A terminal may send:
 *
 *   0x10                  the legacy control byte, and the only form for decades
 *   ESC [ 112 ; 5 u       the Kitty keyboard protocol, keycode 'p', ctrl held
 *   ESC [ 27 ; 5 ; 112 ~  xterm's modifyOtherKeys, same idea, different shape
 *
 * Which one arrives is decided at runtime, by negotiation between the terminal
 * and the program it is running — so an agent that asks for enhanced keys turns
 * an interception that worked yesterday into one that silently forwards.
 *
 * Matching only 0x10 is what made this appear broken in a plain terminal while
 * working under tmux, which normalises keys back to the legacy encoding before
 * the pane ever sees them. Testing inside a multiplexer hid the whole problem.
 * Every developer has a different setup; the fix is to accept every encoding,
 * not to assume mine.
 *
 * Modifier encoding is shared by the last two: the number is 1 + a bitmask,
 * where 4 is control.
 */
const CTRL = 0b100;
const KEY_P = 0x70;
const KITTY = /^\x1b\[(\d+)(?::\d+)?(?:;(\d+))?(?::\d+)?u$/;
const XTERM = /^\x1b\[27;(\d+);(\d+)~$/;

export function isHotkey(buf) {
  if (buf.length === 1 && buf[0] === 0x10) return true;
  const s = buf.toString("latin1");

  const kitty = KITTY.exec(s);
  if (kitty) {
    const mods = Number(kitty[2] ?? 1) - 1;
    return Number(kitty[1]) === KEY_P && (mods & CTRL) !== 0;
  }

  const xterm = XTERM.exec(s);
  if (xterm) {
    const mods = Number(xterm[1]) - 1;
    return Number(xterm[2]) === KEY_P && (mods & CTRL) !== 0;
  }

  return false;
}

/**
 * When the layer above the agent can already bind the key itself.
 *
 * herdr identifies the agent in a pane by reading the processes in that pane's
 * foreground process group. A pty moves the agent onto a tty of its own, where
 * nothing outside can see it — so `aps run claude` under herdr leaves a pane
 * whose only visible process is `node`, the agents tab stays empty, and the
 * status detection that reads a pane has nothing to read. Hiding the thing a
 * multiplexer exists to show you is a bad trade for a hotkey that multiplexer
 * can bind itself, so under herdr the agent is run directly and `aps --hotkey
 * herdr` is the other half.
 *
 * Running it directly rather than through a pty is what puts it back where
 * herdr is looking: a child sharing our stdio stays in the pane's foreground
 * process group, which is exactly what herdr enumerates.
 *
 * tmux is deliberately not here. It has no agent panel to empty, so wrapping
 * costs nothing there, and quietly taking the wrapper away from people already
 * using it would be a regression to fix a problem they do not have.
 *
 * @returns {"wrapped"|"herdr"|null} why to skip the pty, or null to wrap
 */
export function passthrough(env = process.env) {
  // One interceptor per keyboard: an outer wrapper already holds this one.
  if (env.APS_WRAPPED) return "wrapped";
  if (env.HERDR_ENV) return "herdr";
  return null;
}

const MISSING = `aps: the hotkey wrapper needs an optional module that is not installed.

    npm i -g ai-prompt-search      # reinstall, which fetches it

It is optional on purpose: plain \`aps\` has no dependencies and does not need
it. If your platform has no prebuilt binary, use the tmux binding instead:

    aps --hotkey tmux`;

/**
 * Give node-pty's helper binary back its executable bit.
 *
 * node-pty ships a small `spawn-helper` and spawns it before your command. In
 * the published tarball for at least darwin-arm64 it arrives as rw-r--r--, so
 * every spawn dies with `posix_spawnp failed` — a message that points at your
 * command rather than at the helper, and sends you looking in the wrong place.
 * The fix is one chmod, and doing it here means a fresh `npm i -g` works
 * instead of failing on first use.
 *
 * Best effort by design: on a read-only or root-owned install this cannot
 * succeed, and the spawn error below is a better place to report that than a
 * warning nobody can act on.
 */
function repairSpawnHelper() {
  try {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve("node-pty/package.json"));
    const helper = join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper");
    const mode = statSync(helper).mode;
    if (!(mode & 0o111)) chmodSync(helper, mode | 0o755);
  } catch {
    // No helper on this platform (Windows uses conpty), or nothing we may touch.
  }
}

/**
 * Run a command with the picker bound to a hotkey.
 *
 * @param {string[]} command the agent to run, e.g. ["claude"]
 * @param {() => Promise<Array>} load reads every prompt, called on each open
 * @param {{scope?: string|null}} opts
 * @returns {Promise<number>} the command's exit code
 */
export async function wrap(command, load, { scope = null } = {}) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("aps: the wrapper needs a terminal — run it from one, not a pipe");
    return 2;
  }

  let pty;
  try {
    pty = await import("node-pty");
  } catch {
    console.error(MISSING);
    return 3;
  }

  repairSpawnHelper();

  let term;
  try {
    term = pty.spawn(command[0], command.slice(1), {
      name: process.env.TERM ?? "xterm-256color",
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      cwd: process.cwd(),
      // The marker lets a nested invocation know it is already inside a
      // wrapped session. With `aps install`, the alias exists in every shell
      // the agent might spawn, so without this a shell-out to `claude` would
      // build a second pty inside the first and put two interceptors on one
      // keyboard.
      env: { ...process.env, APS_WRAPPED: "1" },
    });
  } catch (err) {
    // A stack trace here would say "posix_spawnp failed" and nothing about
    // what to do, so say what actually went wrong with the command.
    console.error(`aps: could not start ${command.join(" ")} — ${err.message}`);
    console.error("if it is not the command that is missing, use `aps --hotkey tmux` instead");
    return 3;
  }

  // While the picker is up, the agent may still be writing. Its output is held
  // rather than dropped, and replayed once the panel is gone — losing a
  // response because you searched during one would be unforgivable.
  let picking = false;
  const held = [];

  /**
   * Which conversation is this pane?
   *
   * Two panes open on the same repository are one project and two sessions, and
   * scoping to the project shows you what you typed in the other window. Every
   * agent records a session id against each prompt, so the filter exists — the
   * problem is knowing which id belongs to the child we started, since nothing
   * in its environment says so.
   *
   * The wrapper knows something nothing else does: it sees the keystrokes. A
   * prompt is submitted with Return, so the first record to appear in the
   * history after we forward one is, by construction, from this pane. The id is
   * learned from what you type rather than guessed.
   *
   * Until you have typed something there is no session to scope to, and the
   * picker opens on the project instead — the right fallback, since a pane you
   * have not typed in has no conversation of its own to show.
   */
  let session = null;
  let submittedAt = 0;

  /**
   * The line you have typed but not sent.
   *
   * Every byte headed for the agent is folded in on its way past, which is the
   * only place in the system where an unsent prompt exists at all — no agent
   * writes one down. See src/draft.js for what it can and cannot follow.
   */
  let typed = EMPTY;

  const learnSession = (prompts) => {
    if (session || !submittedAt) return;
    const mine = prompts
      .filter((p) => p.session && p.at >= submittedAt - 2 && inScope(p.cwd, scope))
      .sort((a, b) => b.at - a.at)[0];
    if (mine) session = mine.session;
  };

  term.onData((d) => {
    if (picking) held.push(d);
    else process.stdout.write(d);
  });

  const resize = () => {
    try {
      term.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
    } catch {
      // The child can exit between the resize event and this call.
    }
  };
  process.stdout.on("resize", resize);

  /**
   * Carry out what the picker decided.
   *
   * The picker returns an intention rather than performing it, because it draws
   * on a screen and knows nothing about the pty, the clipboard or the store.
   * Everything that touches the world happens here.
   */
  const act = async (chosen) => {
    if (!chosen) return;
    if (chosen.action === "insert") {
      // Written as input to the agent, which sees it exactly as if typed. The
      // text is already flattened to one line, so it cannot submit early.
      term.write(chosen.text);
    } else if (chosen.action === "save") {
      // Failing to save is not worth interrupting a session over, and there is
      // nowhere to report it: the agent has the screen back by now.
      await saveDraft(chosen.text, scope).catch(() => {});
    } else if (chosen.action === "copy") {
      await toClipboard(chosen.text);
    } else if (chosen.action === "clear") {
      // One backspace per character, rather than ctrl-u, because every input
      // widget honours backspace and only some honour a kill-line. The count
      // comes from the untrimmed draft so trailing spaces go too.
      term.write("\x7f".repeat([...draftRaw(typed)].length));
      typed = EMPTY;
    }
  };

  const onKey = async (buf) => {
    if (picking) return;
    if (isHotkey(buf)) {
      picking = true;
      // Read again, every time. The first version took one snapshot at startup,
      // so a prompt you typed a minute ago was not in the list — which is a
      // strange thing for a tool whose entire purpose is finding what you just
      // typed. Rescanning is affordable because the expensive part is cached.
      const prompts = await load().catch(() => []);
      learnSession(prompts);
      // The picker uses the alternate screen buffer, so leaving it restores
      // whatever the agent had drawn — no repainting on our part.
      const chosen = await pick(prompts, {
        scope, session, keep: true, draft: draftText(typed) || null,
      }).catch(() => null);
      picking = false;
      process.stdout.write(held.join(""));
      held.length = 0;
      await act(chosen);
      return;
    }
    // Before forwarding, not after: this is the only chance to see the line
    // being built, and the agent never tells anyone what is in its input box.
    typed = feed(typed, buf);
    // A Return submits a prompt. Note when, so the record that appears next can
    // be recognised as this pane's.
    if (buf.includes(0x0d) || buf.includes(0x0a)) submittedAt = Date.now() / 1000;
    term.write(buf.toString("binary"));
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onKey);

  // Warm the caches while you are reading the agent's banner, so the first
  // hotkey press is as quick as the rest. Deliberately not awaited: making
  // somebody wait a second and a half for their agent to start, in case they
  // later press a key, is the wrong trade.
  load().catch(() => {});

  return new Promise((resolve) => {
    term.onExit(({ exitCode }) => {
      process.stdin.off("data", onKey);
      process.stdout.off("resize", resize);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(exitCode ?? 0);
    });
  });
}
