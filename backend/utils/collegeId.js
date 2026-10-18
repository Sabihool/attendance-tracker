import crypto from "crypto";

// Crockford-style alphabet: no I, L, O, U, 0, 1 — avoids look-alike characters.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Generate a random, non-guessable college identifier, e.g. "COL-7K2M9XQ4TB".
 * 10 characters from a 30-symbol alphabet ≈ 49 bits of entropy. Uniqueness is
 * still enforced by the unique index on College.collegeId (the controller
 * retries on the extremely unlikely collision).
 */
export const generateCollegeId = () => {
  const bytes = crypto.randomBytes(10);
  let out = "";
  for (let i = 0; i < 10; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return `COL-${out}`;
};

export const COLLEGE_ID_PATTERN = /^COL-[2-9A-HJKMNP-TV-Z]{10}$/;
