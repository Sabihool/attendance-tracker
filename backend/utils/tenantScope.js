/**
 * Safe college-scoped query helpers.
 *
 * RULE: the college ("tenant") of a request comes from `req.tenant`, which is
 * built from the authenticated user's database record (see
 * middleware/tenantGuards.js → tenantContext). It is NEVER read from a query
 * string, request body, URL parameter or frontend state.
 *
 * These helpers make the safe thing the easy thing:
 *   - `scopeFilter` always puts `collegeId` in the filter, last, so a caller's
 *     extra conditions can never widen or replace it;
 *   - `scopedModel` wraps a Mongoose model so every read/update/delete is
 *     scoped, every create stamps the tenant's id, and no update can move a
 *     document to another college;
 *   - `scopedAggregate` prepends the tenant `$match` (aggregations bypass
 *     ordinary query filters, so they are a classic leak) and refuses stages
 *     that could join other colleges' rows ($lookup without a college-pinned
 *     pipeline, $unionWith, $graphLookup, $out, $merge);
 *   - models without a `collegeId` path are refused (Mongoose would otherwise
 *     silently drop the field on create and leave the row unscoped).
 *
 * A tenant with `collegeId: null` is an account not yet assigned to a college
 * (legacy install). It is scoped to documents with NO college (`collegeId:
 * null` matches a missing field), so it can never see a real college's data
 * and a real college can never see it.
 */
import { isObjectIdString } from "./approval.js";

/** Programming error: the scoping contract was violated. Surfaces as a 500, never as data. */
export class TenantScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = "TenantScopeError";
    this.expose = false;
  }
}

/** Request keys that look like a client-supplied college. They are never used for authorization. */
export const CLIENT_TENANT_KEYS = Object.freeze(["collegeid", "college_id", "college", "tenantid", "tenant_id", "tenant"]);

export const isClientTenantKey = (key) =>
  typeof key === "string" && CLIENT_TENANT_KEYS.includes(key.toLowerCase());

/** Validate a tenant object produced by tenantContext. */
export const assertTenant = (tenant) => {
  if (!tenant || typeof tenant !== "object") throw new TenantScopeError("No tenant context on this request.");
  const id = tenant.collegeId;
  if (id !== null && typeof id !== "string") throw new TenantScopeError("Tenant context has an invalid collegeId.");
  if (typeof id === "string" && id.length === 0) throw new TenantScopeError("Tenant context has an empty collegeId.");
  return tenant;
};

const hasKeyDeep = (obj, pred, depth = 0) => {
  if (!obj || typeof obj !== "object" || depth > 4) return false;
  for (const [k, v] of Object.entries(obj)) {
    if (pred(k)) return true;
    if (v && typeof v === "object" && hasKeyDeep(v, pred, depth + 1)) return true;
  }
  return false;
};

/**
 * Build a filter limited to the tenant's college.
 * `extra` may add conditions but may not mention collegeId at all.
 */
export const scopeFilter = (tenant, extra = {}) => {
  assertTenant(tenant);
  if (extra === null || typeof extra !== "object" || Array.isArray(extra)) {
    throw new TenantScopeError("scopeFilter: extra conditions must be an object.");
  }
  if (Object.keys(extra).some((k) => k.toLowerCase() === "collegeid")) {
    throw new TenantScopeError("scopeFilter: collegeId is set by the server and cannot be passed in.");
  }
  return { ...extra, collegeId: tenant.collegeId }; // last → cannot be overridden
};

/** True when an update document tries to touch collegeId in any operator. */
const updateTouchesCollege = (update) =>
  // plain key, dotted path into it ("collegeId.x"), or $rename (which can move ANY field's value into collegeId)
  hasKeyDeep(update, (k) => /^collegeid(\.|$)/i.test(k) || k === "$rename");

const requireTenantField = (Model) => {
  // Real Mongoose models expose .schema; lightweight fakes in tests may not.
  if (Model?.schema?.path && !Model.schema.path("collegeId")) {
    throw new TenantScopeError(`Model '${Model.modelName || "?"}' has no collegeId field, so it cannot be college-scoped yet.`);
  }
};

/** Run `fn`, applying lean() when asked and supported. */
const maybeLean = (q, lean) => (lean && typeof q?.lean === "function" ? q.lean() : q);

/**
 * Wrap a Mongoose model for one tenant. The returned methods mirror the model's
 * but cannot escape the tenant.
 */
