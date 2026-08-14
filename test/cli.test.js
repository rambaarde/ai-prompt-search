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
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "aps.js");

/** Run aps with a fake HOME, capturing output instead of drawing a UI. */
async function aps(args, home) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

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
  const { code, stdout } = await aps(["-n", "10"], home);
  assert.equal(code, 0);
  assert.match(stdout, /write the migration/);
  assert.ok(!stdout.includes("esc quit"), "no picker chrome may reach a pipe");
  await drop(home);
});

test("a search narrows the output and every term must match", async () => {
  const home = await fixture();
  const { stdout } = await aps(["-p", "portal", "tests"], home);
  assert.match(stdout, /run the portal tests/);
  assert.ok(!stdout.includes("deploy to staging"));
  await drop(home);
});

test("no match exits 1, so a script can branch on it", async () => {
  const home = await fixture();
  const { code, stderr } = await aps(["-p", "zzzz-no-such-prompt"], home);
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
  const { stdout } = await aps(["--json", "-n", "1"], home);
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
  const { stdout } = await aps(["-a", "codex", "-p"], home);
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
