/**
 * Pure helpers for the public college search (no database access here, so
 * everything is unit-testable).
 *
 * Search model
 * ------------
 * Every College stores `searchTokens`: the lower-cased, accent-folded words of
 * its name + district + country (e.g. "Feni Computer Institute / Feni /
 * Bangladesh" -> ["feni","computer","institute","bangladesh"]).
 *
 * A query is split the same way. A college matches when EVERY query word is a
 * PREFIX of at least one stored word. Prefix matches are anchored (`^word`), so
 * MongoDB can use the multikey index on `searchTokens` instead of scanning the
 * collection — unlike an unanchored `/word/i` regex, which cannot.
 */

export const SEARCH_LIMITS = {
  minQueryLength: 2,   // trimmed characters needed before we hit the database
  maxQueryLength: 80,  // longer input is rejected with 400
  maxTokens: 6,        // extra words are ignored (bounds query cost)
  maxTokenLength: 40,
  defaultLimit: 10,
  maxLimit: 20,
  candidatePool: 50,   // rows pulled from MongoDB before ranking in memory
};

/** Lower-case, strip accents, turn every non letter/digit into a space. */
export const foldText = (v) =>
  typeof v === "string"
    ? v
        .normalize("NFKD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim()
    : "";

/** Words of a string after folding. */
export const tokenize = (v) => {
  const folded = foldText(v);
  return folded ? folded.split(" ") : [];
};

/** Tokens stored on the College document (deduplicated, bounded). */
export const buildSearchTokens = ({ name, district, country }) => {
  const set = new Set();
  for (const part of [name, district, country]) {
    for (const t of tokenize(part)) {
      if (t.length <= SEARCH_LIMITS.maxTokenLength) set.add(t);
    }
  }
  return [...set];
};

/** Folded full name — stored as `nameKey` so results sort deterministically. */
export const buildNameKey = (name) => foldText(name);

export const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Validate + normalise raw query-string input.
 *
 * @param {{q?: unknown, limit?: unknown}} query  req.query
 * @returns {{ ok: true, empty: boolean, tokens: string[], phrase: string, limit: number }
 *         | { ok: false, message: string }}
 *   `empty: true` means "valid request, but nothing worth searching" (blank
 *   or too-short query) — the API answers 200 with an empty list, it never
 *   lists the whole collection.
 */
export const parseSearchParams = (query) => {
  const src = query && typeof query === "object" ? query : {};
  const { q, limit } = src;

  // Express/qs turns `?q[]=a` or `?q[$ne]=x` into arrays/objects — refuse them.
  if (q !== undefined && typeof q !== "string") {
    return { ok: false, message: "Search query must be plain text." };
  }
  if (limit !== undefined && typeof limit !== "string") {
    return { ok: false, message: "Limit must be a number." };
  }

  let lim = SEARCH_LIMITS.defaultLimit;
  if (limit !== undefined && limit !== "") {
    if (!/^\d{1,3}$/.test(limit.trim())) {
      return { ok: false, message: "Limit must be a whole number." };
    }
    lim = Math.min(Math.max(parseInt(limit, 10), 1), SEARCH_LIMITS.maxLimit);
  }

  const text = (q ?? "").replace(/\s+/g, " ").trim();
  if (text.length > SEARCH_LIMITS.maxQueryLength) {
    return {
      ok: false,
      message: `Search query cannot exceed ${SEARCH_LIMITS.maxQueryLength} characters.`,
    };
  }
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    return { ok: false, message: "Search query contains invalid characters." };
  }

  // One-letter words match far too much and add nothing — drop them.
  const tokens = [...new Set(tokenize(text))]
    .filter((t) => t.length >= 2)
    .map((t) => t.slice(0, SEARCH_LIMITS.maxTokenLength))
    .sort((a, b) => b.length - a.length) // longest (most selective) first
    .slice(0, SEARCH_LIMITS.maxTokens);

  if (text.length < SEARCH_LIMITS.minQueryLength || tokens.length === 0) {
    return { ok: true, empty: true, tokens: [], phrase: "", limit: lim };
  }
  return { ok: true, empty: false, tokens, phrase: foldText(text), limit: lim };
};

/** MongoDB filter: active colleges whose tokens prefix-match every query word. */
export const buildSearchFilter = (tokens) => ({
  status: "active", // suspended / any non-active status never appears
  $and: tokens.map((t) => ({ searchTokens: { $regex: `^${escapeRegex(t)}` } })),
});

/**
 * Relevance ranking applied to the (small) candidate pool.
 *   0  name starts with the query
 *   1  every query word starts a word of the name
 *   2  matched via district / country (or mixed)
 * Ties are broken alphabetically by name.
 */
export const rankColleges = (rows, tokens, limit, phrase = "") => {
  const scored = rows.map((r) => {
    const nameFold = foldText(r.name);
    const nameWords = nameFold.split(" ");
    let score = 2;
    if (phrase && nameFold.startsWith(phrase)) score = 0;
    else if (tokens.every((t) => nameWords.some((w) => w.startsWith(t)))) score = 1;
    return { r, score, nameFold };
  });
  scored.sort((a, b) => a.score - b.score || a.nameFold.localeCompare(b.nameFold));
  return scored.slice(0, limit).map((s) => s.r);
};

/** The ONLY fields the public search may return. */
export const toSearchResult = (c) => ({
  collegeId: c.collegeId,
  name: c.name,
  district: c.district,
  country: c.country,
});
