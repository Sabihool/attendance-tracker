import Shift from "../models/Shift.js";
import { scopedModel } from "./tenantScope.js";
import { exactNameMatch, cleanName, isPlainString } from "./academicNames.js";

// Shifts are owned by a college: every lookup takes the request's tenant
// (req.tenant) and can only see that college's shifts.

// ─── Case-insensitive shift lookup (within one college) ───────────────────────
export const findShiftByName = async (tenant, name, { Model = Shift } = {}) => {
  if (!isPlainString(name) || !cleanName(name)) return null;
  return scopedModel(Model, tenant).findOne({ name: exactNameMatch(name) });
};

// ─── Get all shift names of the college (validation messages, dropdowns) ──────
export const getShiftNames = async (tenant, { Model = Shift } = {}) => {
  const shifts = await scopedModel(Model, tenant).find({}).sort({ order: 1, name: 1 }).lean();
  return shifts.map((s) => s.name);
};
