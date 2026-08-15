/**
 * Where each AI CLI keeps the prompts you typed.
 *
 * The important decision in this whole project is which file to read. Every
 * existing tool in this space parses **session transcripts** — megabytes of
 * assistant output, tool calls and results wrapped around the one line you
 * typed. That is why they can find a conversation but not a prompt.
 *
 * Two of these agents already keep a prompt-only file. It is the up-arrow
 * buffer, on disk, one record per prompt. Reading that instead makes the whole
 * problem small: no transcript parsing, no filtering assistant text back out,
 * and a full index of twenty thousand prompts in well under a second.
 *
 * A source is deliberately allowed to be absent. Nobody has every agent
 * installed, and a missing directory is a normal state, not an error.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The home directory to read from.
 *
 * A parameter rather than a constant so the readers can be pointed at a
 * fixture. Parsing someone else's file format is exactly the code worth
 * testing, and it cannot be tested if the path is baked in at import time.
 */
const home = (base) => base ?? homedir();

/**
 * A prompt, normalised across agents.
 *
 * `cwd` is the full working directory the prompt was typed in; `project` is
 * just its last segment, for display. The full path is kept because scoping
 * needs to know whether a prompt belongs to the repository you are standing in,
 * and two unrelated checkouts can share a basename.
 */
export const prompt = (agent, at, cwd, text) =>
  ({ agent, at, cwd: cwd ?? "", project: lastSegment(cwd), text });

const exists = (p) => stat(p).then(() => true, () => false);

/** Read a JSONL file, skipping records that do not parse rather than failing. */
async function* jsonl(path) {
  if (!(await exists(path))) return;
  const text = await readFile(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A truncated last line is normal while an agent is mid-write.
    }
  }
}

/**
 * Claude Code: `~/.claude/history.jsonl`
 * `{ display, timestamp (ms), project, sessionId }`
 */
async function claude(base) {
  const out = [];
  for await (const d of jsonl(join(home(base), ".claude", "history.jsonl"))) {
    if (typeof d.display === "string" && d.display.trim()) {
      out.push(prompt("claude", (d.timestamp ?? 0) / 1000, d.project, d.display));
    }
  }
  return out;
}

/**
 * Codex: `~/.codex/history.jsonl`
 * `{ session_id, ts (seconds), text }`
 */
async function codex(base) {
  // history.jsonl has no cwd, so the directory comes from the session rollout
  // that records it. Cheap: one first-line read per session, and there are tens
  // of these, not thousands.
  const cwdOf = await codexSessionDirs(join(home(base), ".codex", "sessions"));
  const out = [];
  for await (const d of jsonl(join(home(base), ".codex", "history.jsonl"))) {
    if (typeof d.text === "string" && d.text.trim()) {
      out.push(prompt("codex", d.ts ?? 0, cwdOf.get(d.session_id), d.text));
    }
  }
  return out;
}

/** session id -> the directory that session ran in, from the rollout header. */
async function codexSessionDirs(root) {
  const map = new Map();
  if (!(await exists(root))) return map;
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.name.startsWith("rollout-") || !e.name.endsWith(".jsonl")) continue;
      try {
        const head = (await readFile(p, "utf8")).split("\n", 1)[0];
        const d = JSON.parse(head);
        const rec = d.payload ?? d;
        if (rec.id && rec.cwd) map.set(rec.id, rec.cwd);
      } catch {
        // A session without a readable header simply has no directory.
      }
    }
  };
  await walk(root);
  return map;
}

/**
 * opencode: a message and its text are two different files.
 *
 *   storage/message/<session>/<msgId>.json   { id, role, time, summary, … }
 *   storage/part/<msgId>/<partId>.json       { type: "text", text }
 *
 * The prompt lives in the parts, never in the message. An earlier version read
 * `summary` off the message and required a string — but `summary` on a user
 * message is an object (`{ diffs: [] }`), so the check silently rejected every
 * record and opencode contributed nothing at all. It looked like a working
 * integration precisely because "no rows" and "no prompts yet" are
 * indistinguishable from outside. That is the failure a fixture test catches
 * and a mock never would.
 *
 * A message can hold several text parts; they are joined in id order, which is
 * the order they were written.
 */
async function opencode(base) {
  const root = join(home(base), ".local", "share", "opencode", "storage");
  const messages = join(root, "message");
  if (!(await exists(messages))) return [];

  const out = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(p);
        continue;
      }
      if (!e.name.endsWith(".json")) continue;
      try {
        const d = JSON.parse(await readFile(p, "utf8"));
        if (d.role !== "user" || !d.id) continue;
        const text = await partsText(join(root, "part", d.id));
        if (text) {
          out.push(prompt("opencode", (d.time?.created ?? 0) / 1000, d.path?.cwd, text));
        }
      } catch {
        // Skip unreadable records rather than abort the whole scan.
      }
    }
  };
  await walk(messages);
  return out;
}

/** Join the text parts of one opencode message, in written order. */
async function partsText(dir) {
  if (!(await exists(dir))) return "";
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  const chunks = [];
  for (const f of files) {
    try {
      const part = JSON.parse(await readFile(join(dir, f), "utf8"));
      if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
        chunks.push(part.text);
      }
    } catch {
      // One unreadable part must not lose the rest of the prompt.
    }
  }
  return chunks.join("\n").trim();
}

/** Last path segment: `/Users/x/code/atlas-web` -> `atlas-web`. */
const lastSegment = (p) => (typeof p === "string" ? p.split("/").filter(Boolean).pop() ?? "" : "");

/** Every source, with the directory that proves the agent is installed. */
export const SOURCES = [
  { name: "claude", label: "Claude Code", dir: (b) => join(home(b), ".claude"), read: claude },
  { name: "codex", label: "Codex", dir: (b) => join(home(b), ".codex"), read: codex },
  { name: "opencode", label: "opencode", dir: (b) => join(home(b), ".local", "share", "opencode"), read: opencode },
];

/**
 * Which agents are actually on this machine.
 *
 * Detected rather than configured. Asking someone to list their agents is
 * asking them to maintain a list that the filesystem already knows, and to
 * update it every time they try a new tool.
 */
export async function detect(base) {
  const found = await Promise.all(
    SOURCES.map(async (s) => ((await exists(s.dir(base))) ? s : null)),
  );
  return found.filter((s) => s !== null);
}

/** Read every detected agent, or the ones named. */
export async function collect(only = [], base) {
  const sources = (await detect(base)).filter((s) => only.length === 0 || only.includes(s.name));
  const lists = await Promise.all(sources.map((s) => s.read(base)));
  return lists.flat();
}
