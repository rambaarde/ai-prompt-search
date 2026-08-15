/**
 * Turning a pile of prompts into an answer.
 *
 * Two decisions carry this file.
 *
 * **Deduplicate by text.** People retype the same instruction constantly —
 * "go", "run the tests", "fix everything". Twenty identical rows is not twenty
 * results, it is one result and a frequency. Collapsing them is what makes the
 * output readable, and the count is useful on its own: it shows what you ask
 * for most.
 *
 * **Match every term, in any order.** Nobody recalls a prompt verbatim. They
 * recall two or three words from it. AND across terms is what "I know roughly
 * what I typed" actually means; fuzzy matching would trade a precise tool for
 * an approximate one, and there is no ranking signal here worth guessing with.
 */
import { relative, isAbsolute } from "node:path";

/**
 * Filter out things that are not prompts worth getting back.
 *
 * Slash commands and shell escapes are typed at the agent but re-running one
 * from a list is never what someone means by "find my prompt". Very short
 * strings are noise for the same reason.
 */
export function keep(text) {
  const t = text.trim();
  if (t.length < 3) return false;
  if (/^[/!#]/.test(t)) return false;
  if (t.includes("<system-reminder")) return false;
  return true;
}

/** Collapse whitespace so a multi-line prompt prints as one row. */
export const flatten = (t) => t.replace(/\s+/g, " ").trim();

/**
 * Does this prompt belong to the directory you are standing in?
 *
 * Containment, so a prompt typed in a subdirectory of the repository still
 * counts as the repository's.
 *
 * Asked through `path.relative` rather than a string prefix. The prefix version
 * shipped and was wrong on Windows: it compared `C:\code\atlas\src` against
 * `C:\code\atlas` + `/`, so every prompt from a subdirectory silently vanished
 * — on the one platform none of us runs. `relative` also settles the case a
 * prefix has to special-case by hand, where `/code/atlas` must not claim
 * `/code/atlas-backup`: it answers `..\..\atlas-backup`, and anything starting
 * with `..` is somewhere else.
 */
export function inScope(cwd, root) {
  if (!root) return true;
  if (!cwd) return false;
  const rel = relative(root, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Search prompts.
 *
 * `scope` is a directory. Passing one restricts results to prompts typed there
 * or below — which is the difference between a personal tool and one that
 * spills a client's project names onto the screen while you are working on
 * something else.
 *
 * @param {Array<{agent:string,at:number,cwd:string,project:string,text:string}>} prompts
 * @param {{terms?: string[], limit?: number, scope?: string|null}} options
 * @returns {{rows: Array, matched: number}}
 */
export function search(prompts, { terms = [], limit = 40, scope = null } = {}) {
  const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const byText = new Map();

  for (const p of prompts) {
    if (scope && !inScope(p.cwd, scope)) continue;
    const text = flatten(String(p.text ?? ""));
    if (!keep(text)) continue;
    if (needles.length) {
      const low = text.toLowerCase();
      if (!needles.every((n) => low.includes(n))) continue;
    }
    const found = byText.get(text);
    if (found) {
      found.count++;
      // Keep the most recent sighting: reuse means "give me the last one".
      if (p.at > found.at) {
        found.at = p.at;
        found.agent = p.agent;
        found.project = p.project;
        found.cwd = p.cwd;
      }
    } else {
      byText.set(text, {
        text, agent: p.agent, project: p.project ?? "", cwd: p.cwd ?? "",
        at: p.at ?? 0, count: 1,
      });
    }
  }

  const rows = [...byText.values()].sort((a, b) => b.at - a.at);
  return { rows: rows.slice(0, limit), matched: rows.length };
}
