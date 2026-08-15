/**
 * Editing somebody's shell configuration.
 *
 * This is the most invasive thing the package does, so the properties that
 * matter are not about aliases at all — they are about not damaging a file
 * somebody else owns. Running install twice must not leave two blocks. Removing
 * it must leave the file as it was found. Nothing outside the fenced block may
 * ever move.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { block, apply, strip, launchers } from "../src/install.js";

const RC = `export PATH="$HOME/bin:$PATH"
alias gs='git status'
`;

const bin = (name) => ({ name, kind: "binary" });

test("the block aliases exactly the commands it was given", () => {
  const text = block([bin("claude"), bin("codex")]);
  assert.match(text, /alias claude='aps run claude'/);
  assert.match(text, /alias codex='aps run codex'/);
  assert.ok(!text.includes("opencode"), "an agent you do not have is not aliased");
  assert.match(text, /aps uninstall/, "the way out belongs next to the way in");
});

test("a shell function is run through a shell, because it is not on the PATH", () => {
  // The case that made someone's hotkey silently not exist: a custom launcher
  // like `claude-start`, defined as a zsh function, cannot be spawned by name.
  const text = block([{ name: "claude-start", kind: "function" }], "zsh");
  assert.match(text, /alias claude-start='aps run zsh -ic claude-start'/);
});

test("the block disables itself inside a session aps already wraps", () => {
  // Without this, a shell-function alias calls itself: the alias runs a shell,
  // the shell reads this file, the alias is defined again, forever.
  const text = block([{ name: "claude-start", kind: "function" }]);
  assert.match(text, /if \[ -z "\$APS_WRAPPED" \]; then/);
  assert.match(text, /\nfi\n/, "and closes the guard it opened");
});

test("a launcher defined in the shell is found, and a one-shot helper is not", () => {
  // People start their agent through their own function more often than not,
  // and those are invisible to PATH detection. But matching any function with
  // an agent's name in it also catches one-shot helpers, and wrapping one puts
  // a pty and a keyboard interceptor around a command that is over in a second.
  const rc = [
    'claude-start() { _session claude "$@"; }',
    "function codex-run() { codex --profile work; }",
    "alias start-claude='claude --resume'",
    'codex-note() { ai-note "$@"; }',
    "deploy() { ./deploy.sh; }",
    "claude() { echo shadowed; }",
  ].join("\n");

  const found = launchers(rc).sort();
  assert.deepEqual(found, ["claude-start", "codex-run", "start-claude"]);
  assert.ok(!found.includes("codex-note"), "a one-shot helper is not a session");
  assert.ok(!found.includes("deploy"), "an unrelated function is never a launcher");
  assert.ok(!found.includes("claude"), "the plain agent is found on PATH, not here");
});

test("our own block is never scanned for launchers", () => {
  // Every alias in it contains an agent's name and the word `run`. Reading it
  // back would wrap the wrapper, and then wrap that.
  const rc = `alias gs='git status'\n${block([{ name: "claude-start", kind: "function" }])}\n`;
  assert.deepEqual(launchers(rc), []);
});

test("installing twice leaves one block, not two", () => {
  // The failure this prevents is the classic one: a tool that appends on every
  // run and slowly fills a dotfile with copies of itself.
  const once = apply(RC, block([bin("claude")]));
  const twice = apply(once, block([bin("claude"), bin("codex")]));
  assert.equal(twice.match(/>>> ai-prompt-search >>>/g).length, 1);
  assert.match(twice, /alias codex=/, "the second run's content wins");
});

test("nothing outside the block is touched", () => {
  const after = apply(RC, block([bin("claude")]));
  assert.match(after, /export PATH="\$HOME\/bin:\$PATH"/);
  assert.match(after, /alias gs='git status'/);
  assert.ok(after.startsWith(RC.trimEnd()), "existing lines keep their order and position");
});

test("uninstalling restores what was there before", () => {
  const after = apply(RC, block([bin("claude"), bin("codex")]));
  assert.equal(strip(after), RC.trimEnd() + "\n");
});

test("uninstalling a file that was never installed into changes nothing", () => {
  assert.equal(strip(RC), null, "null says 'nothing to do' rather than rewriting the file");
});

test("a file with no trailing newline still gets a separated block", () => {
  const cramped = "alias gs='git status'";
  const after = apply(cramped, block([bin("claude")]));
  assert.match(after, /git status'\n\n# >>> ai-prompt-search >>>/, "never glued onto someone's last line");
});
