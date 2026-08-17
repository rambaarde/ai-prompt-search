#!/usr/bin/env node
/**
 * aps — search and reuse your own prompts, across every AI CLI you use.
 *
 * The command is deliberately thin. Argument parsing, rendering, and exit
 * codes live here; finding prompts lives in src/. That split is what lets the
 * search be tested without a terminal and reused by anything else later.
 *
 * Output rules follow the same reasoning as the rest: newest LAST, so the most
 * recent prompt lands nearest the cursor where the eye already is; counts on
 * repeats, because how often you type something is information; and `--json`
 * for anything that wants to consume this rather than read it.
 */
import { collect, detect, SOURCES } from "../src/sources.js";
import { search } from "../src/search.js";
import { pick } from "../src/tui.js";
import { spawn, execFileSync } from "node:child_process";
import { platform } from "node:process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { openSync } from "node:fs";
import { WriteStream } from "node:tty";

/**
 * The project you are standing in: the git root, or the working directory.
 *
 * Scoping to the repository rather than the exact directory is what makes this
 * useful — you type prompts from the repo root, from a package folder, from
 * wherever, and they are all the same project.
 */
function projectRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"],
      { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || process.cwd();
  } catch {
    return process.cwd();
  }
}

/**
 * Say where the hotkey went, and stop saying it once it is back.
 *
 * Under herdr the wrapper steps aside so the agent stays visible to the pane
 * (see `passthrough` in src/wrap.js). Left silent, that reads as a ctrl-p that
 * simply stopped working one day, which is the worst shape a change can take.
 * So this prints the one line that fixes it — and only while it needs fixing,
 * because a notice on every single agent launch is its own kind of broken.
 */
async function herdrNotice() {
  const path = process.env.HERDR_CONFIG_PATH
    ?? join(homedir(), ".config", "herdr", "config.toml");
  const config = await readFile(path, "utf8").catch(() => "");
  if (config.includes("aps --pick")) return;
  console.error("aps: herdr runs your agent directly, so its agents tab can see it.");
  console.error("     for ctrl-p there, add the binding from: aps --hotkey herdr");
}

const HELP = `aps — your prompts, across every AI CLI

  aps                    the picker, scoped to THIS project
  aps <words>            open the picker with a search already typed
  aps -A <words>         every project you have ever worked in

  aps -p <words>         print instead of picking (for eyes, not hands)
  aps -c <words>         copy the newest match, no UI
  aps -n <count>         how many rows (default 40)
  aps -a <agent>         one agent only
  aps -A, --all          drop the project scope
  aps --agents           which agents were found on this machine
  aps --json <words>     machine-readable, for piping

  aps install            alias your agents so ctrl-p just works
  aps install <name>…    also wrap your own launcher, e.g. a shell function
  aps uninstall          take the aliases back out
  aps run <command>      run it with ctrl-p bound to the picker
  aps --pick             picker on the terminal, chosen prompt to stdout
  aps --hotkey           print the herdr, tmux and shell bindings to install
  aps --keys             what your terminal sends for a keypress

In the picker: ↑↓ move · ⏎ copy and quit · esc quit · ctrl-u clear · ctrl-a scope

By default you only see prompts typed in the current project. Prompts from your
other work stay out of sight until you ask for them.

Agents are detected, never configured: if the directory is there, it is read.`;

/**
 * The bindings, as text to paste rather than a file we write into your dotfiles.
 *
 * There is one hard limitation worth stating plainly, because it decides the
 * whole design: while an agent is running it holds the keyboard in raw mode.
 * Nothing can inject a keystroke into it — not a shell binding, not a daemon.
 * A hotkey that works *inside* a session therefore has to come from the layer
 * above it, which is the terminal multiplexer. That is what the tmux binding is,
 * and why there is no single cross-platform answer.
 *
 * The shell widget is the other half: at a prompt, not inside an agent, where
 * the shell does own the keyboard.
 */
