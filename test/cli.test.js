/**
 * Tests for the command itself, run as a subprocess.
 *
 * These exist because the failure that actually reaches a user is almost never
 * a wrong array — it is a wrong exit code, a TUI drawn into a pipe, or a flag
 * that silently does nothing. None of that is visible from unit-testing the
 * search function, and all of it is visible from running the binary.
 *
 * Every case here runs non-interactively: stdio is piped, so `isTTY` is false
 * and the picker must not start. That is itself one of the assertions.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "aps.js");

/** Run aps with a fake HOME, capturing output instead of drawing a UI. */
async function aps(args, home, cwd = undefined) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
      ...(cwd ? { cwd } : {}),
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

// Most cases below pass -A because they assert on prompts from fixture paths
// that are not the directory the test runs in. Scoping is the default, so
// without it they would correctly return nothing.

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "aps-cli-"));
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", "history.jsonl"), [
    JSON.stringify({ display: "write the migration", timestamp: 1_700_000_000_000, project: "/x/atlas" }),
    JSON.stringify({ display: "run the portal tests", timestamp: 1_700_000_100_000, project: "/x/atlas" }),
  ].join("\n"));
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "history.jsonl"),
    JSON.stringify({ session_id: "s", ts: 1_700_000_050, text: "deploy to staging" }));
  return home;
}

const drop = (d) => rm(d, { recursive: true, force: true, maxRetries: 5 });

test("piped output prints instead of starting the picker", async () => {
  // The picker rendering escape codes into a pipe would make this tool
  // impossible to compose with anything else.
  const home = await fixture();
  const { code, stdout } = await aps(["-A", "-n", "10"], home);
  assert.equal(code, 0);
  assert.match(stdout, /write the migration/);
  assert.ok(!stdout.includes("esc quit"), "no picker chrome may reach a pipe");
  await drop(home);
});

test("a search narrows the output and every term must match", async () => {
  const home = await fixture();
  const { stdout } = await aps(["-A", "-p", "portal", "tests"], home);
  assert.match(stdout, /run the portal tests/);
  assert.ok(!stdout.includes("deploy to staging"));
  await drop(home);
});

test("no match exits 1, so a script can branch on it", async () => {
  const home = await fixture();
  const { code, stderr } = await aps(["-A", "-p", "zzzz-no-such-prompt"], home);
  assert.equal(code, 1);
  assert.match(stderr, /no prompt matched/);
  await drop(home);
});

test("an unknown flag exits 2 and shows help rather than guessing", async () => {
  const home = await fixture();
  const { code, stderr } = await aps(["--wat"], home);
  assert.equal(code, 2, "2 distinguishes 'you typed it wrong' from 'found nothing'");
  assert.match(stderr, /unknown flag/);
  await drop(home);
});

test("--json is valid JSON and reports the total, not the page", async () => {
  const home = await fixture();
  const { stdout } = await aps(["-A", "--json", "-n", "1"], home);
  const d = JSON.parse(stdout);
  assert.equal(d.rows.length, 1, "-n limits the rows");
  assert.equal(d.matched, 3, "matched counts everything found, not what was shown");
  assert.ok(d.rows[0].text && d.rows[0].agent && "count" in d.rows[0]);
  await drop(home);
});

test("--agents reports found and absent without failing", async () => {
  const home = await fixture();               // claude + codex, no opencode
  const { code, stdout } = await aps(["--agents"], home);
  assert.equal(code, 0);
  assert.match(stdout, /found\s+Claude Code/);
  assert.match(stdout, /found\s+Codex/);
  assert.match(stdout, /absent\s+opencode/, "an absent agent is reported, not hidden");
  await drop(home);
});

test("-a limits to one agent", async () => {
  const home = await fixture();
  const { stdout } = await aps(["-A", "-a", "codex", "-p"], home);
  assert.match(stdout, /deploy to staging/);
  assert.ok(!stdout.includes("write the migration"));
  await drop(home);
});

