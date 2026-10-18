/**
 * Name helpers shared by the academic-structure code (departments, shifts,
 * batches). Names are matched case-insensitively, as they always were, but the
 * text is now ESCAPED first: a department called "Arts (Hons)" or "C++" used to
 * build an invalid / over-matching regular expression.
 */

export const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Trim and collapse nothing else: names keep their exact spelling and case. */
export const cleanName = (value) => (typeof value === "string" ? value.trim() : "");

/** `{ $regex, $options }` matching exactly `name`, ignoring case. */
export const exactNameMatch = (name) => ({
  $regex: `^${escapeRegex(cleanName(name))}$`,
  $options: "i",
});

/** Case-insensitive equality used for "did the name really change?" checks. */
export const sameName = (a, b) => cleanName(a).toLowerCase() === cleanName(b).toLowerCase();

/**
 * Body fields must be strings. `{ "$ne": "" }`, arrays and numbers are rejected
 * so a request can never inject a Mongo operator into a name lookup.
 */
export const isPlainString = (v) => typeof v === "string";
