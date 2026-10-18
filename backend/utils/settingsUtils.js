import Settings from "../models/Settings.js";
import { scopedModel } from "./tenantScope.js";

// COLLEGE SCOPING (Part 12): there is one Settings document PER COLLEGE (the
// consecutive-absence limit is each college's own rule). Every function takes
// the caller's `tenant` (req.tenant); a college's admin can only ever read or
// change its own document.

// ─── Get (or lazily create) the tenant college's Settings document ────────────
// If the college has none yet, create it with the schema defaults. Two requests
// racing to create it collide on the unique {collegeId} index; the loser simply
// re-reads the winner's document.
export const getOrCreateSettings = async (tenant, { SettingsModel = Settings } = {}) => {
  const scoped = scopedModel(SettingsModel, tenant);
  let settings = await scoped.findOne({});
  if (!settings) {
    try {
      settings = await scoped.create({});
    } catch (err) {
      if (err?.code !== 11000) throw err;
      settings = await scoped.findOne({});
    }
  }
  return settings;
};

// ─── Convenience: just the consecutive absence limit as a number ─────────────
export const getConsecutiveAbsenceLimit = async (tenant, opts) => {
  const settings = await getOrCreateSettings(tenant, opts);
  return settings.consecutiveAbsenceLimit;
};
