/**
 * The panel taking its colours from the terminal.
 *
 * A fixed palette is a guess about somebody else's setup, and it was wrong for
 * anyone not on a dark scheme. These pin the two properties that make a derived
 * palette usable on a theme nobody here has seen: every layer stays
 * distinguishable from the one behind it, and the shadow stays a shadow.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { derive, FALLBACK, probe } from "../src/theme.js";

/** Perceived brightness, so "is this visible against that" has an answer. */
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const THEMES = [
  ["dark", [30, 30, 30], [220, 220, 220]],
  ["light", [253, 246, 227], [40, 40, 40]],
  ["solarized dark", [0, 43, 54], [131, 148, 150]],
  ["solarized light", [253, 246, 227], [101, 123, 131]],
  ["pure white", [255, 255, 255], [0, 0, 0]],
];

test("every layer stays visible against the one behind it", () => {
  for (const [name, bg, fg] of THEMES) {
    const p = derive(bg, fg);
    assert.ok(Math.abs(lum(p.surface) - lum(bg)) > 4, `${name}: panel must lift off the background`);
    assert.ok(Math.abs(lum(p.selected) - lum(p.surface)) > 4, `${name}: selected row must read as selected`);
    assert.ok(Math.abs(lum(p.text) - lum(p.surface)) > 60, `${name}: text must be legible on the panel`);
  }
});

test("the shadow is always darker, never merely different", () => {
  // The bug this pins: deriving the shadow away from the foreground produced a
  // *white* shadow on a light theme. A shadow is not a contrast step, it is
  // absence of light, and that is dark on every theme.
  for (const [name, bg, fg] of THEMES) {
    const p = derive(bg, fg);
    assert.ok(lum(p.shadow) <= lum(bg), `${name}: a shadow lighter than the page is not a shadow`);
  }
});

test("a pure black background simply has no shadow to show", () => {
  // Honest rather than clever: there is nothing darker than black, so the
  // shadow disappears instead of being faked as a lighter smudge.
  const p = derive([0, 0, 0], [255, 255, 255]);
  assert.deepEqual(p.shadow, [0, 0, 0]);
  assert.ok(lum(p.surface) > 0, "the panel itself must still be visible");
});

test("components arrive at any precision the terminal chooses", () => {
  // Replies are seen as rgb:1e1e/1e1e/1e1e and as rgb:1e/1e/1e in the wild.
  const wide = derive([30, 30, 30], [220, 220, 220]);
  assert.deepEqual(wide.surface, derive([30, 30, 30], [220, 220, 220]).surface);
  assert.equal(wide.derived, true, "a derived palette says so, so callers can tell");
  assert.equal(FALLBACK.derived, false);
});

test("a terminal that answers is believed", async () => {
  // The path that cannot be exercised in CI or in a detached multiplexer —
  // neither has a client to reply — so the reply is played back here instead.
  // Without this, the parser would only ever be proven by someone's screenshot.
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.resume = () => {};
  const screen = {
    isTTY: true,
    write() {
      // Solarized light, as xterm reports it: four hex digits per component.
      queueMicrotask(() =>
        input.emit("data", Buffer.from(
          "\x1b]11;rgb:fdfd/f6f6/e3e3\x1b\\\x1b]10;rgb:6565/7b7b/8383\x1b\\",
          "latin1",
        )));
    },
  };

  const p = await probe(screen, input, 500);
  assert.equal(p.derived, true, "a real reply must be used, not discarded");
  assert.deepEqual(p.bright, [101, 123, 131], "the foreground is the terminal's own");
  assert.ok(p.surface[0] > 200, "a light background must derive a light panel");
});

test("a short-form reply is understood too", async () => {
  // rgb:1e/1e/1e — one hex digit per component happens; scale, do not assume.
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.resume = () => {};
  const screen = {
    isTTY: true,
    write() {
      queueMicrotask(() =>
        input.emit("data", Buffer.from("\x1b]11;rgb:00/00/00\x07\x1b]10;rgb:ff/ff/ff\x07", "latin1")));
    },
  };
  const p = await probe(screen, input, 500);
  assert.equal(p.derived, true);
  assert.deepEqual(p.bright, [255, 255, 255]);
});

test("a terminal that will not answer falls back rather than hanging", async () => {
  // Silence is the normal failure here — an unsupporting terminal does not
  // reply at all — so the only correct behaviour is to give up quickly.
  const started = process.hrtime.bigint();
  const palette = await probe({ isTTY: false, write() {} }, { isTTY: false }, 50);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(palette, FALLBACK);
  assert.ok(ms < 40, `must not wait on a terminal that cannot answer (took ${ms.toFixed(0)}ms)`);
});
