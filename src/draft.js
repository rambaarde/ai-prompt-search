/**
 * What you have typed but not yet sent.
 *
 * A prompt only reaches disk when you press Return — that is the whole reason
 * the picker can find your history at all. It also means the thing most worth
 * keeping, the half-written prompt you abandoned when you changed your mind, is
 * the one thing no agent records anywhere.
 *
 * The wrapper is already the only piece of software that can see it. It sits in
 * the pty between the terminal and the agent, so every byte on its way to the
 * input line passes through here first. This keeps a running copy of that line.
 *
 * **It is a line editor, not a terminal emulator.** It tracks what the common
 * edits do — typing, backspace, kill-line, kill-word, paste — and it knows when
 * it has been left behind. Recalling an earlier prompt with the up arrow
 * replaces the line with text that never came through the keyboard, so the copy
 * here is simply wrong at that point. Rather than offer you something you did
 * not type, it marks itself unknown and stays quiet until the next Return.
 *
 * Cursor movement is deliberately not tracked. Typing into the middle of a line
 * after moving left lands at the end of this copy instead, which reorders the
 * text without losing any of it — a small, rare inaccuracy, and a much better
 * trade than the state machine that would avoid it.
 *
 * Agent-agnostic by construction: these are bytes on a wire, and nothing here
 * knows or cares whether the far end is Claude, Codex or opencode.
 */

const RETURN = 0x0d;
const NEWLINE = 0x0a;
const INTERRUPT = 0x03; // ctrl-c
const KILL_LINE = 0x15; // ctrl-u
const KILL_WORD = 0x17; // ctrl-w
const BACKSPACE = 0x7f;
const BACKSPACE_ALT = 0x08;
const ESC = 0x1b;

/** Nothing typed yet. */
export const EMPTY = { bytes: [], known: true, pasting: false };

/**
 * The draft as text, or "" when this copy cannot be trusted.
 *
 * Callers get one value to check rather than a flag to remember, because a
 * caller that forgets the flag shows the user the wrong prompt.
 */
export const draftText = (state) => draftRaw(state).trim();

/**
 * The draft exactly as typed, trailing spaces and all.
 *
 * Clearing the agent's line means sending one backspace per character, so it
 * has to count what is really there rather than the tidied copy that gets
 * saved. Off by the two spaces you left at the end is a line not fully cleared.
 */
export const draftRaw = (state) =>
  state.known ? Buffer.from(state.bytes).toString("utf8") : "";

/** Drop one character, not one byte — a multi-byte character is one keypress. */
function popChar(bytes) {
  while (bytes.length && (bytes[bytes.length - 1] & 0b1100_0000) === 0b1000_0000) bytes.pop();
  bytes.pop();
}

/** Drop trailing spaces, then the word before them, the way ctrl-w does. */
function popWord(bytes) {
  while (bytes.length && bytes[bytes.length - 1] === 0x20) bytes.pop();
  while (bytes.length && bytes[bytes.length - 1] !== 0x20) popChar(bytes);
}

/**
 * Find the end of an escape sequence, and say what kind it was.
 *
 * Only three kinds matter. Bracketed paste has to be recognised because the
 * text inside it may contain newlines, which outside a paste mean "sent". The
 * up and down arrows have to be recognised because they replace the line behind
 * our back. Everything else is skipped whole — a sequence is not text, and
 * letting its bytes fall through to the buffer is how a draft ends up with
 * `[200~` in it.
 *
 * @returns {{end: number, kind: "paste-start"|"paste-end"|"history"|"other"}}
 */
function escape(buf, start) {
  const at = (i) => (i < buf.length ? buf[i] : -1);

  // CSI: ESC [ params ; ... final, where final is 0x40-0x7e.
  if (at(start + 1) === 0x5b) {
    let i = start + 2;
    while (i < buf.length && buf[i] >= 0x20 && buf[i] <= 0x3f) i++;
    const final = at(i);
    const params = buf.toString("latin1", start + 2, i);
    if (final === 0x7e && params === "200") return { end: i, kind: "paste-start" };
    if (final === 0x7e && params === "201") return { end: i, kind: "paste-end" };
    // 0x41 'A' is up, 0x42 'B' is down. With no parameters they are the arrows;
    // with them they are cursor movement commands the agent sent, not keys.
    if ((final === 0x41 || final === 0x42) && params === "") return { end: i, kind: "history" };
    return { end: Math.min(i, buf.length - 1), kind: "other" };
  }

  // SS3: ESC O <char> — the same arrows in application cursor mode, which is
  // what a full-screen agent usually switches the terminal into.
  if (at(start + 1) === 0x4f) {
    const final = at(start + 2);
    if (final === 0x41 || final === 0x42) return { end: start + 2, kind: "history" };
    return { end: start + 2, kind: "other" };
  }

  // A lone ESC, or ESC + one character (alt-something).
  return { end: at(start + 1) === -1 ? start : start + 1, kind: "other" };
}

/**
 * Fold one chunk of keyboard input into the draft.
 *
 * Pure, and takes the whole chunk rather than a byte, because a terminal
 * delivers a paste as one write and an escape sequence must be read as a unit.
 *
 * @param {{bytes: number[], known: boolean, pasting: boolean}} state
 * @param {Buffer} buf bytes on their way to the agent
 */
export function feed(state, buf) {
  const bytes = state.bytes.slice();
  let { known, pasting } = state;

  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];

    if (b === ESC) {
      const seq = escape(buf, i);
      i = seq.end;
      if (seq.kind === "paste-start") pasting = true;
      else if (seq.kind === "paste-end") pasting = false;
      else if (seq.kind === "history") {
        // The line now holds something we never saw typed.
        bytes.length = 0;
        known = false;
      }
      continue;
    }

    // Inside a paste every byte is content, including the newlines that would
    // otherwise read as "this prompt was sent".
    if (pasting) {
      bytes.push(b);
      continue;
    }

    if (b === RETURN || b === NEWLINE || b === INTERRUPT || b === KILL_LINE) {
      // Sent, cancelled or killed: either way the line is empty again, and
      // whatever we had lost track of no longer matters.
      bytes.length = 0;
      known = true;
      continue;
    }
    if (b === BACKSPACE || b === BACKSPACE_ALT) { popChar(bytes); continue; }
    if (b === KILL_WORD) { popWord(bytes); continue; }
    if (b < 0x20) continue; // any other control byte is a command, not text

    bytes.push(b);
  }

  return { bytes, known, pasting };
}
