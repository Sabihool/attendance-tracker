import { buildSearchTokens, buildNameKey } from "./collegeSearch.js";

/**
 * Fill `searchTokens` / `nameKey` on colleges created before the selector
 * existed (Part 5 data). Idempotent and cheap: it only touches documents that
 * are missing tokens, so it is safe to run on every server start.
 *
 * @returns {Promise<number>} number of colleges updated
 */
export const backfillCollegeSearchFields = async (College) => {
  const missing = await College.find({
    $or: [{ searchTokens: { $exists: false } }, { searchTokens: { $size: 0 } }],
  })
    .select("name district country")
    .lean();

  if (missing.length === 0) return 0;

  const ops = missing.map((c) => ({
    updateOne: {
      filter: { _id: c._id },
      update: { $set: { searchTokens: buildSearchTokens(c), nameKey: buildNameKey(c.name) } },
    },
  }));
  await College.bulkWrite(ops, { ordered: false });
  return missing.length;
};
