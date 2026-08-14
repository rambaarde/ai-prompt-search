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

/** A prompt, normalised across agents. */
export const prompt = (agent, at, project, text) => ({ agent, at, project, text });

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
      out.push(prompt("claude", (d.timestamp ?? 0) / 1000, lastSegment(d.project), d.display));
    }
  }
  return out;
}

/**
 * Codex: `~/.codex/history.jsonl`
 * `{ session_id, ts (seconds), text }`
 */
async function codex(base) {
  const out = [];
  for await (const d of jsonl(join(home(base), ".codex", "history.jsonl"))) {
    if (typeof d.text === "string" && d.text.trim()) {
      out.push(prompt("codex", d.ts ?? 0, "", d.text));
    }
  }
  return out;
}

/**
 * opencode: one JSON file per message under `storage/message`.
 *
 * Only `role: "user"` is ours. Note the limit, stated rather than hidden: the
 * message record carries a `summary`, not the full prompt — the body lives in
 * `storage/part/`. Joining those is a second pass this does not yet do, so
 * opencode prompts can come back abbreviated.
 */
async function opencode(base) {
  const root = join(home(base), ".local", "share", "opencode", "storage", "message");
  if (!(await exists(root))) return [];
  const out = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".json")) {
        try {
          const d = JSON.parse(await readFile(p, "utf8"));
          if (d.role !== "user") continue;
          const text = d.summary;
          if (typeof text === "string" && text.trim()) {
            out.push(prompt("opencode", (d.time?.created ?? 0) / 1000, lastSegment(d.path?.cwd), text));
          }
        } catch {
          // Skip unreadable records rather than abort the whole scan.
        }
      }
    }
  };
  await walk(root);
  return out;
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