const HOTKEY = {
  tmux: `# ~/.tmux.conf — alt-p opens the picker over whatever is running,
# and types the prompt you choose straight into it.
#
# The popup is not a pane, so the agent underneath stays the active pane and
# send-keys with no target reaches it. -l sends the text literally: quotes,
# backticks and $ arrive as themselves rather than as shell syntax.
bind -n M-p display-popup -E -w 76 -h 16 'p=$(aps --pick) && tmux send-keys -l -- "$p"'

# Then: tmux source-file ~/.tmux.conf`,

  zsh: `# ~/.zshrc — alt-p at a shell prompt puts the chosen prompt on the line.
# This one cannot reach inside a running agent; nothing can. It is for the
# shell itself.
aps-widget() {
  local chosen
  chosen=$(aps --pick </dev/tty) || return 0
  LBUFFER="$LBUFFER$chosen"
  zle reset-prompt
}
zle -N aps-widget
bindkey '^[p' aps-widget

# Then: exec zsh`,

  bash: `# ~/.bashrc — alt-p at a shell prompt.
bind -x '"\\ep": "READLINE_LINE=$(aps --pick </dev/tty); READLINE_POINT=\${#READLINE_LINE}"'`,

  herdr: `# ~/.config/herdr/config.toml — alt-p opens the picker over whatever is
# running, and types the prompt you choose straight into it.
#
# Under herdr this is the binding, not \`aps run\`. herdr works out which agent
# a pane holds by reading that pane's own processes, and a wrapper's pty moves
# the agent onto a tty of its own where herdr cannot see it — an empty agents
# tab is a worse trade than a keybinding. So \`aps run\` steps aside here and
# this does the same job from above, exactly as the tmux popup does.
#
# HERDR_ACTIVE_PANE_ID is the pane that was focused when the key was pressed,
# which is the one underneath the popup. send-text is literal, so quotes,
# backticks and $ arrive as themselves rather than as shell syntax.
[[keys.command]]
key = "alt+p"
type = "popup"
command = 'p=$(aps --pick) && herdr pane send-text "$HERDR_ACTIVE_PANE_ID" "$p"'
width = 76
height = 16

# Then: herdr server reload-config`,
};

const argv = process.argv.slice(2);

/**
 * `aps --keys` — show what this terminal actually sends.
 *
 * A modified keypress has no single encoding: the same ctrl-p arrives as one
 * byte, as a Kitty-protocol escape, or as an xterm modifyOtherKeys escape,
 * depending on the terminal and on what the running program negotiated. That
 * makes "the hotkey does nothing" impossible to diagnose from a description,
 * and impossible to reproduce on a different machine.
 *
 * So rather than guess at someone's setup, this prints the bytes. It also says
 * whether the wrapper would recognise what you pressed, which is the actual
 * question being asked.
 */
if (argv[0] === "install" || argv[0] === "uninstall") {
  const mod = await import("../src/install.js");
  const shellAt = argv.indexOf("--shell");
  const shell = shellAt === -1 ? undefined : argv[shellAt + 1];
  // Bare words are extra commands to wrap — someone's own launcher, which is
  // usually a shell function and so invisible to PATH detection.
  const extra = argv
    .slice(1)
    .filter((a, i) => !a.startsWith("-") && i + 1 !== shellAt);
  const fn = argv[0] === "install" ? mod.install : mod.uninstall;
  process.exit(await fn({ shell, extra, print: argv.includes("--print") }));
}

if (argv[0] === "--keys") {
  if (!process.stdin.isTTY) {
    console.error("aps --keys needs a terminal — run it directly, not through a pipe");
    process.exit(2);
  }
  const { isHotkey } = await import("../src/wrap.js");
  console.log("press keys to see what your terminal sends — ctrl-c to stop\n");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (buf) => {
    if (buf.length === 1 && buf[0] === 0x03) {
      process.stdin.setRawMode(false);
      process.exit(0);
    }
    const hex = [...buf].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const shown = JSON.stringify(buf.toString("latin1")).slice(1, -1);
    const match = isHotkey(buf) ? "  <- the wrapper opens the picker on this" : "";
    process.stdout.write(`${hex.padEnd(24)} ${shown.padEnd(18)}${match}\r\n`);
  });
}

/**
 * `aps run <command…>` — run something with the picker on a hotkey.
 *
 * Handled before flag parsing, and everything after `run` is the command's,
 * not ours. Otherwise `aps run claude --resume` would have to decide whether
 * `--resume` belongs to aps or to claude, and it belongs to claude.
 */
