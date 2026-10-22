// Excerpt from the production codebase (src/lib/menu-match.ts), shared here
// as a representative, self-contained sample. See the root README's
// "Engineering Challenges & Solutions" section for context — this is the
// piece that lets AI-extracted item text turn into a trusted database price.

/**
 * Matches free-text item names from WhatsApp / Instagram / phone notes
 * ("2 jollof", "fried rice n chicken", "dodo", "meatpies") to menu items,
 * using each item's name plus its comma-separated `aliases`.
 *
 * Pure functions, no database access — callers pass the menu in. Safe to
 * import from server and client code.
 *
 * Order of preference: exact name → exact alias → phrase contained either
 * way → token-overlap score (with a 1-typo allowance on longer words).
 * Returns null when nothing is a plausible match.
 */

export type MatchableMenuItem = {
  id: string;
  name: string;
  aliases: string | null;
  priceKobo: number;
  category?: string | null;
};

export type MatchMethod = "exact" | "alias" | "contains" | "tokens";

export type MenuMatch<T extends MatchableMenuItem = MatchableMenuItem> = {
  item: T;
  /** 0–1. ≥ CONFIDENT_MATCH is safe to accept without a human look. */
  confidence: number;
  method: MatchMethod;
};

/** Matches at or above this are treated as certain; below it staff should check. */
export const CONFIDENT_MATCH = 0.75;
/** Anything scoring below this is reported as unmatched. */
const MIN_MATCH = 0.45;

// Words that carry no meaning for "which dish is this".
const STOPWORDS = new Set([
  "and", "with", "of", "the", "a", "an", "some", "my", "for", "me", "i", "want", "need", "get", "give",
  "please", "pls", "plz", "abeg", "biko", "order", "orders", "plate", "plates", "portion", "portions",
  "pack", "packs", "pc", "pcs", "piece", "pieces", "wrap", "wraps", "serving", "servings", "x", "side",
  "sides", "extra", "add", "also", "then", "one", "just", "only", "like", "id", "would", "to", "have",
  "can", "you", "u", "o", "oh", "sir", "ma", "big", "small", "medium", "large", "cl", "50cl", "35cl",
]);

/** Lowercases, turns & / + / "n" / "w/" into "and", strips punctuation and collapses spaces. */
export function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents: jollóf → jollof
    .replace(/&/g, " and ")
    .replace(/\+/g, " and ")
    .replace(/\bw\//g, " with ")
    .replace(/['’`]/g, "") // "mama's" → "mamas"
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(n|nd|an)\b/g, "and")
    .replace(/\s+/g, " ")
    .trim();
}

function stem(token: string): string {
  if (token.length > 3 && token.endsWith("es") && /(ch|sh|x|ss)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/** Meaningful tokens: normalised, stopwords and bare numbers removed, plurals stemmed. */
export function contentTokens(input: string): string[] {
  return normalizeText(input)
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

function tokensEqual(a: string, b: string): boolean {
  if (a === b) return true;
  // One typo allowed on longer words: "jellof", "friedd", "chiken".
  return a.length >= 5 && b.length >= 5 && editDistanceAtMostOne(a, b);
}

function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let k = 0; k < needle.length; k++) if (!tokensEqual(haystack[i + k], needle[k])) continue outer;
    return true;
  }
  return false;
}

type Candidate = { tokens: string[]; squashed: string; isName: boolean };

function candidatesFor(item: MatchableMenuItem): Candidate[] {
  const phrases = [item.name, ...(item.aliases ?? "").split(",")]
    .map((p) => p.trim())
    .filter(Boolean);
  // Also try the name without a bracketed suffix: "Zobo (50cl)" → "Zobo".
  const bare = item.name.replace(/\([^)]*\)/g, "").trim();
  if (bare && bare !== item.name) phrases.push(bare);
  return phrases
    .map((p, i) => {
      const tokens = contentTokens(p);
      return { tokens, squashed: tokens.join(""), isName: i === 0 };
    })
    .filter((c) => c.tokens.length > 0);
}