export const scopedModel = (Model, tenant) => {
  assertTenant(tenant);
  requireTenantField(Model);
  const scope = (extra) => scopeFilter(tenant, extra);

  return {
    tenant,

    find: (filter = {}, { lean = false } = {}) => maybeLean(Model.find(scope(filter)), lean),

    findOne: (filter = {}, { lean = false } = {}) => maybeLean(Model.findOne(scope(filter)), lean),

    /** Invalid or foreign ids resolve to null (indistinguishable from "does not exist"). */
    findById: async (id, { lean = false } = {}) => {
      if (!isObjectIdString(typeof id === "string" ? id : String(id ?? ""))) return null;
      return maybeLean(Model.findOne(scope({ _id: String(id) })), lean);
    },

    countDocuments: (filter = {}) => Model.countDocuments(scope(filter)),

    exists: (filter = {}) => Model.exists(scope(filter)),

    create: async (doc) => {
      if (!doc || typeof doc !== "object") throw new TenantScopeError("create: document required.");
      // Whatever the caller sent for collegeId is discarded and replaced.
      const { collegeId: _ignored, ...rest } = doc; // eslint-disable-line no-unused-vars
      return Model.create({ ...rest, collegeId: tenant.collegeId });
    },

    findOneAndUpdate: (filter, update, options = {}) => {
      if (updateTouchesCollege(update)) throw new TenantScopeError("Updates may not change collegeId.");
      return Model.findOneAndUpdate(scope(filter), update, options);
    },

    updateOne: (filter, update, options) => {
      if (updateTouchesCollege(update)) throw new TenantScopeError("Updates may not change collegeId.");
      return Model.updateOne(scope(filter), update, options);
    },

    updateMany: (filter, update, options) => {
      if (updateTouchesCollege(update)) throw new TenantScopeError("Updates may not change collegeId.");
      return Model.updateMany(scope(filter), update, options);
    },

    findOneAndDelete: (filter, options) => Model.findOneAndDelete(scope(filter), options),
    deleteOne: (filter, options) => Model.deleteOne(scope(filter), options),
    deleteMany: (filter, options) => Model.deleteMany(scope(filter), options),

    /** Distinct values among the tenant's documents only. */
    distinct: (field, filter = {}) => Model.distinct(field, scope(filter)),

    /**
     * Bulk upserts/updates limited to the tenant. Only updateOne / updateMany /
     * deleteOne ops are accepted; each op's filter is scoped, and no op may touch
     * collegeId in its update. (An upsert's inserted document inherits the
     * tenant's collegeId from the scoped filter.)
     */
    bulkWrite: (ops, options) => {
      if (!Array.isArray(ops)) throw new TenantScopeError("bulkWrite: ops must be an array.");
      const scoped = ops.map((op) => {
        const [kind] = Object.keys(op || {});
        if (!["updateOne", "updateMany", "deleteOne"].includes(kind) || Object.keys(op).length !== 1) {
          throw new TenantScopeError(`bulkWrite: operation '${kind}' is not allowed in a scoped model.`);
        }
        const body = op[kind];
        if (kind !== "deleteOne" && updateTouchesCollege(body.update)) {
          throw new TenantScopeError("Updates may not change collegeId.");
        }
        return { [kind]: { ...body, filter: scope(body.filter) } };
      });
      return Model.bulkWrite(scoped, options);
    },

    aggregate: (pipeline = []) => scopedAggregate(Model, tenant, pipeline),
  };
};

/** Does `node` pin `collegeId` to the tenant's value anywhere (plain key, $and/$or branches, nested objects)? */
const pinsCollege = (node, collegeId, depth = 0) => {
  if (!node || typeof node !== "object" || depth > 6) return false;
  if (Array.isArray(node)) return node.some((n) => pinsCollege(n, collegeId, depth + 1));
  for (const [k, v] of Object.entries(node)) {
    if (k === "collegeId" && (v === collegeId || (v === null && collegeId === null))) return true;
    if (k === "$and" && pinsCollege(v, collegeId, depth + 1)) return true;
  }
  return false;
};

/**
 * Reject pipeline stages that can pull in documents the forced `$match` does not
 * cover. The forced match only limits the pipeline's INPUT; a `$lookup`,
 * `$unionWith` or `$graphLookup` reads a second collection with no tenant filter
 * unless the caller scopes it. Rules:
 *   - `$out` / `$merge`   never (they write);
 *   - `$unionWith`, `$graphLookup`   never (no way to prove they stay in the college);
 *   - `$lookup`   only the `let` + `pipeline` form, and that sub-pipeline's FIRST
 *     stage must be a `$match` that pins collegeId to this tenant. The plain
 *     localField/foreignField form is refused: it would join other colleges' rows;
 *   - `$facet` sub-pipelines and `$lookup` sub-pipelines are checked recursively.
 */
const assertSafePipeline = (pipeline, tenant, depth = 0) => {
  if (depth > 4) throw new TenantScopeError("aggregate: pipeline is nested too deeply.");
  for (const stage of pipeline) {
    if (!stage || typeof stage !== "object") throw new TenantScopeError("aggregate: every stage must be an object.");
    for (const op of ["$out", "$merge"]) {
      if (op in stage) throw new TenantScopeError("aggregate: $out / $merge are not allowed in scoped pipelines.");
    }
    for (const op of ["$unionWith", "$graphLookup"]) {
      if (op in stage) throw new TenantScopeError(`aggregate: ${op} is not allowed in scoped pipelines.`);
    }
    if (stage.$lookup) {
      const lk = stage.$lookup;
      if (!Array.isArray(lk.pipeline)) {
        throw new TenantScopeError("aggregate: $lookup must use the let/pipeline form with a college-pinned first $match.");
      }
      const first = lk.pipeline[0]?.$match;
      if (!first || !pinsCollege(first, tenant.collegeId)) {
        throw new TenantScopeError("aggregate: a $lookup pipeline must start with a $match that pins collegeId to the tenant.");
      }
      assertSafePipeline(lk.pipeline, tenant, depth + 1);
    }
    if (stage.$facet) {
      for (const sub of Object.values(stage.$facet)) {
        if (!Array.isArray(sub)) throw new TenantScopeError("aggregate: $facet branches must be arrays.");
        assertSafePipeline(sub, tenant, depth + 1);
      }
    }
  }
};

/**
 * Aggregation with the tenant `$match` forced to the front (so every `$group` /
 * `$sum` / `$max` only ever sees the tenant's documents), and with stages that
 * could read another college's documents refused (see assertSafePipeline).
 */
export const scopedAggregate = (Model, tenant, pipeline = []) => {
  assertTenant(tenant);
  requireTenantField(Model);
  if (!Array.isArray(pipeline)) throw new TenantScopeError("aggregate: pipeline must be an array.");
  assertSafePipeline(pipeline, tenant);
  return Model.aggregate([{ $match: { collegeId: tenant.collegeId } }, ...pipeline]);
};
