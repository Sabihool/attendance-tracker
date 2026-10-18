import Department from "../models/Department.js";
import { scopedModel } from "./tenantScope.js";
import { exactNameMatch, cleanName, isPlainString } from "./academicNames.js";

// Departments are owned by a college (same pattern as utils/shiftUtils.js):
// every lookup takes the request's tenant (req.tenant) and can only see that
// college's departments, so a department id/name of another college is simply
// "not found".

// ─── Case-insensitive department lookup (within one college) ──────────────────
export const findDepartmentByName = async (tenant, name, { Model = Department } = {}) => {
  if (!isPlainString(name) || !cleanName(name)) return null;
  return scopedModel(Model, tenant).findOne({ name: exactNameMatch(name) });
};

// ─── All department names of the college (validation messages, dropdowns) ─────
export const getDepartmentNames = async (tenant, { Model = Department } = {}) => {
  const list = await scopedModel(Model, tenant).find({}).sort({ name: 1 }).lean();
  return list.map((d) => d.name);
};