function scoreCandidate(query: string[], querySquashed: string, c: Candidate): { score: number; method: MatchMethod } {
  // Exact (ignoring spacing, so "meatpie" = "meat pie").
  if (querySquashed === c.squashed) return { score: c.isName ? 1 : 0.96, method: c.isName ? "exact" : "alias" };

  // Whole candidate phrase appears inside what the customer wrote:
  // "jollof rice and chicken abeg" contains alias "jollof rice".
  if (containsPhrase(query, c.tokens)) {
    const coverage = c.tokens.length / query.length; // how much of the text it explains
    return { score: 0.72 + 0.2 * coverage, method: "contains" };
  }
  // What they wrote appears inside the candidate: "jollof" in "jollof rice chicken".
  if (containsPhrase(c.tokens, query)) {
    const coverage = query.length / c.tokens.length;
    return { score: 0.68 + 0.2 * coverage, method: "contains" };
  }

  // Token overlap (Dice coefficient with fuzzy token equality).
  const used = new Set<number>();
  let common = 0;
  for (const q of query) {
    const idx = c.tokens.findIndex((t, i) => !used.has(i) && tokensEqual(q, t));
    if (idx >= 0) {
      used.add(idx);
      common++;
    }
  }
  if (common === 0) {
    // Last resort: squashed substring ("friedrice" vs "fried rice chicken").
    if (querySquashed.length >= 5 && c.squashed.includes(querySquashed)) return { score: 0.6, method: "tokens" };
    return { score: 0, method: "tokens" };
  }
  const dice = (2 * common) / (query.length + c.tokens.length);
  return { score: 0.8 * dice, method: "tokens" };
}

/**
 * Best menu match for a free-text item name, or null if nothing fits.
 * When two different items score almost the same (e.g. just "rice"), the
 * confidence is lowered so the order gets flagged for review.
 */
export function matchMenuItem<T extends MatchableMenuItem>(text: string, menu: readonly T[]): MenuMatch<T> | null {
  const query = contentTokens(text);
  if (query.length === 0) return null;
  const querySquashed = query.join("");

  const scored = menu
    .map((item) => {
      let best = { score: 0, method: "tokens" as MatchMethod };
      for (const c of candidatesFor(item)) {
        const s = scoreCandidate(query, querySquashed, c);
        if (s.score > best.score) best = s;
      }
      return { item, ...best };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < MIN_MATCH) return null;

  let confidence = top.score;
  const runnerUp = scored[1];
  if (runnerUp && runnerUp.item.id !== top.item.id && top.score - runnerUp.score < 0.05) {
    confidence = Math.min(confidence, CONFIDENT_MATCH - 0.1); // ambiguous — ask a human
  }
  return { item: top.item, confidence: Math.round(confidence * 100) / 100, method: top.method };
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, single: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12, fifteen: 15, twenty: 20,
};

/**
 * Pulls a quantity out of one order line: "2 jollof", "2x jollof", "jollof x2",
 * "jollof x 2", "jollof - 2", "jollof (2)", "two jollof", "jollof 2 plates".
 * Returns the remaining text as `name`. Quantity defaults to 1.
 */
export function splitQuantity(line: string): { quantity: number; name: string; explicit: boolean } {
  let s = line.trim().replace(/^[-*•·>\s]+/, "").replace(/^\d+[.)]\s+/, "").trim();

  const lead = s.match(/^(\d{1,3})\s*(?:x|×|pcs?|pieces?|plates?|packs?|portions?|wraps?|bottles?)?\s*(?:of\s+)?(.+)$/i);
  if (lead && /[a-z]/i.test(lead[2])) return { quantity: Number(lead[1]), name: lead[2].trim(), explicit: true };

  const trail = s.match(/^(.+?)\s*(?:[x×*]\s*(\d{1,3})|[-–:=]\s*(\d{1,3})|\((\d{1,3})\)|(\d{1,3})\s*(?:pcs?|pieces?|plates?|packs?|portions?|bottles?)?)\s*$/i);
  if (trail && /[a-z]/i.test(trail[1])) {
    const q = Number(trail[2] ?? trail[3] ?? trail[4] ?? trail[5]);
    // "Zobo 50cl" should not read as 50 — handled because "cl" is not in the unit list above.
    if (q > 0) return { quantity: q, name: trail[1].trim(), explicit: true };
  }

  const word = s.match(/^([a-z]+)\s+(?:x\s+)?(?:of\s+)?(.+)$/i);
  if (word && NUMBER_WORDS[word[1].toLowerCase()] != null && word[1].toLowerCase() !== "a" && word[1].toLowerCase() !== "an") {
    return { quantity: NUMBER_WORDS[word[1].toLowerCase()], name: word[2].trim(), explicit: true };
  }
  s = s.replace(/^(?:a|an)\s+/i, "");
  return { quantity: 1, name: s, explicit: false };
}