if (argv[0] === "run") {
  const command = argv.slice(1);
  if (command.length === 0) {
    console.error("aps run needs something to run, e.g. `aps run claude`");
    process.exit(2);
  }
  const { passthrough } = await import("../src/wrap.js");
  const plain = passthrough();
  if (plain) {
    if (plain === "herdr") await herdrNotice();
    // stdio is inherited rather than piped, which is also what keeps the agent
    // in this pane's foreground process group — the list herdr reads to work
    // out which agent a pane is running.
    //
    // APS_WRAPPED is what the installed rc block reads to skip itself, so it
    // has to be set on every path that runs the command, not only the pty one.
    // The alias for a shell function runs `zsh -ic <name>`, and that shell
    // sources the rc: without the flag the alias is defined again, the name
    // resolves to it, and `claude-start` relaunches itself without end.
    const child = spawn(command[0], command.slice(1), {
      stdio: "inherit",
      env: { ...process.env, APS_WRAPPED: "1" },
    });
    // Awaited rather than left to an exit handler, because handlers do not stop
    // the module: execution ran on into the picker below, and whichever of the
    // two called process.exit first decided the exit code. `aps run` would
    // report the picker's "no prompt history found" instead of the agent's own
    // status, having pointlessly read every prompt on the way there.
    process.exit(await new Promise((resolve) => {
      child.on("exit", (code) => resolve(code ?? 0));
      child.on("error", (err) => {
        console.error(`aps: could not run ${command[0]} — ${err.message}`);
        resolve(127);
      });
    }));
  } else {
    // History is not read here. Loading 23,000 prompts before the agent even
    // appears would put a second and a half between the command and the
    // banner, every time, for something you may never press. The wrapper
    // loads it in the background and re-reads it on each open.
    const { wrap } = await import("../src/wrap.js");
    process.exit(await wrap(command, () => collect(), { scope: projectRoot() }));
  }
}

const opts = { copy: false, limit: 40, agent: null, json: false, print: false, all: false, pick: false };
const terms = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") { console.log(HELP); process.exit(0); }
  else if (a === "-c" || a === "--copy") opts.copy = true;
  else if (a === "-p" || a === "--print") opts.print = true;
  else if (a === "--json") opts.json = true;
  else if (a === "--pick") opts.pick = true;
  else if (a === "--hotkey") {
    const which = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : null;
    const parts = which ? [HOTKEY[which]] : [HOTKEY.herdr, HOTKEY.tmux, HOTKEY.zsh, HOTKEY.bash];
    if (parts.some((p) => !p)) {
      console.error(`unknown shell: ${which} — try herdr, tmux, zsh or bash`);
      process.exit(2);
    }
    console.log(parts.join("\n\n"));
    process.exit(0);
  }
  else if (a === "-A" || a === "--all") opts.all = true;
  else if (a === "-n") opts.limit = Number(argv[++i]) || 40;
  else if (a === "-a" || a === "--agent") opts.agent = argv[++i];
  else if (a === "--agents") opts.agent = "__list";
  else if (a.startsWith("-")) { console.error(`unknown flag: ${a}\n\n${HELP}`); process.exit(2); }
  else terms.push(a);
}

/**
 * The picker is the default, but only when there is a terminal to draw on.
 *
 * Piped into another command, or asked for --json, this has to behave like a
 * filter and print. A TUI that renders escape codes into a pipe is a tool that
 * cannot be composed with anything.
 */
const interactive =
  !opts.print && !opts.json && !opts.copy && !opts.pick &&
  process.stdin.isTTY && process.stdout.isTTY;

/**
 * The terminal to draw the picker on when stdout has been taken.
 *
 * A binding runs `chosen=$(aps --pick)`, which makes stdout a pipe. The panel
 * cannot go there — it would end up in the variable instead of on the screen —
 * so it goes to /dev/tty, which is the terminal regardless of what stdout was
 * pointed at. Keystrokes still arrive on stdin, which the shell leaves alone.
 */
function screenForPicker() {
  if (process.stdout.isTTY) return process.stdout;
  try {
    return new WriteStream(openSync("/dev/tty", "w"));
  } catch {
    console.error("--pick needs a terminal to draw on, and /dev/tty is not available here");
    process.exit(2);
  }
}

