# ai-prompt-search v1 — Product Requirements

Status: **draft, 2026-08-18.** Written after the code, not before it — v0.10.1
ships and is installed. This document exists because the product changed shape
in one release and nothing recorded what it now is.

Scope: the installable npm package `ai-prompt-search`, binary `aps` — the
readers, the search, the picker, the wrapper, and the drafts store added in
#37. Anything hosted, synced, or shared is out of scope and §9 says why.

**What changed:** until #37 this was a search tool over files other programs
wrote. It now owns a file of its own and can keep a prompt you never sent. That
makes it, in the author's words, "like a prompt library" — and that phrase is
load-bearing enough to need §0.

---

## 0. The tension this document must not hide

The product's whole advantage is that **it asks nothing of you.** You install
it, and twenty thousand prompts are searchable — because they were already on
disk, written by agents you were already using. There is no library to build, no
tagging to keep up, no folder to file into. The corpus maintains itself as a
side effect of your work.

Every prompt manager that asks you to curate ends up empty. That is the failure
mode this product was accidentally immune to, and "prompt library" is the phrase
that ends the immunity. A library implies shelves: folders, tags, favourites,
titles, descriptions, sharing, sync. Each is individually reasonable and
collectively fatal — they turn a tool you never think about into one more
inbox you fall behind on.

Two things already crossed the line, and both were right:

- **`aps` now writes.** `~/.aps/drafts.jsonl` is ours. The README's old claim —
  *"Nothing is written"* — was a trust argument, and it is now narrower:
  *your agents' files* are never written.
- **`ctrl-s` is curation.** Deciding a line is worth keeping is a filing
  decision, however cheap.

So v1's ruling is not "resist the library" but **define which kind**:

> **A library you never file into.** Capture is automatic and free. Curation is
> exactly one keystroke, on exactly one object (the unsent line), and buys
> exactly one thing (it joins the corpus). Anything that would require ongoing
> maintenance by the user is a non-goal — §9, which is the most binding section
> here.

The test for any future feature: *if the user stopped using it for three months,
would the product be worse when they came back?* Search over history: no, it
just knows more. Folders and tags: yes, they rot. Ship the first kind.

---

## 1. Product summary

One npm package, zero runtime dependencies, that makes every prompt you have
ever typed — across every AI CLI — searchable in under a second, and keeps the
ones you never sent.

```
aps                     → the picker, scoped to THIS project
aps <words>             → picker with a search already typed
aps -p / -c / --json    → print · copy newest · machine-readable
aps install             → alias your agents so ctrl-p just works
aps run claude          → run an agent with ctrl-p bound to the picker
aps --hotkey [target]   → herdr · tmux · zsh · bash bindings to paste
```

Inside a wrapped agent, **ctrl-p** opens the picker over the live session; the
prompt you choose is typed in as if you had typed it. If there is an unsent line
in the box, the picker also offers it:

```
│ draft  refactor the auth middleware…  ^s save  ^y copy  ^x clear │
```

**The thing to protect:** the first run is useful. No import, no signup, no
index build, no empty state. The corpus already exists.

---

## 2. Decisions this PRD ratifies

Made in code, recorded here so overturning one is a decision rather than a
drift.

