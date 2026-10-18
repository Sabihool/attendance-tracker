/**
 * Tiny in-memory stand-in for the three Mongoose models used by the approval
 * workflow. It implements ONLY the query/update operators the code uses
 * ($ne, $nin, $in, $exists, $and, $or, $set, null-matches-missing) and keeps
 * Mongo's key guarantees:
 *   - a filter+update in findOneAndUpdate is evaluated and applied in ONE
 *     synchronous step (document-level atomicity), after an `await` tick so
 *     concurrent callers genuinely interleave;
 *   - the unique email index throws an E11000-style error (code 11000).
 * It does NOT prove anything about a real MongoDB server; see the skipped
 * integration test for that.
 */
import { buildPublicUser } from "../../utils/approval.js";

let seq = 0;
export const newId = () => (++seq).toString(16).padStart(24, "0");
const tick = () => new Promise((r) => setImmediate(r));

const eq = (a, b) => {
  if (b === null) return a === null || a === undefined;
  return String(a) === String(b);
};

const matches = (doc, filter) =>
  Object.entries(filter).every(([k, cond]) => {
    if (k === "$and") return cond.every((f) => matches(doc, f));
    if (k === "$or") return cond.some((f) => matches(doc, f));
    const v = doc[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, arg]) => {
        switch (op) {
          case "$ne":     return !eq(v, arg);
          case "$nin":    return !arg.some((x) => eq(v, x));
          case "$in":     return arg.some((x) => eq(v, x));
          case "$exists": return (v !== undefined) === arg;
          default: throw new Error(`memoryDb: unsupported operator ${op}`);
        }
      });
    }
    return eq(v, cond);
  });

/** Apply the update operators the code uses: $set, $inc, $unset. */
const applyUpdate = (d, update) => {
  Object.assign(d, update.$set || {});
  for (const [k, n] of Object.entries(update.$inc || {})) d[k] = (Number.isFinite(d[k]) ? d[k] : 0) + n;
  for (const k of Object.keys(update.$unset || {})) delete d[k];
};

const project = (doc, fields) => {
  // Mongoose: "+field" only ADDS a normally-hidden field; it is not a projection.
  if (!fields || fields.split(/\s+/).filter(Boolean).every((f) => f.startsWith("+"))) return { ...doc };
  const keep = new Set(fields.split(/\s+/).filter(Boolean).map((f) => f.replace(/^\+/, "")));
  keep.add("_id");
  return Object.fromEntries(Object.entries(doc).filter(([k]) => keep.has(k)));
};

class Query {
  constructor(run) { this.run = run; this.opts = {}; }
  select(f) { this.opts.select = f; return this; }
  sort(s) { this.opts.sort = s; return this; }
  skip(n) { this.opts.skip = n; return this; }
  limit(n) { this.opts.limit = n; return this; }
  lean() { this.opts.lean = true; return this; }
  then(res, rej) { return this.exec().then(res, rej); }
  catch(rej) { return this.exec().catch(rej); }
  async exec() { await tick(); return this.run(this.opts); }
}

export const createCollection = ({ name, unique = [], decorate = (d) => d }) => {
  const rows = [];
  const out = (d, opts) => (d == null ? null : opts.lean ? project(d, opts.select) : decorate(project(d, opts.select)));
  const sortRows = (list, sort) => {
    if (!sort) return list;
    const keys = Object.entries(sort);
    return [...list].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = a[k], y = b[k];
        if (x < y) return -dir; if (x > y) return dir;
      }
      return 0;
    });
  };
  const checkUnique = (doc) => {
    for (const f of unique) {
      if (rows.some((r) => r[f] === doc[f])) {
        const e = new Error(`E11000 duplicate key ${name}.${f}`); e.code = 11000; e.keyPattern = { [f]: 1 }; throw e;
      }
    }
  };
  const insert = (doc) => {
    const d = { _id: newId(), createdAt: doc.createdAt ?? new Date(), updatedAt: new Date(), ...doc };
    checkUnique(d); rows.push(d); return d;
  };

  return {
    rows,
    seed: (doc) => insert(doc),
    create: async (doc) => { await tick(); return decorate({ ...insert(doc) }); },
    insertMany: async (docs) => { await tick(); return docs.map((d) => insert(d)); },
    findById: (id) => new Query((o) => out(rows.find((r) => eq(r._id, id)), o)),
    findOne: (f) => new Query((o) => out(sortRows(rows, o.sort).find((r) => matches(r, f)), o)),
    find: (f = {}) => new Query((o) => {
      let l = sortRows(rows.filter((r) => matches(r, f)), o.sort);
      if (o.skip) l = l.slice(o.skip);
      if (o.limit) l = l.slice(0, o.limit);
      return l.map((d) => out(d, o));
    }),
    countDocuments: async (f = {}) => { await tick(); return rows.filter((r) => matches(r, f)).length; },
    exists: async (f) => { await tick(); return rows.some((r) => matches(r, f)) ? { _id: 1 } : null; },
    findOneAndUpdate: (f, update, options = {}) => new Query((o) => {
      const d = rows.find((r) => matches(r, f));       // match + update in one synchronous step
      if (!d) return null;
      const before = { ...d };
      applyUpdate(d, update); d.updatedAt = new Date();
      return out(options.new ? d : before, o);
    }),
    findOneAndDelete: (f) => new Query((o) => {
      const i = rows.findIndex((r) => matches(r, f));
      if (i < 0) return null;
      return out(rows.splice(i, 1)[0], o);
    }),
    updateOne: async (f, update) => { await tick(); const d = rows.find((r) => matches(r, f)); if (d) applyUpdate(d, update); return { matchedCount: d ? 1 : 0, modifiedCount: d ? 1 : 0 }; },
    updateMany: async (f, update) => { await tick(); const l = rows.filter((r) => matches(r, f)); l.forEach((d) => applyUpdate(d, update)); return { matchedCount: l.length, modifiedCount: l.length }; },
    deleteOne: async (f) => { await tick(); const i = rows.findIndex((r) => matches(r, f)); if (i >= 0) rows.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
    deleteMany: async (f) => { await tick(); let n = 0; for (let i = rows.length - 1; i >= 0; i--) if (matches(rows[i], f)) { rows.splice(i, 1); n++; } return { deletedCount: n }; },
  };
};

/** Build User / College / Notification fakes sharing one "database". */
export const createMemoryDb = () => {
  const User = createCollection({
    name: "users", unique: ["email"],
    decorate: (d) => ({
      ...d,
      toPublicJSON() { return buildPublicUser(this); },
      comparePassword: async (p) => d.password === p,   // tests store plain passwords
    }),
  });
  const College = createCollection({ name: "colleges", unique: ["collegeId"] });
  const Notification = createCollection({ name: "notifications" });
  return { User, College, Notification };
};

let colSeq = 0;
export const seedCollege = (db, over = {}) => {
  const n = ++colSeq;
  return db.College.seed({
    collegeId: `COL-TEST${String(n).padStart(6, "0")}`, name: `College ${n}`, district: "Feni", country: "Bangladesh",
    status: "active", ...over,
  });
};
export const seedAdmin = (db, college, over = {}) => {
  const n = ++colSeq;
  return db.User.seed({
    name: `Admin ${n}`, email: `admin${n}@example.com`, password: "Secret123", role: "admin",
    approved: true, approvalStatus: "approved", collegeId: college ? college.collegeId : null, ...over,
  });
};
