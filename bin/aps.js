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

In the picker: ↑↓ move · ⏎ copy and quit · esc quit · ctrl-u clear · ctrl-a scope

By default you only see prompts typed in the current project. Prompts from your
other work stay out of sight until you ask for them.

Agents are detected, never configured: if the directory is there, it is read.`;

const argv = process.argv.slice(2);
const opts = { copy: false, limit: 40, agent: null, json: false, print: false, all: false };
const terms = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-h" || a === "--help") { console.log(HELP); process.exit(0); }
  else if (a === "-c" || a === "--copy") opts.copy = true;
  else if (a === "-p" || a === "--print") opts.print = true;
  else if (a === "--json") opts.json = true;
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
  !opts.print && !opts.json && !opts.copy && process.stdin.isTTY && process.stdout.isTTY;

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

if (interactive) {
  const chosen = await pick(prompts, { query: terms.join(" "), scope: opts.all ? null : projectRoot() });
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
}

}
