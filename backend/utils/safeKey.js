/**
 * Safe lookups for maps that are keyed by a request value (sort fields, etc.).
 *
 * `sortMap[req.query.sort]` is unsafe for plain objects: `?sort=constructor` or
 * `?sort=__proto__` returns a function / the prototype instead of `undefined`, so
 * the "fall back to the default" branch is skipped and the value is handed to
 * Array#sort / Mongoose, which throws (a 500) or sorts by garbage.
 * `pickOwn` only returns values that are the map's OWN properties, and only for
 * string keys.
 */
export const pickOwn = (map, key, fallback) =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : fallback;

export const hasOwnKey = (map, key) =>
  typeof key === "string" && Object.prototype.hasOwnProperty.call(map, key);

/**
 * Spreadsheet formula-injection guard. A cell whose text starts with = + - @ (or a
 * tab / carriage return) is executed as a formula by Excel / LibreOffice / Sheets.
 * Prefixing an apostrophe makes it plain text. Only strings are touched; numbers pass through.
 */
export const neutralizeFormula = (v) =>
  typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