if (opts.agent === "__list") {
  const found = await detect();
  const names = new Set(found.map((s) => s.name));
  for (const s of SOURCES) {
    const on = names.has(s.name);
    console.log(`${on ? "found  " : "absent "} ${s.label.padEnd(12)} ${on ? s.dir() : ""}`);
  }
  process.exit(0);
}

const prompts = await collect(opts.agent ? [opts.agent] : []);
if (prompts.length === 0) {
  console.error("no prompt history found — run `aps --agents` to see what was detected");
  process.exit(1);
}

/** Put text on the clipboard, and fall back to printing it if there is none. */
function toClipboard(text, onDone) {
  const cmd = platform === "darwin" ? "pbcopy" : platform === "win32" ? "clip" : "xclip";
  const args = platform === "linux" ? ["-selection", "clipboard"] : [];
  const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
  child.on("error", () => {
    // No clipboard tool is not a failure: print it so it can still be used.
    console.log(text);
    process.exit(0);
  });
  child.stdin.end(text);
  child.on("close", onDone);
}

if (opts.pick) {
  if (!process.stdin.isTTY) {
    console.error("--pick needs a keyboard: run it from a binding, not a pipe");
    process.exit(2);
  }
  const chosen = await pick(prompts, {
    query: terms.join(" "),
    scope: opts.all ? null : projectRoot(),
    screen: screenForPicker(),
  });
  // Nothing chosen exits non-zero so a binding can tell "escaped" from "picked
  // an empty line" and leave the command line untouched.
  if (!chosen) process.exit(1);
  process.stdout.write(chosen);
  process.exit(0);
}

if (interactive) {
  const chosen = await pick(prompts, {
    query: terms.join(" "),
    scope: opts.all ? null : projectRoot(),
  });
  if (!chosen) process.exit(0);
  toClipboard(chosen, () => {
    console.log(`copied  ${chosen.slice(0, 110)}${chosen.length > 110 ? "…" : ""}`);
  });
} else {

const scope = opts.all ? null : projectRoot();
const { rows, matched } = search(prompts, { terms, limit: opts.limit, scope });

if (rows.length === 0) {
  const where = scope ? ` in ${scope}` : "";
  console.error(`no prompt matched: ${terms.join(" ")}${where}`);
  if (scope) console.error("try -A to search every project");
  process.exit(1);
}

if (opts.json) {
  console.log(JSON.stringify({ matched, rows }, null, 2));
  process.exit(0);
}

if (opts.copy) {
  const best = rows[0].text;
  toClipboard(best, () => {
    console.error(`copied  ${best.slice(0, 110)}${best.length > 110 ? "…" : ""}`);
  });
} else {
  const dim = (s) => `\x1b[2m${s}\x1b[0m`;
  const HUE = { claude: "\x1b[35m", codex: "\x1b[36m", opencode: "\x1b[33m" };
  const width = Number(process.stdout.columns || 120);

  // Reversed: the newest row prints last, closest to where the prompt returns.
  for (const r of [...rows].reverse()) {
    const when = r.at ? new Date(r.at * 1000).toISOString().slice(5, 16).replace("T", " ") : "  --   ";
    const head = `${when} ${r.agent.padEnd(8)} `;
    const room = Math.max(30, width - head.length - 8);
    const body = r.text.length > room ? `${r.text.slice(0, room)}…` : r.text;
    const times = r.count > 1 ? dim(` x${r.count}`) : "";
    console.log(`${dim(when)} ${HUE[r.agent] ?? ""}${r.agent.padEnd(8)}\x1b[0m ${body}${times}`);
  }
  console.error(dim(`\n${matched} unique prompt(s)${terms.length ? ` matching “${terms.join(" ")}”` : ""}`));

  // Say why this was a list and not the picker.
  //
  // Falling back silently is what makes a working tool look like a broken one:
  // you type `aps`, a wall of text appears, and there is nothing to tell you
  // that the picker exists and simply had nowhere to draw. This happens inside
  // an agent's own shell runner, which has no terminal attached at all — not
  // stdin, not stdout, not even /dev/tty — so no TUI can render there, and no
  // amount of flags will change that.
  if (!opts.print && !opts.json && !opts.copy) {
    const missing = !process.stdin.isTTY ? "no keyboard is attached here" : "output is being captured";
    console.error(dim(`the picker needs a terminal — ${missing}, so this printed instead`));
  }
}

}
