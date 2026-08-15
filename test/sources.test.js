/**
 * Tests for the readers — the half that parses formats owned by other projects.
 *
 * These build real fixture files in the real layouts and point the readers at a
 * temporary home. That is deliberately not a mock: a mock of someone else's
 * format only proves you remembered your own mock. A fixture at least proves
 * the parser handles the shape as documented, and it fails loudly the day an
 * agent changes where it writes.
 *
 * The shapes here were taken from live files, not from documentation:
 *   ~/.claude/history.jsonl  {"display","timestamp"(ms),"project","sessionId"}
 *   ~/.codex/history.jsonl   {"session_id","ts"(seconds),"text"}
 *   opencode  storage/message/<id>.json  {"role","summary","time":{"created"}}
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collect, detect, SOURCES } from "../src/sources.js";

async function fixture({ claude = true, codex = true, opencode = true } = {}) {
  const home = await mkdtemp(join(tmpdir(), "aps-"));

  if (claude) {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "history.jsonl"), [
      JSON.stringify({ display: "write the migration", timestamp: 1_700_000_000_000, project: "/Users/x/code/atlas-web" }),
      JSON.stringify({ display: "run the tests", timestamp: 1_700_000_100_000, project: "/Users/x/code/atlas-api" }),
      // A record with no prompt in it must be skipped, not become an empty row.
      JSON.stringify({ timestamp: 1_700_000_200_000, project: "/Users/x/code/atlas-api" }),
      // Agents append while this runs: a half-written last line is normal.
      '{"display":"truncated mid-writ',
      "",
    ].join("\n"));
  }

  if (codex) {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "history.jsonl"), [
      JSON.stringify({ session_id: "s1", ts: 1_700_000_050, text: "deploy to staging" }),
      JSON.stringify({ session_id: "s1", ts: 1_700_000_060, text: "   " }),
      "not json at all",
    ].join("\n"));
  }

  if (opencode) {
    // opencode splits one message across two trees: the record, and its text.
    const store = join(home, ".local", "share", "opencode", "storage");
    const msg = join(store, "message", "ses_1");
    await mkdir(msg, { recursive: true });

    // `summary` is an object here, exactly as opencode writes it. Reading the
    // prompt from this field is the bug this fixture exists to prevent.
    await writeFile(join(msg, "msg_a.json"), JSON.stringify({
      id: "msg_a", role: "user", summary: { diffs: [] },
      time: { created: 1_700_000_070_000 }, path: { cwd: "/Users/x/code/beacon-api" },
    }));
    await mkdir(join(store, "part", "msg_a"), { recursive: true });
    await writeFile(join(store, "part", "msg_a", "prt_1.json"),
      JSON.stringify({ type: "text", text: "add the rate limit" }));
    // A message can carry several parts, and non-text parts must be ignored.
    await writeFile(join(store, "part", "msg_a", "prt_2.json"),
      JSON.stringify({ type: "text", text: "to the api gateway" }));
    await writeFile(join(store, "part", "msg_a", "prt_3.json"),
      JSON.stringify({ type: "tool", tool: "bash" }));

    // The assistant's own messages live in the same folder and are not ours.
    await writeFile(join(msg, "msg_b.json"), JSON.stringify({
      id: "msg_b", role: "assistant", time: { created: 1_700_000_080_000 },
    }));
    await mkdir(join(store, "part", "msg_b"), { recursive: true });
    await writeFile(join(store, "part", "msg_b", "prt_1.json"),
      JSON.stringify({ type: "text", text: "I added the rate limit" }));

    // A user message whose parts were never written yields nothing, rather
    // than an empty row.
    await writeFile(join(msg, "msg_c.json"), JSON.stringify({
      id: "msg_c", role: "user", time: { created: 1_700_000_090_000 },
    }));
  }

  return home;
}

const drop = (d) => rm(d, { recursive: true, force: true, maxRetries: 5 });

test("claude history is read, with ms timestamps and the project basename", async () => {
  const home = await fixture({ codex: false, opencode: false });
  const rows = await collect([], home);

  assert.equal(rows.length, 2, "the record with no display must not become a row");
  const first = rows.find((r) => r.text === "write the migration");
  assert.ok(first);
  assert.equal(first.agent, "claude");
  assert.equal(first.at, 1_700_000_000, "milliseconds must be converted to seconds");
  assert.equal(first.project, "atlas-web", "the full path is noise; the basename is the label");

  await drop(home);
});

test("codex history is read, and its timestamps are already seconds", async () => {
  const home = await fixture({ claude: false, opencode: false });
  const rows = await collect([], home);

  assert.equal(rows.length, 1, "a whitespace-only prompt is not a prompt");
  assert.equal(rows[0].text, "deploy to staging");
  assert.equal(rows[0].at, 1_700_000_050, "codex seconds must not be divided again");
  assert.equal(rows[0].agent, "codex");

  await drop(home);
});

test("a session that appears after the first read is still found", async () => {
  // Rollout headers are cached, because reading every one of them cost 1.6
  // seconds and made re-reading history on each hotkey press unaffordable. The
  // risk that buys is staleness: a session started *during* your session would
  // be invisible, and its prompts would arrive with no directory attached.
  const home = await fixture({ claude: false, opencode: false });
  await collect([], home);

  const sessions = join(home, ".codex", "sessions");
  await mkdir(sessions, { recursive: true });
  await writeFile(join(sessions, "rollout-later.jsonl"),
    `${JSON.stringify({ payload: { id: "s2", cwd: "/work/started-just-now" } })}\n`);
  await writeFile(join(home, ".codex", "history.jsonl"), [
    JSON.stringify({ session_id: "s1", ts: 1_700_000_050, text: "deploy to staging" }),
    JSON.stringify({ session_id: "s2", ts: 1_700_000_099, text: "typed in the newer session" }),
  ].join("\n"));

  const second = await collect([], home);
  const fresh = second.find((r) => r.text === "typed in the newer session");
  assert.ok(fresh, "a prompt written after the first read must appear");
  assert.equal(fresh.cwd, "/work/started-just-now", "and carry its own session's directory");

  await drop(home);
});

test("a truncated or malformed line is skipped, not fatal", async () => {
  // Agents append to these files continuously. A reader that throws on a
  // half-written last line is a reader that fails whenever it is most useful.
  const home = await fixture({ opencode: false });
  const rows = await collect([], home);
  assert.ok(rows.length >= 3, "the good records either side of the bad line survive");
  assert.ok(!rows.some((r) => r.text.includes("truncated mid-writ")));
  await drop(home);
});

test("opencode reads the prompt from its parts, not the message", async () => {
  // The regression this pins: `summary` on a user message is an object, so a
  // reader that expects text there returns nothing — and nothing is
  // indistinguishable from "this agent has no prompts yet".
  const home = await fixture({ claude: false, codex: false });
  const rows = await collect([], home);

  assert.equal(rows.length, 1, "the assistant's reply is in the same folder and is not ours");
  assert.equal(rows[0].text, "add the rate limit\nto the api gateway",
    "every text part is joined, in written order, and non-text parts are skipped");
  assert.equal(rows[0].agent, "opencode");
  assert.equal(rows[0].project, "beacon-api");
  assert.equal(rows[0].at, 1_700_000_070, "ms to seconds");

  await drop(home);
});

test("an opencode message with no text parts yields nothing, not a blank row", async () => {
  const home = await fixture({ claude: false, codex: false });
  const rows = await collect([], home);
  assert.ok(!rows.some((r) => !r.text.trim()), "a partless message must not become an empty prompt");
  await drop(home);
});

test("every installed agent is read, and they come back merged", async () => {
  const home = await fixture();
  const rows = await collect([], home);
  const agents = new Set(rows.map((r) => r.agent));
  assert.deepEqual([...agents].sort(), ["claude", "codex", "opencode"]);
  await drop(home);
});

test("a missing agent is a normal state, not an error", async () => {
  // Nobody has every agent installed. This is the case that would otherwise
  // throw ENOENT on someone else's laptop the first time they run it.
  const home = await fixture({ claude: false, codex: false, opencode: false });
  assert.deepEqual(await detect(home), []);
  assert.deepEqual(await collect([], home), []);
  await drop(home);
});

test("detect finds exactly the agents present", async () => {
  const home = await fixture({ codex: false });
  const names = (await detect(home)).map((s) => s.name).sort();
  assert.deepEqual(names, ["claude", "opencode"]);
  assert.equal(SOURCES.length, 3, "detect must consider every known source");
  await drop(home);
});

test("collect can be narrowed to one agent", async () => {
  const home = await fixture();
  const rows = await collect(["codex"], home);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.agent === "codex"));
  await drop(home);
});
