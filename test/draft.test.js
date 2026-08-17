/**
 * Tests for the draft tracker.
 *
 * This is the one piece of the feature with a way to be subtly wrong: it
 * reconstructs the agent's input line from the bytes flowing past it, and a
 * reconstruction that is quietly off shows you a prompt you never typed. So the
 * cases here are the ones where a naive "append every printable byte" is wrong
 * — escape sequences, pastes containing newlines, multi-byte characters, and
 * the up arrow, which replaces the line with something the keyboard never sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { EMPTY, feed, draftText, draftRaw } from "../src/draft.js";

/**
 * Type a sequence of chunks, as a terminal would deliver them.
 *
 * UTF-8, because that is what a terminal actually sends: encoding `café` as
 * latin1 makes `é` one byte, which is the very thing the byte-vs-character
 * cases below exist to catch, and would let a broken tracker pass.
 */
const type = (...chunks) =>
  chunks.reduce((state, c) => feed(state, Buffer.isBuffer(c) ? c : Buffer.from(c, "utf8")), EMPTY);

const esc = (s) => Buffer.from(`\x1b${s}`, "latin1");

test("what you type is what the draft holds", () => {
  assert.equal(draftText(type("fix the auth bug")), "fix the auth bug");
});

test("a submitted prompt leaves no draft behind", () => {
  // The prompt is in the agent's own history the moment Return is pressed, so
  // keeping a copy here would offer you every prompt twice.
  assert.equal(draftText(type("fix the auth bug\r")), "");
  assert.equal(draftText(type("fix the auth bug\r", "next one")), "next one");
});

test("ctrl-c and ctrl-u empty the line", () => {
  assert.equal(draftText(type("abandon this\x03")), "");
  assert.equal(draftText(type("abandon this\x15")), "");
});

test("backspace removes a character, not a byte", () => {
  // A multi-byte character arrives as several bytes but is one keypress, so
  // popping bytes would leave half a character and a mojibake draft.
  assert.equal(draftText(type("café\x7f")), "caf");
  assert.equal(draftText(type("日本語\x7f")), "日本");
  assert.equal(draftText(type("hello\x7f\x7f")), "hel");
});

test("ctrl-w removes the last word", () => {
  assert.equal(draftText(type("deploy to staging\x17")), "deploy to");
  assert.equal(draftText(type("trailing spaces   \x17")), "trailing");
});

test("multi-byte characters survive intact", () => {
  assert.equal(draftText(type("café über 日本語")), "café über 日本語");
});

test("an escape sequence is skipped whole, not typed into the draft", () => {
  // The bug this pins: letting the bytes of a sequence fall through leaves
  // `[C` or `[200~` sitting in the middle of your prompt.
  const state = type("before", esc("[C"), "after");
  assert.equal(draftText(state), "beforeafter");
  assert.ok(!draftText(state).includes("["));
});

test("a paste keeps its newlines instead of reading as sent", () => {
  // Bracketed paste is why this cannot just watch for \r: the text inside one
  // may contain newlines, and treating those as Return would drop the paste.
  const state = type(esc("[200~"), "line one\nline two", esc("[201~"));
  assert.equal(draftText(state), "line one\nline two");
});

test("a paste's own markers never reach the draft", () => {
  const state = type("see: ", esc("[200~"), "pasted", esc("[201~"), " done");
  assert.equal(draftText(state), "see: pasted done");
});

test("recalling history with the up arrow makes the draft unknown", () => {
  // Up-arrow puts a previous prompt in the box. Those characters never came
  // through the keyboard, so the copy here is wrong — and showing you a prompt
  // you did not type is worse than showing you nothing.
  assert.equal(draftText(type("half a thought", esc("[A"))), "");
  assert.equal(draftText(type("half a thought", esc("OB"))), "",
    "the same arrows in application cursor mode, which agents switch on");
});

test("the next Return makes the draft trustworthy again", () => {
  // Unknown must not be a one-way door: submitting empties the real line too,
  // so from that point the copy is accurate again.
  const state = type("half a thought", esc("[A"), "\r", "a fresh one");
  assert.equal(draftText(state), "a fresh one");
});

test("a cursor-movement report from the agent is not the up arrow", () => {
  // `ESC [ 1 A` is a program moving the cursor, not a key. Treating parameterised
  // sequences as history would blank the draft during ordinary redrawing.
  assert.equal(draftText(type("still here", esc("[1A"))), "still here");
});

test("the raw draft keeps trailing spaces the saved one drops", () => {
  // Clearing the agent's line sends one backspace per character, so the count
  // has to match what is really in the box, not the tidied copy.
  const state = type("two spaces  ");
  assert.equal(draftText(state), "two spaces");
  assert.equal(draftRaw(state), "two spaces  ");
  assert.equal([...draftRaw(state)].length, 12);
});

test("control bytes that are not edits are commands, not text", () => {
  assert.equal(draftText(type("tab\there")), "tabhere");
});
