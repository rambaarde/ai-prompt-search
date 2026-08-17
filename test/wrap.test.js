/**
 * Recognising the hotkey, whatever the terminal decided it is.
 *
 * These exist because the first version matched one byte, 0x10, and appeared to
 * work — under tmux, which normalises modified keys back to the legacy encoding
 * before a pane ever sees them. In a terminal speaking the Kitty keyboard
 * protocol the same keypress arrives as an escape sequence, no match is found,
 * and the byte is forwarded to the agent, which handles ctrl-p itself. The
 * feature is then perfectly broken: nothing opens, and the agent does something
 * plausible instead, so it reads as "the hotkey does nothing".
 *
 * Testing inside a multiplexer is what hid it, so the encodings are pinned here
 * rather than in a harness that only speaks one of them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isHotkey, passthrough } from "../src/wrap.js";

const bytes = (s) => Buffer.from(s, "latin1");

test("the legacy control byte is the hotkey", () => {
  // What a terminal sends when nothing has negotiated anything fancier, and
  // what tmux hands to a pane regardless.
  assert.equal(isHotkey(bytes("\x10")), true);
});

test("the Kitty keyboard protocol form is the hotkey", () => {
  // ESC [ keycode ; modifiers u — 112 is 'p', modifiers are 1 + a bitmask
  // where 4 is control, so ctrl alone is 5.
  assert.equal(isHotkey(bytes("\x1b[112;5u")), true);
  assert.equal(isHotkey(bytes("\x1b[112;7u")), true, "ctrl+alt still has the ctrl bit");
});

test("xterm's modifyOtherKeys form is the hotkey", () => {
  assert.equal(isHotkey(bytes("\x1b[27;5;112~")), true);
});

test("keys that are not ctrl-p are forwarded untouched", () => {
  // Far more important than recognising the hotkey: this sits on the keyboard
  // during real work, and swallowing a keystroke mid-conversation is worse
  // than having no hotkey at all.
  assert.equal(isHotkey(bytes("p")), false);
  assert.equal(isHotkey(bytes("\x0e")), false, "ctrl-n");
  assert.equal(isHotkey(bytes("\x1b[110;5u")), false, "ctrl-n, kitty form");
  assert.equal(isHotkey(bytes("\x1b[112;1u")), false, "plain p with no modifier");
  assert.equal(isHotkey(bytes("\x1b[A")), false, "up arrow");
  assert.equal(isHotkey(bytes("\x1b")), false, "a bare escape");
  assert.equal(isHotkey(bytes("")), false, "nothing at all");
});

test("under herdr the agent is run directly, so herdr can still see it", () => {
  // The bug this fixes: `aps install` aliases claude to `aps run claude`, the
  // pty moves claude onto a tty of its own, and herdr — which names the agent
  // in a pane from that pane's foreground processes — sees only `node`. Agents
  // that showed up before installing aps stopped showing up after.
  assert.equal(passthrough({ HERDR_ENV: "1" }), "herdr");
  assert.equal(passthrough({ APS_WRAPPED: "1" }), "wrapped");
  assert.equal(passthrough({}), null, "a plain terminal has nothing above the agent");
  assert.equal(
    passthrough({ TMUX: "/tmp/tmux-501/default,1,0" }),
    null,
    "tmux has no agent panel to empty, so it keeps the wrapper it already had",
  );
});
