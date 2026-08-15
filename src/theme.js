/**
 * Taking the palette from the terminal instead of inventing one.
 *
 * The panel used a fixed 256-colour palette chosen to look like a dark surface.
 * That is a guess, and it is wrong for anyone on a light theme, on Solarized, or
 * on anything with an unusual background — the panel either disappears into the
 * session or sits on it like a foreign object.
 *
 * Terminals will simply say what their colours are. `OSC 11 ; ? BEL` asks for
 * the background and `OSC 10 ; ? BEL` for the foreground, and the reply comes
 * back on stdin as `rgb:RRRR/GGGG/BBBB`. Everything the panel needs is then
 * derived from those two: a surface a little away from the background, a
 * selected row a little further, text at the terminal's own foreground.
 *
 * Deriving rather than sampling matters. Mixing towards the foreground means the
 * panel lifts off a dark background and settles into a light one automatically,
 * with no branch on "is this a dark theme" — the same arithmetic does both,
 * because the foreground is always the direction of contrast.
 *
 * Not every terminal answers. Some ignore it, and a multiplexer may swallow the
 * reply. So the probe is time-boxed and falls back to the fixed palette, which
 * is what shipped before and is a reasonable dark default.
 */

const OSC_BG = "\x1b]11;?\x07";
const OSC_FG = "\x1b]10;?\x07";

/** `rgb:1e1e/1e1e/1e1e` and the 8-bit form both appear in the wild. */
const REPLY = /\x1b\]1([01]);rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/gi;

/** A component may be 1–4 hex digits; scale whatever arrives to 0–255. */
function component(hex) {
  const v = parseInt(hex, 16);
  const max = 16 ** hex.length - 1;
  return Math.round((v / max) * 255);
}

/** Blend two colours. `t` of 0 is all `a`, 1 is all `b`. */
const mix = (a, b, t) => a.map((c, i) => Math.round(c + (b[i] - c) * t));

/**
 * The palette used when the terminal will not say, or is not asked.
 *
 * The same values the panel shipped with: a dark surface that reads as laid
 * over the session rather than part of it.
 */
export const FALLBACK = {
  surface: [38, 38, 38],
  selected: [58, 58, 58],
  shadow: [18, 18, 18],
  rule: [58, 58, 58],
  text: [216, 216, 216],
  bright: [255, 255, 255],
  muted: [150, 150, 150],
  faint: [110, 110, 110],
  caret: [190, 190, 190],
  derived: false,
};

/**
 * Build a panel palette from the terminal's own background and foreground.
 *
 * The mix fractions are the whole design. Small ones keep the panel clearly
 * related to the terminal's colours rather than becoming a separate scheme;
 * large enough that the surface, the selected row and the shadow stay distinct
 * from each other and from the session behind them.
 */
export function derive(bg, fg) {
  return {
    surface: mix(bg, fg, 0.1),
    selected: mix(bg, fg, 0.24),
    // Always toward black, never away from the foreground. Mixing away from the
    // text derives a *white* shadow on a light theme, which is invisible, and
    // the reason is that a shadow is not a contrast step — it is absence of
    // light, and absence of light is dark on every theme there is. On a pure
    // black background it correctly disappears, because there is no darker.
    shadow: mix(bg, [0, 0, 0], 0.4),
    rule: mix(bg, fg, 0.28),
    text: mix(fg, bg, 0.1),
    bright: fg,
    muted: mix(fg, bg, 0.4),
    faint: mix(fg, bg, 0.62),
    caret: mix(fg, bg, 0.25),
    derived: true,
  };
}

/**
 * Ask the terminal for its colours.
 *
 * Time-boxed on purpose: a terminal that does not implement this says nothing
 * at all, so there is no failure to detect, only a silence to give up on. The
 * listener is removed either way, because this runs on a stdin that other code
 * is about to want.
 *
 * @param {NodeJS.WriteStream} screen where to write the query
 * @param {NodeJS.ReadStream} input where the answer arrives
 * @param {number} timeout milliseconds to wait before giving up
 */
export function probe(screen, input = process.stdin, timeout = 120) {
  return new Promise((resolve) => {
    if (!input.isTTY || !screen.isTTY) return resolve(FALLBACK);

    let seen = "";
    let done = false;
    const raw = input.isRaw;

    const finish = (palette) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off("data", onData);
      if (!raw) input.setRawMode?.(false);
      resolve(palette);
    };

    const onData = (buf) => {
      seen += buf.toString("latin1");
      const found = {};
      for (const m of seen.matchAll(REPLY)) {
        found[m[1] === "1" ? "bg" : "fg"] = [component(m[2]), component(m[3]), component(m[4])];
      }
      if (found.bg && found.fg) finish(derive(found.bg, found.fg));
    };

    const timer = setTimeout(() => finish(FALLBACK), timeout);

    input.setRawMode?.(true);
    input.resume();
    input.on("data", onData);
    screen.write(OSC_BG + OSC_FG);
  });
}
