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
 * Search prompts.
 *
 * @param {Array<{agent:string,at:number,project:string,text:string}>} prompts
 * @param {{terms?: string[], limit?: number}} options
 * @returns {{rows: Array<{text:string,agent:string,project:string,at:number,count:number}>, matched: number}}
 */
export function search(prompts, { terms = [], limit = 40 } = {}) {
  const needles = terms.map((t) => t.toLowerCase()).filter(Boolean);
  const byText = new Map();

  for (const p of prompts) {
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
      }
    } else {
      byText.set(text, { text, agent: p.agent, project: p.project ?? "", at: p.at ?? 0, count: 1 });
    }
  }

  const rows = [...byText.values()].sort((a, b) => b.at - a.at);
  return { rows: rows.slice(0, limit), matched: rows.length };
}
