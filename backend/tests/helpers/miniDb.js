/**
 * Dependency-free fake "model" for tests of the pure security layer (services, guards, scoping helpers).
 * Unlike ./mongooseFake.js it needs neither mongoose nor mingo, so it runs anywhere `node --test` runs.
 *
 * Supports exactly what those modules use: equality, $in, $nin, $ne, $or, $and, $exists, $regex-free;
 * find / findOne / findById / countDocuments / exists / findOneAndUpdate / findOneAndDelete / updateMany /
 * deleteMany / create / distinct / aggregate (only the forced tenant $match), with the chainable
 * `.select().lean().sort().skip().limit()` query object.
 */
let seq = 0;
export const oid = () => (++seq).toString(16).padStart(24, "0");

const eq = (a, b) => String(a ?? null) === String(b ?? null) && (a == null) === (b == null);

const matchValue = (actual, cond) => {
  if (cond !== null && typeof cond === "object" && !Array.isArray(cond) && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, v]) => {
      switch (op) {
        case "$in": return v.some((x) => eq(actual, x));
        case "$nin": return !v.some((x) => eq(actual, x));
        case "$ne": return !eq(actual, v);
        case "$exists": return (actual !== undefined) === Boolean(v);
        default: throw new Error(`miniDb: unsupported operator ${op}`);
      }
    });
  }
  return eq(actual, cond);
};

export const matches = (doc, filter = {}) =>
  Object.entries(filter).every(([k, cond]) => {
    if (k === "$or") return cond.some((f) => matches(doc, f));
    if (k === "$and") return cond.every((f) => matches(doc, f));
    return matchValue(doc[k], cond);
  });

const clone = (d) => (d ? JSON.parse(JSON.stringify(d)) : d);

class Query {
  constructor(run) { this.run = run; this.fields = null; this.skipN = 0; this.limitN = Infinity; }
  select(f) { this.fields = typeof f === "string" ? f.split(/\s+/).filter(Boolean) : null; return this; }
  lean() { return this; }
  sort() { return this; }
  skip(n) { this.skipN = n; return this; }
  limit(n) { this.limitN = n; return this; }
  catch(rej) { return this.then(undefined, rej); }
  then(res, rej) {
    return Promise.resolve().then(() => {
      let out = this.run();
      if (Array.isArray(out)) out = out.slice(this.skipN, this.skipN + this.limitN);
      const pick = (d) => {
        if (!d || !this.fields) return clone(d);
        const o = { _id: d._id };
        for (const f of this.fields) o[f] = d[f];
        return clone(o);
      };
      return Array.isArray(out) ? out.map(pick) : pick(out);
    }).then(res, rej);
  }
}

export const makeModel = (name, { collegeScoped = true } = {}) => {
  const rows = [];
  const M = {
    modelName: name,
    rows,
    schema: { path: (p) => (p === "collegeId" ? collegeScoped : true) },
    seed(doc) { const d = { _id: oid(), ...doc }; rows.push(d); return d; },
    find: (f) => new Query(() => rows.filter((d) => matches(d, f))),
    findOne: (f) => new Query(() => rows.find((d) => matches(d, f)) ?? null),
    findById: (id) => new Query(() => rows.find((d) => eq(d._id, id)) ?? null),
    countDocuments: async (f) => rows.filter((d) => matches(d, f)).length,
    exists: async (f) => (rows.find((d) => matches(d, f)) ? { _id: 1 } : null),
    distinct: async (field, f) => [...new Set(rows.filter((d) => matches(d, f)).map((d) => d[field]))],
    findOneAndUpdate: (f, update, opts = {}) => new Query(() => {
      const d = rows.find((x) => matches(x, f));
      if (!d) return null;
      Object.assign(d, update.$set || {});
      for (const [k, v] of Object.entries(update.$inc || {})) d[k] = (d[k] || 0) + v;
      return opts.new === false ? d : d;
    }),
    findOneAndDelete: (f) => new Query(() => {
      const i = rows.findIndex((x) => matches(x, f));
      return i < 0 ? null : rows.splice(i, 1)[0];
    }),
    updateOne: async (f, update) => {
      const d = rows.find((x) => matches(x, f));
      if (d) Object.assign(d, update.$set || {});
      return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 };
    },
    updateMany: async (f, update) => {
      const hit = rows.filter((d) => matches(d, f));
      hit.forEach((d) => Object.assign(d, update.$set || {}));
      return { matchedCount: hit.length, modifiedCount: hit.length };
    },
    deleteMany: async (f) => {
      let n = 0;
      for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], f)) { rows.splice(i, 1); n++; }
      return { deletedCount: n };
    },
    create: async (doc) => { const d = { _id: oid(), ...doc }; rows.push(d); return d; },
    aggregate: async (pipeline) => {
      const first = pipeline[0]?.$match ?? {};
      return rows.filter((d) => matches(d, first));
    },
  };
  return M;
};
