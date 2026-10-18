import mongoose from "mongoose";

/**
 * runInTransaction(work)
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs `work(session)` inside a MongoDB transaction so that either every
 * write inside it succeeds, or none of them do (used for the permanent
 * subject deletion cleanup — see subjectController.deleteSubject).
 *
 * Falls back to running `work(null)` WITHOUT a transaction if the connected
 * MongoDB deployment doesn't support them (e.g. a local standalone `mongod`
 * used in development — MongoDB Atlas, which this project deploys to,
 * always supports transactions since it runs as a replica set).
 *
 * `work` receives the active session (or `null` in the fallback case) and
 * should pass `{ session }` (or `{}` when session is null) as the options
 * object to every Mongoose query it makes.
 */
export const runInTransaction = async (work) => {
  const session = await mongoose.startSession();
  try {
    let result;
    try {
      await session.withTransaction(async () => {
        result = await work(session);
      });
    } catch (err) {
      const msg = String(err?.message || "");
      const unsupported =
        err?.code === 20 ||
        err?.codeName === "IllegalOperation" ||
        msg.includes("Transaction numbers") ||
        msg.includes("replica set") ||
        msg.includes("does not support transactions") ||
        msg.includes("This MongoDB deployment does not support");

      if (!unsupported) throw err;

      // Fallback: no transaction support — run the same steps sequentially
      // without a session. Not atomic, but keeps the feature working in
      // standalone dev environments.
      result = await work(null);
    }
    return result;
  } finally {
    await session.endSession();
  }
};