test("an empty history exits 1 with a next step, not a stack trace", async () => {
  const home = await mkdtemp(join(tmpdir(), "aps-empty-"));
  const { code, stderr } = await aps([], home);
  assert.equal(code, 1);
  assert.match(stderr, /no prompt history found/);
  assert.match(stderr, /--agents/, "an error should say what to run next");
  await drop(home);
});

test("--help exits 0 and documents the picker keys", async () => {
  const home = await fixture();
  const { code, stdout } = await aps(["--help"], home);
  assert.equal(code, 0);
  assert.match(stdout, /copy and quit/);
  await drop(home);
});

test("prompts are scoped to the project you are standing in", async () => {
  // The reason this exists: without a scope, running aps inside one repo listed
  // prompts from every client project on the machine — names and all — to
  // anyone glancing at the screen.
  // realpath matters on macOS: mkdtemp hands back /var/... while a process
  // started there reports /private/var/..., so an unresolved fixture path would
  // never match its own scope.
  const home = await realpath(await mkdtemp(join(tmpdir(), "aps-scope-")));
  const here = join(home, "work", "atlas");
  const elsewhere = join(home, "work", "secret-client");
  await mkdir(here, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(join(home, ".claude", "history.jsonl"), [
    JSON.stringify({ display: "prompt from atlas", timestamp: 1_700_000_000_000, project: here }),
    JSON.stringify({ display: "prompt from the other client", timestamp: 1_700_000_100_000, project: elsewhere }),
    // A prompt from a subdirectory still belongs to the project above it.
    JSON.stringify({ display: "prompt from a subfolder", timestamp: 1_700_000_200_000, project: join(here, "src") }),
  ].join("\n"));

  const scoped = await aps(["-p"], home, here);
  assert.match(scoped.stdout, /prompt from atlas/);
  assert.match(scoped.stdout, /prompt from a subfolder/, "subdirectories count as the same project");
  assert.ok(!scoped.stdout.includes("other client"), "another project must not appear");

  const all = await aps(["-A", "-p"], home, here);
  assert.match(all.stdout, /other client/, "-A is the way to see everything");

  await drop(home);
});

// The hotkey surface. The picker half of --pick needs a real terminal and was
// exercised by hand inside tmux; what is testable here is that it refuses
// clearly when there is no keyboard, rather than hanging on a pipe forever.
test("--pick without a keyboard refuses instead of hanging", async () => {
  const home = await fixture();
  const { code, stderr } = await aps(["--pick"], home);
  assert.equal(code, 2);
  assert.match(stderr, /needs a keyboard/);
  await drop(home);
});

test("--hotkey prints bindings that name the right command", async () => {
  const home = await fixture();
  const { code, stdout } = await aps(["--hotkey"], home);
  assert.equal(code, 0);
  assert.match(stdout, /bind -n M-p display-popup/, "tmux is the only layer that can reach inside an agent");
  assert.match(stdout, /aps --pick/, "the bindings must call the mode that prints to stdout");
  assert.match(stdout, /zle -N aps-widget/, "and the shell widget, for a plain prompt");
  await drop(home);
});

test("--hotkey for one shell prints only that one", async () => {
  const home = await fixture();
  const { stdout } = await aps(["--hotkey", "zsh"], home);
  assert.match(stdout, /bindkey/);
  assert.ok(!stdout.includes("display-popup"), "asking for zsh should not print tmux");
  const bad = await aps(["--hotkey", "fish"], home);
  assert.equal(bad.code, 2, "an unsupported shell is a usage error, not silence");
  await drop(home);
});

test("an empty scope says how to widen it rather than just failing", async () => {
  const home = await fixture();
  const empty = await mkdtemp(join(tmpdir(), "aps-nowhere-"));
  const { code, stderr } = await aps(["-p", "migration"], home, empty);
  assert.equal(code, 1);
  assert.match(stderr, /-A/, "a dead end should name the way out");
  await drop(home);
  await drop(empty);
});
