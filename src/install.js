/**
 * Making the hotkey the default, without anyone changing how they type.
 *
 * `aps run claude` works, and nobody will do it. People type `claude`, `codex`,
 * `opencode` — that is the whole muscle memory, and a tool that asks you to
 * prefix it every time is a tool you stop using by the third day.
 *
 * So this writes one alias per agent you actually have installed. An alias
 * rather than a shim on PATH, for two reasons: a shim would also intercept
 * scripts and CI, where a keyboard interceptor has no business being, and a
 * shim that resolves the same name it shadows is one PATH mistake away from
 * calling itself forever. An alias only affects an interactive shell, which is
 * exactly where a hotkey means anything.
 *
 * There is no recursion risk from the alias: the wrapper spawns the agent
 * through node-pty, which resolves the binary on PATH and never consults the
 * shell, so it finds the real `claude` and not the alias.
 *
 * The block is fenced with markers so this is idempotent and reversible. It
 * rewrites its own block and leaves everything else in the file untouched.
 */
import { readFile, writeFile, copyFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";

const START = "# >>> ai-prompt-search >>>";
const END = "# <<< ai-prompt-search <<<";

/** The agents worth wrapping: the ones with a prompt history to search. */
const AGENTS = ["claude", "codex", "opencode"];

const RC = {
  zsh: ".zshrc",
  bash: ".bashrc",
};

/**
 * Which of them are actually on this machine.
 *
 * PATH is walked directly rather than shelling out to `command -v`. Spawning a
 * shell to ask a question the filesystem can answer is slower, and passing a
 * name into a shell is the shape of problem that turns a tool name into
 * arbitrary execution the day one of these is not a literal.
 */
export async function installed(agents = AGENTS) {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const found = await Promise.all(
    agents.map(async (a) => {
      for (const dir of dirs) {
        try {
          await access(join(dir, a), constants.X_OK);
          return a;
        } catch {
          // Not in this directory; keep looking.
        }
      }
      return null;
    }),
  );
  return found.filter(Boolean);
}

/**
 * The alias block.
 *
 * Two things here are not decoration.
 *
 * **The whole block is skipped inside a wrapped session.** Without that guard,
 * an alias for a shell function recurses without end: the alias runs a shell,
 * that shell sources this file, the alias is defined again, and it calls
 * itself. Skipping when APS_WRAPPED is set also means anything an agent
 * shells out to gets the real command, not another interceptor.
 *
 * **A shell function cannot be spawned.** `aps run` starts the command through
 * the PATH, and a function defined in your rc is not on the PATH — so a custom
 * launcher like `claude-start`, which is exactly the kind of thing people wrap
 * their agent in, has to be run by a shell that has read that rc. Hence the
 * `-ic` form for names that are not binaries.
 */
export function block(entries, shell = "zsh") {
  const line = ({ name, kind }) =>
    kind === "function"
      ? `  alias ${name}='aps run ${shell} -ic ${name}'`
      : `  alias ${name}='aps run ${name}'`;

  return [
    START,
    "# ctrl-p opens your prompt history inside these commands.",
    "# Remove with `aps uninstall`, or delete this block.",
    "#",
    "# Skipped inside a session aps already wraps, so nothing wraps twice and a",
    "# shell-function alias cannot call itself.",
    'if [ -z "$APS_WRAPPED" ]; then',
    ...entries.map(line),
    "fi",
    END,
  ].join("\n");
}

/** Replace an existing block, or append one, leaving the rest alone. */
export function apply(contents, next) {
  const from = contents.indexOf(START);
  const to = contents.indexOf(END);
  if (from !== -1 && to !== -1 && to > from) {
    return contents.slice(0, from) + next + contents.slice(to + END.length);
  }
  const spacer = contents.length && !contents.endsWith("\n") ? "\n\n" : "\n";
  return contents + spacer + next + "\n";
}

/** Remove the block entirely, and the blank line it was sitting on. */
export function strip(contents) {
  const from = contents.indexOf(START);
  const to = contents.indexOf(END);
  if (from === -1 || to === -1 || to < from) return null;
  return (contents.slice(0, from).replace(/\n+$/, "\n") + contents.slice(to + END.length).replace(/^\n+/, "")).trimEnd() + "\n";
}

function rcPath(shell) {
  const name = shell ?? (process.env.SHELL ?? "").split("/").pop();
  const file = RC[name];
  return file ? { name, path: join(homedir(), file) } : { name, path: null };
}

const read = (p) => readFile(p, "utf8").catch(() => "");

/**
 * Write the aliases.
 *
 * A copy of the file is kept beside it before the first write. Editing
 * somebody's shell configuration is the kind of thing that should always be one
 * command away from undone.
 */
export async function install({ shell, print = false, extra = [] } = {}) {
  const { name: shellName, path } = rcPath(shell);
  const found = await installed();

  // Anything named explicitly is included even when it is not on the PATH,
  // because that is the signature of a shell function — someone's own launcher
  // that sets up their context before starting the agent. Those are precisely
  // the commands worth wrapping, and precisely the ones detection cannot see.
  const onPath = new Set(found);
  const entries = [
    ...found.map((name) => ({ name, kind: "binary" })),
    ...extra
      .filter((name) => !onPath.has(name))
      .map((name) => ({ name, kind: "function" })),
  ];

  if (entries.length === 0) {
    console.error("no agents found to wrap — `aps --agents` shows what was detected");
    console.error("if you start yours with a shell function, name it: aps install my-launcher");
    return 1;
  }

  const text = block(entries, shellName || "zsh");
  if (print) {
    console.log(text);
    return 0;
  }

  if (!path) {
    console.error(`aps: no rc file known for ${shellName || "this shell"} — add these lines yourself:\n`);
    console.log(text);
    return 1;
  }

  const before = await read(path);
  if (before) await copyFile(path, `${path}.aps-backup`).catch(() => {});
  await writeFile(path, apply(before, text));

  const verb = before.includes(START) ? "updated" : "added";
  console.log(`${verb} in ${path}:`);
  for (const e of entries) {
    const how = e.kind === "function" ? `aps run ${shellName} -ic ${e.name}` : `aps run ${e.name}`;
    console.log(`  ${e.name} → ${how}`);
  }
  console.log(`\nrun \`exec ${shellName}\` to pick it up, then press ctrl-p inside ${entries[0].name}`);
  if (before) console.log(`the previous file is at ${path}.aps-backup`);
  return 0;
}

/** Take it back out. */
export async function uninstall({ shell } = {}) {
  const { name, path } = rcPath(shell);
  if (!path) {
    console.error(`aps: no rc file known for ${name || "this shell"}`);
    return 1;
  }
  const before = await read(path);
  const after = strip(before);
  if (after === null) {
    console.log(`nothing to remove from ${path}`);
    return 0;
  }
  await writeFile(path, after);
  console.log(`removed the aliases from ${path} — run \`exec ${name}\``);
  return 0;
}
