/**
 * Tests for the part that has behaviour worth pinning: search and dedupe.
 *
 * The source readers are deliberately not mocked. They are thin file readers
 * over formats owned by other projects, and a mock of a format you do not
 * control tests only that you remembered your own mock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { join, sep } from "node:path";

import { search, keep, flatten, inScope } from "../src/search.js";

const p = (agent, at, text, project = "") => ({ agent, at, project, text });

test("every term must match, in any order", () => {
  const rows = [
    p("claude", 3, "fix the failing portal test"),
    p("codex", 2, "test the portal fix"),
    p("claude", 1, "run the portal"),
  ];
  const { rows: hits } = search(rows, { terms: ["portal", "fix"] });
  assert.equal(hits.length, 2, "order must not matter");
  assert.ok(hits.every((h) => /portal/.test(h.text) && /fix/.test(h.text)));
});

test("identical prompts collapse to one row carrying a count", () => {
  // Not "go": that is under the length floor and is dropped before dedupe runs,
  // which is correct — nobody searches for a two-letter prompt — but it makes
  // the wrong assertion fail for the right reason.
  const same = "run the tests and fix what breaks";
  const rows = [p("claude", 1, same), p("claude", 5, same), p("codex", 3, same)];
  const { rows: hits, matched } = search(rows);
  assert.equal(matched, 1, "typing the same thing thrice is one result");
  assert.equal(hits[0].count, 3);
  assert.equal(hits[0].at, 5, "the newest sighting wins, because reuse means the last one");
  assert.equal(hits[0].agent, "claude", "and it carries that sighting's agent");
});

test("prompts too short to be worth recalling never reach the results", () => {
  // "go", "ok" and "yes" are real prompts and useless to search for. Dropping
  // them is what keeps a 20,000-row index readable.
  const { matched } = search([p("claude", 1, "go"), p("claude", 2, "ok")]);
  assert.equal(matched, 0);
});

test("newest first, so the freshest prompt is never buried", () => {
  const { rows } = search([p("claude", 1, "older one"), p("claude", 9, "newer one")]);
  assert.equal(rows[0].text, "newer one");
});

test("multi-line prompts become one row", () => {
  const { rows } = search([p("claude", 1, "first line\n\n  second line  ")]);
  assert.equal(rows[0].text, "first line second line");
  assert.equal(flatten("a\n b \tc"), "a b c");
});

test("slash commands and noise are not prompts anyone wants back", () => {
  assert.equal(keep("/clear"), false, "a slash command is not a prompt to reuse");
  assert.equal(keep("!ls"), false);
  assert.equal(keep("ok"), false, "too short to be worth recalling");
  assert.equal(keep("<system-reminder>do a thing</system-reminder>"), false);
  assert.equal(keep("write the migration"), true);
});

test("limit caps the rows but never the reported total", () => {
  const many = Array.from({ length: 50 }, (_, i) => p("claude", i, `prompt number ${i}`));
  const { rows, matched } = search(many, { limit: 5 });
  assert.equal(rows.length, 5);
  assert.equal(matched, 50, "the count must describe the search, not the page");
});

test("an empty search returns everything, newest first", () => {
  const { rows } = search([p("claude", 1, "alpha prompt"), p("codex", 2, "beta prompt")]);
  assert.deepEqual(rows.map((r) => r.text), ["beta prompt", "alpha prompt"]);
});

// Scoping had no unit tests at all — only one end-to-end CLI case — and the
// consequence was a separator bug that reached CI: on Windows a prompt typed in
// a subdirectory never matched its own project, because the check appended "/"
// to a path built from "\". These build their paths with `join`, so they speak
// whatever separator the machine running them uses.
test("a subdirectory belongs to the project above it", () => {
  const root = join("code", "atlas");
  assert.equal(inScope(root, root), true, "the root is in its own scope");
  assert.equal(inScope(join(root, "src"), root), true);
  assert.equal(inScope(join(root, "src", "deep", "nested"), root), true);
});

test("a sibling that merely starts the same is a different project", () => {
  // The case a plain prefix match gets wrong: "atlas" must not claim
  // "atlas-backup", which shares every character of the shorter name.
  assert.equal(inScope(join("code", "atlas-backup"), join("code", "atlas")), false);
  assert.equal(inScope(join("code", "atlas"), join("code", "atlas-backup")), false);
});

test("no scope means everything, and no cwd means nothing", () => {
  // A prompt with no recorded directory cannot be shown to belong here, and
  // assuming it does is what puts another client's work on the screen.
  assert.equal(inScope(join("code", "atlas"), null), true);
  assert.equal(inScope("", join("code", "atlas")), false);
});

test("scope filters the search, not merely the paths", () => {
  const here = join("code", "atlas");
  const rows = [
    { ...p("claude", 3, "prompt from atlas"), cwd: here },
    { ...p("claude", 2, "prompt from a subfolder"), cwd: join(here, "src") },
    { ...p("codex", 1, "prompt from another client"), cwd: join("code", "secret") },
  ];
  assert.deepEqual(
    search(rows, { scope: here }).rows.map((r) => r.text),
    ["prompt from atlas", "prompt from a subfolder"],
    `a subfolder must survive scoping (the separator here is "${sep}")`,
  );
  assert.equal(search(rows, {}).matched, 3, "without a scope nothing is hidden");
});