| # | Decision | Ruling | Why |
|---|---|---|---|
| D1 | What to read | **The agents' prompt-only history files**, never session transcripts | The differentiator. Claude and Codex each keep an up-arrow buffer on disk — one record per prompt. Reading it means no transcript parsing and no filtering assistant text back out: 20k prompts in well under a second. Every competing tool parses transcripts and therefore finds *conversations* |
| D2 | Runtime | **Node ≥20, plain ESM, zero runtime dependencies** | `npx` with nothing behind it is the pitch. A dependency tree would cost more than the thing it renders |
| D3 | pty module | **`node-pty`, optional** | Only the wrapper needs it. Plain `aps` never loads it, and a platform without a prebuilt binary falls back to the tmux binding rather than failing to install |
| D4 | Agent discovery | **Detected, never configured** | If the directory is there, it is read. A configured list is a list the user must maintain — the §0 failure in miniature |
| D5 | Default scope | **The git root you are standing in** | Prompts from other clients and products stay off screen. Widening is one key (`^a`); narrowing by default is what makes it usable on a shared screen |
| D6 | Matching | **AND across terms, substring, no fuzzy** | Nobody recalls a prompt verbatim; they recall two or three words. Fuzzy would trade a precise tool for an approximate one with no ranking signal worth guessing at |
| D7 | Duplicates | **Collapse by exact text, show `×n`** | Twenty identical rows is one result and a frequency. The count is independently useful: it is a list of what you ask for most |
| D8 | Drafts storage | **Our own `~/.aps/drafts.jsonl`, as a fourth source** | ~~Append to `~/.claude/history.jsonl`~~ — tempting, since it would also populate Claude's up-arrow. Rejected: a malformed line breaks an agent's own history, the formats are undocumented, and it does not generalise across three agents that store prompts three ways |
| D9 | Draft capture | **Reconstruct the input line from the keystream** | The wrapper is the only thing that can see an unsent line — no agent writes one down. A line editor, deliberately not a terminal emulator (§5.3) |
| D10 | Under herdr | **Step aside: no pty, no ctrl-p** | herdr names the agent in a pane by reading that pane's processes; a pty hides the agent and empties its agents tab. Hiding the thing a multiplexer exists to show is a worse trade than a hotkey it can bind itself (`aps --hotkey herdr`) |
| D11 | Telemetry | **None. Not off-by-default — absent** | The pitch is "reads what is already on your machine". Shipping an analytics key is the reliably-noticed mistake |
| D12 | Licence / releases | **Apache-2.0, release-please** | Version derives from commit types; the manifest owns it |

D8 and D10 are the two worth revisiting if the product's shape changes again.

---

## 3. Users

| Who | Uses | Success looks like |
|---|---|---|
| **Developer mid-conversation** (primary) | `ctrl-p` inside a wrapped agent | Gets a prompt back in under three seconds without leaving the session or touching the mouse. Never sees another project's work |
| **Developer at a shell** | `aps`, `aps -c` | Same corpus, no agent running. Copies to clipboard and moves on |
| **Developer who changed their mind** | `^s` on the unsent line | The half-written prompt survives the interruption, and is findable months later like any other |
| **Multiplexer user** (tmux, herdr) | `aps --hotkey` | One binding to paste. Under herdr the agents tab keeps working, which matters more than the wrapper did |
| **Scripts / pipes** | `--json`, `-p` | Composes. A TUI that renders escape codes into a pipe is a tool that composes with nothing |

---

## 4. Architecture

```
sources.js   read each agent's prompt file → one normalised shape
             claude · codex · opencode · draft        (D1, D4, D8)
                 ↓
search.js    scope filter → keep() → AND terms → dedupe → newest first
                 ↓
tui.js       the picker: omnibox, transparent bordered panel, 68 cols
                 ↓
wrap.js      the pty in the middle: forwards every byte, intercepts ctrl-p,
             tracks the unsent line                          (D3, D9, D10)
draft.js     the line editor that reconstructs it
clipboard.js pbcopy · clip · xclip
```

Everything above `wrap.js` runs without a terminal and is unit-testable; that
split is what lets 77 tests cover the product without driving a TUI.

---

## 5. Data contracts

### 5.1 The normalised prompt

Every reader returns this shape, and nothing downstream knows which agent it
came from:

```js
{ agent, at /* epoch seconds */, cwd, project /* basename of cwd */, text, session }
```

`cwd` carries the full path because scoping must distinguish `/code/atlas` from
`/code/atlas-backup`; `project` is the display label.

### 5.2 The sources

| name | file | notes |
|---|---|---|
| `claude` | `~/.claude/history.jsonl` | `{ display, timestamp (ms), project, sessionId }` |
| `codex` | `~/.codex/history.jsonl` | `{ text, ts (s), session_id }` — no cwd; joined to the session rollout that records one, cached |
| `opencode` | `storage/message/**` + `storage/part/<msgId>/**` | the record and its text are separate files; the prompt is in the parts, never in `summary` |
| `draft` | `~/.aps/drafts.jsonl` | **ours.** `{ text, at, cwd }`, append-only, created on first save |

A missing source is a normal state, not an error. `~/.aps` absent simply means
no drafts yet, and `aps --agents` reports it the way it reports an uninstalled
agent.

### 5.3 The draft tracker

Reconstructs the agent's input line from bytes flowing to it. Follows: printable
input, backspace (by character, not byte), `ctrl-u`, `ctrl-w`, bracketed paste
(newlines inside a paste are content, not submission), and text `aps` itself
inserts from the picker — that last one reaches the input box without passing
the keyboard and was missed until the demo recording exposed it (#41).

**Surrenders** on up/down arrow: history recall replaces the line with text that
never came through the keyboard, so the copy is wrong. It reports empty rather
than offer a prompt you did not type, and recovers on the next Return.

Deliberately **not** tracked: cursor movement. Typing after moving left appends
at the end of our copy — text reordered, nothing lost. A rare, small inaccuracy,
much cheaper than the state machine that would avoid it.

---

## 6. Commands

| Command | Behaviour |
|---|---|
| `aps [words]` | Picker, scoped to the git root. Falls back to printing when there is no terminal, and says why |
| `aps -p / -c / -n / -a / -A / --json` | print · copy newest · row count · one agent · drop scope · machine-readable |
| `aps --agents` | What was detected, with paths |
| `aps install [name…]` | Alias each detected agent in your rc, inside a fenced block. Bare names wrap your own launcher — usually a shell function, so invisible to `PATH` and run via `zsh -ic` |
| `aps uninstall` | Restores the file |
| `aps run <cmd>` | Runs it under a pty with ctrl-p bound. Steps aside under herdr or when already wrapped |
| `aps --pick` | Panel on `/dev/tty`, chosen prompt to stdout, non-zero on escape — the primitive every binding is built on |
| `aps --hotkey [target]` | Prints herdr · tmux · zsh · bash bindings |
| `aps --keys` | Prints what your terminal actually sends, and whether the wrapper would match it |

### Picker keys

| Key | Does |
|---|---|
| `↑` `↓` | move |
| `⏎` | insert into the agent (wrapped) or copy and quit (standalone) |
| `^a` | widen: this session → this project → everywhere |
| `^u` | clear the search |
| `esc` | close, immediately — read from the byte stream to skip readline's 500 ms escape disambiguation |
| `^s` `^y` `^x` | **only when a draft exists:** keep it · copy it · clear the agent's line |

---

## 7. The hotkey, on four surfaces

A running agent holds the keyboard in raw mode, so nothing outside it can inject
a keystroke. A hotkey that works *inside* a session must come from a layer below
the agent (our pty) or above it (the multiplexer). There is no single
cross-platform answer, and pretending otherwise is how this feature breaks
quietly.

| Surface | Mechanism | Trade |
|---|---|---|
| Plain terminal | `aps run` pty | Full feature, including drafts |
| tmux | `display-popup` **or** the wrapper | Wrapping costs nothing here — no agent panel to empty — so both work |
| herdr | binding only (D10) | Agents tab keeps working; **no draft row**, since there is no keystream to read |
| Shell prompt | `zle` widget / `bind -x` | Outside any agent, where the shell owns the keyboard |

ctrl-p arrives as three different byte sequences depending on terminal and
negotiated protocol (legacy `0x10`, Kitty, xterm `modifyOtherKeys`). All three
are matched; matching only the first is why this once worked under tmux and
appeared broken in a plain terminal.

---

## 8. Non-functional requirements

- **Cold picker under ~1.5 s** at 20k prompts; re-read on every open, since a
  prompt typed a minute ago must be there. Codex rollout headers are cached —
  they were 1.6 s of the budget on their own.
- **Fail open.** Anything that is not the hotkey is forwarded byte-for-byte, in
  order. A wrapper that swallows a keystroke mid-conversation is worse than no
  wrapper.
- **Fail loudly, early.** A missing pty module is reported before the agent
  starts, not three prompts in.
- **No colours of its own.** Transparent panel, terminal's palette, selection by
  reversing foreground and background — readable on any theme by definition.
- **Zero runtime dependencies**, enforced by CI.
- **Tests:** 77, `node:test`, run on ubuntu/macos/windows × node 20/22/24.
  Format parsers are covered by fixtures in the real on-disk layouts, never
  mocks — a mock of someone else's format only proves you remembered your mock.

---

## 9. Non-goals — the shelves this library does not have

Binding. Each of these is a reasonable feature request that would make the
product worse, per §0.

| Not building | Because |
|---|---|
| Folders, tags, collections | Filing is maintenance. The corpus already organises itself by project and time |
| Titles, descriptions, notes on a prompt | Turns a prompt into a document you must tend |
| Favourites / pinning | `×n` already surfaces what you actually reuse, measured rather than declared |
| Editing a saved prompt | Then it needs versions, and then it needs a UI. Save a new draft |
| Variables / templating (`{{name}}`) | A different product — prompt *authoring*, not prompt *recall*. Would justify a schema, an editor, and a runtime |
| Sync, accounts, sharing, teams | The trust argument is that nothing leaves the machine. Also: prompts carry client names and paths |
| Fuzzy search, embeddings, semantic recall | An index to build and warm, for a corpus where AND-substring already answers the question (D6) |
| A daemon or background indexer | Nothing to start, nothing to have crashed |
| Writing into agents' history files | D8 |
| Gemini CLI support | `~/.gemini/history/` holds no verifiable prompt file. Claiming coverage that does not work is worse than absence |

If several of these become genuinely necessary, that is evidence for a second
product, not for growing this one.

---

## 10. Open questions

| # | Question | Current lean |
|---|---|---|
| Q1 | Should a draft record which agent it was typed in? | Not stored today (`{text, at, cwd}`). Cheap to add, impossible to backfill — decide before the format has users |
| Q2 | Drafts have no session id, so they never appear at the narrowest scope | Acceptable: `^a` is one key. Revisit if drafts become common |
| Q3 | Is `~/.aps` the right home, versus XDG `~/.local/share/aps`? | `~/.aps` matches the `.claude` / `.codex` neighbours it sits beside. Moving it later needs a migration |
| Q4 | Should `^s` also clear the line (a "stash"), rather than needing `^x`? | Kept separate — one key, one effect. Watch whether people press both every time |
| Q5 | Up-then-down restores the in-progress line in most input widgets; the tracker throws it away | Fixable with a depth counter rather than an emulator. Not yet built |

---

## 11. Acceptance criteria

v1 is what ships today. These are the properties a change must not break.

1. **First run is useful.** A fresh install with no configuration returns real
   prompts from the current project.
2. **No empty state to fill.** Nothing asks the user to import, tag, or name
   anything before the tool works.
3. **Scope holds.** No prompt from outside the current git root appears until
   `-A` or `^a` is pressed.
4. **The keyboard is never swallowed.** Every non-hotkey byte reaches the agent,
   in order.
5. **Agents' files are only ever read.** The sole file written is
   `~/.aps/drafts.jsonl`, and only on an explicit `^s`.
6. **A draft is either correct or absent.** It is never approximately right.
7. **Absent agents are normal.** No error, no prompt to install anything.
8. **Zero runtime dependencies**, verified in CI.
9. **The hotkey is honest.** Where it cannot work (herdr), the product says so
   and prints the binding that can.
