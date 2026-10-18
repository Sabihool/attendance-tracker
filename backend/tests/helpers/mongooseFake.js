/**
 * Test harness: REAL Mongoose models + an in-process fake MongoDB driver.
 *
 * Why: the sandbox the tests were written in has no MongoDB server, but the
 * isolation rules of Part 9 live in real controllers, real schemas (collegeId
 * immutability, validation) and real index definitions. This lets the tests run
 * those unchanged, over real HTTP, against two colleges.
 *
 * What is emulated (via `mingo`, a pure-JS MongoDB query/aggregation engine):
 *   find / findOne / count / distinct / aggregate (incl. $group, $addToSet,
 *   $lookup), updateOne / updateMany / findOneAndUpdate / findOneAndDelete,
 *   deleteOne / deleteMany, bulkWrite (unordered upserts), insertOne / Many.
 *
 * And — deliberately — INDEXES, because "two colleges can use the same name"
 * is an index question:
 *   - only indexes that were actually created (`createIndex`) are enforced, so a
 *     test can start from the LEGACY index set and prove the migration works;
 *   - unique, compound-unique, partialFilterExpression and case-insensitive
 *     collation (strength 1/2) uniqueness are enforced with E11000 errors.
 *
 * Transactions: `withTransaction` snapshots every collection and restores the
 * snapshot if the callback throws (rollback). Isolation between concurrent
 * transactions and write-conflict retries are NOT emulated.
 *
 * What is NOT emulated: real server semantics such as index selection, write concern, BSON ordering of mixed
 * types. ObjectIds are stored as hex strings (mingo cannot compare ObjectId
 * instances), so aggregate output ids are strings. This does not prove
 * anything about a real MongoDB server — see the skipped integration tests.
 */
import mongoose from "mongoose";
import { Query, aggregate as mingoAggregate } from "mingo";
import { update as mingoUpdate } from "mingo/updater";

// Must run before any model is compiled (static imports evaluate in order).
mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);
mongoose.set("bufferCommands", false);

// ── value helpers ────────────────────────────────────────────────────────────
const isOid = (v) => v && typeof v === "object" && v._bsontype === "ObjectId";
const isPlainObj = (v) => v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof RegExp) && !Buffer.isBuffer(v);

/** Deep copy; ObjectId → hex string. */
const norm = (v) => {
  if (isOid(v)) return v.toHexString();
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof RegExp || Buffer.isBuffer(v)) return v;
  // Mongoose subdocuments / document arrays (e.g. the value of a `$push` into a
  // subdocument array after Mongoose has cast the update). The real driver
  // serialises these through toBSON(); do the same, and iterate arrays with
  // Array.from, because a Mongoose array's own .map() returns another Mongoose
  // array (which would recurse forever through this function).
  if (v && typeof v.toBSON === "function") return norm(v.toBSON());
  if (Array.isArray(v)) return Array.from(v, norm);
  if (isPlainObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = norm(x);
    return o;
  }
  return v;
};

const newHexId = () => new mongoose.Types.ObjectId().toHexString();
const getPath = (doc, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), doc);

const dupError = (indexName, keyPattern, keyValue) =>
  Object.assign(new Error(`E11000 duplicate key error collection index: ${indexName} dup key: ${JSON.stringify(keyValue)}`), {
    name: "MongoServerError", code: 11000, keyPattern, keyValue,
  });

const indexName = (fields) => Object.entries(fields).map(([k, d]) => `${k}_${d}`).join("_");

// ── registry so $lookup can see other collections ────────────────────────────
const registry = new Map();

export class FakeCollection {
  constructor(name) {
    this.name = name;
    this.docs = [];
    this.idx = new Map(); // name -> { key, unique, partial, collation }
    registry.set(name, this);
  }

  // ── indexes ────────────────────────────────────────────────────────────────
  async createIndex(fields, options = {}) {
    const name = options.name || indexName(fields);
    if (this.idx.has(name)) return name;
    const def = { key: fields, unique: !!options.unique, partial: options.partialFilterExpression || null, collation: options.collation || null };
    if (def.unique) this._assertUniqueAcross(name, def, this.docs); // like a real index build: fails on existing duplicates
    this.idx.set(name, def);
    return name;
  }
  async createIndexes(specs) { for (const s of specs) await this.createIndex(s.key, s); }
  async indexes() {
    return [{ v: 2, key: { _id: 1 }, name: "_id_" }, ...[...this.idx].map(([name, d]) => ({ v: 2, key: d.key, name, unique: d.unique || undefined }))];
  }
  async dropIndex(name) {
    if (!this.idx.delete(name)) throw Object.assign(new Error(`index not found with name [${name}]`), { code: 27, codeName: "IndexNotFound" });
  }

  _keyOf(doc, def) {
    const ci = def.collation && (def.collation.strength === 1 || def.collation.strength === 2);
    return JSON.stringify(Object.keys(def.key).map((p) => {
      let v = getPath(doc, p);
      if (v === undefined) v = null;
      return ci && typeof v === "string" ? v.toLowerCase() : v;
    }));
  }
  _inIndex(doc, def) { return !def.partial || new Query(def.partial).test(doc); }
  _assertUniqueAcross(name, def, docs) {
    const seen = new Map();
    for (const d of docs) {
      if (!this._inIndex(d, def)) continue;
      const k = this._keyOf(d, def);
      if (seen.has(k)) throw dupError(name, def.key, Object.fromEntries(Object.keys(def.key).map((p) => [p, getPath(d, p) ?? null])));
      seen.set(k, d);
    }
  }
  /** Would `doc` (replacing `selfId`) violate a unique index? */
  _checkUnique(doc, selfId) {
    for (const [name, def] of this.idx) {
      if (!def.unique || !this._inIndex(doc, def)) continue;
      const k = this._keyOf(doc, def);
      for (const o of this.docs) {
        if (o._id === selfId || !this._inIndex(o, def)) continue;
        if (this._keyOf(o, def) === k) throw dupError(name, def.key, Object.fromEntries(Object.keys(def.key).map((p) => [p, getPath(doc, p) ?? null])));
      }
    }
  }

  // ── reads ──────────────────────────────────────────────────────────────────
  _match(filter) {
    const q = new Query(norm(filter || {}));
    return this.docs.filter((d) => q.test(d));
  }
  _project(doc, projection) {
    if (!projection || !Object.keys(projection).length) return structuredClone(doc);
    const entries = Object.entries(projection).filter(([k]) => k !== "_id");
    const inclusive = entries.some(([, v]) => v === 1 || v === true);
    const out = {};
    if (inclusive) {
      for (const [k] of entries.filter(([, v]) => v === 1 || v === true)) if (doc[k] !== undefined) out[k] = structuredClone(doc[k]);
      if (projection._id !== 0 && projection._id !== false) out._id = doc._id;
      return out;
    }
    const copy = structuredClone(doc);
    for (const [k, v] of entries) if (v === 0 || v === false) delete copy[k];
    if (projection._id === 0 || projection._id === false) delete copy._id;
    return copy;
  }
  _sorted(list, sort) {
    if (!sort) return list;
    const keys = sort instanceof Map ? [...sort] : Object.entries(sort);
    return [...list].sort((a, b) => {
      for (const [k, dir] of keys) {
        const x = getPath(a, k) ?? null, y = getPath(b, k) ?? null;
        if (x < y) return -dir;
        if (x > y) return dir;
      }
      return 0;
    });
  }
  find(filter, options = {}) {
    let list = this._sorted(this._match(filter), options.sort);
    if (options.skip) list = list.slice(options.skip);
    if (options.limit) list = list.slice(0, options.limit);
    const out = list.map((d) => this._project(d, options.projection));
    return { toArray: async () => out, close: async () => {}, [Symbol.asyncIterator]: async function* () { yield* out; } };
  }
  async findOne(filter, options = {}) {
    const [d] = this._sorted(this._match(filter), options.sort);
    return d ? this._project(d, options.projection) : null;
  }
  async countDocuments(filter) { return this._match(filter).length; }
  async estimatedDocumentCount() { return this.docs.length; }
  async distinct(field, filter) {
    const seen = new Map();
    for (const d of this._match(filter)) {
      const v = getPath(d, field);
      for (const x of Array.isArray(v) ? v : [v]) if (x !== undefined) seen.set(JSON.stringify(x), x);
    }
    return [...seen.values()];
  }
  aggregate(pipeline) {
    const resolver = (n) => registry.get(n)?.docs.map((d) => structuredClone(d)) ?? [];
    const out = mingoAggregate(this.docs.map((d) => structuredClone(d)), norm(pipeline), { collectionResolver: resolver });
    return { toArray: async () => out, close: async () => {}, [Symbol.asyncIterator]: async function* () { yield* out; } };
  }

  // ── writes ─────────────────────────────────────────────────────────────────
  async insertOne(doc) {
    const d = norm(doc);
    if (!d._id) d._id = newHexId();
    if (this.docs.some((o) => o._id === d._id)) throw dupError("_id_", { _id: 1 }, { _id: d._id });
    this._checkUnique(d, d._id);
    this.docs.push(d);
    return { acknowledged: true, insertedId: d._id };
  }
  async insertMany(docs) {
    const ids = {};
    for (const [i, d] of docs.entries()) ids[i] = (await this.insertOne(d)).insertedId;
    return { acknowledged: true, insertedCount: docs.length, insertedIds: ids };
  }

  _applyUpdate(doc, update) {
    const copy = structuredClone(doc);
    const { $setOnInsert, ...rest } = norm(update);
    mingoUpdate(copy, rest);
    return copy;
  }
  _baseFromFilter(filter) {
    const base = {};
    for (const [k, v] of Object.entries(norm(filter || {}))) {
      if (k.startsWith("$")) continue;
      if (v === null || typeof v !== "object" || v instanceof Date) base[k] = v;
      else if (isPlainObj(v) && "$eq" in v) base[k] = v.$eq;
    }
    return base;
  }
  _updateDocs(targets, update) {
    let modified = 0;
    for (const t of targets) {
      const next = this._applyUpdate(t, update);
      if (JSON.stringify(next) === JSON.stringify(t)) continue;
      this._checkUnique(next, t._id);
      this.docs[this.docs.indexOf(t)] = next;
      modified++;
    }
    return modified;
  }
  _upsert(filter, update) {
    const base = this._baseFromFilter(filter);
    const inserted = this._applyUpdate({ ...base, _id: base._id ?? newHexId() }, { ...norm(update), ...(update?.$setOnInsert ? { $set: { ...(norm(update).$set || {}), ...norm(update.$setOnInsert) } } : {}) });
    this._checkUnique(inserted, inserted._id);
    this.docs.push(inserted);
    return inserted._id;
  }
  async updateOne(filter, update, options = {}) {
    const [t] = this._match(filter);
    if (!t) {
      if (options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: this._upsert(filter, update) };
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
    }
    const modified = this._updateDocs([t], update);
    return { acknowledged: true, matchedCount: 1, modifiedCount: modified, upsertedCount: 0, upsertedId: null, n: 1, nModified: modified };
  }
  async updateMany(filter, update, options = {}) {
    const targets = this._match(filter);
    if (!targets.length && options.upsert) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: this._upsert(filter, update) };
    const modified = this._updateDocs(targets, update);
    return { acknowledged: true, matchedCount: targets.length, modifiedCount: modified, upsertedCount: 0, upsertedId: null, n: targets.length, nModified: modified };
  }
  async findOneAndUpdate(filter, update, options = {}) {
    const [t] = this._sorted(this._match(filter), options.sort);
    let value = null;
    if (t) {
      const before = structuredClone(t);
      this._updateDocs([t], update);
      value = options.returnDocument === "after" ? structuredClone(this.docs.find((d) => d._id === before._id)) : before;
    } else if (options.upsert) {
      const id = this._upsert(filter, update);
      value = options.returnDocument === "after" ? structuredClone(this.docs.find((d) => d._id === id)) : null;
    }
    return options.includeResultMetadata ? { value, ok: 1, lastErrorObject: { n: value ? 1 : 0, updatedExisting: !!t } } : value;
  }
  async deleteOne(filter) {
    const [t] = this._match(filter);
    if (t) this.docs.splice(this.docs.indexOf(t), 1);
    return { acknowledged: true, deletedCount: t ? 1 : 0 };
  }
  async deleteMany(filter) {
    const targets = new Set(this._match(filter));
    this.docs = this.docs.filter((d) => !targets.has(d));
    return { acknowledged: true, deletedCount: targets.size };
  }
  async findOneAndDelete(filter, options = {}) {
    const [t] = this._match(filter);
    const value = t ? structuredClone(t) : null;
    if (t) this.docs.splice(this.docs.indexOf(t), 1);
    return options.includeResultMetadata ? { value, ok: 1, lastErrorObject: { n: value ? 1 : 0 } } : value;
  }
  async bulkWrite(ops) {
    const r = { insertedCount: 0, matchedCount: 0, modifiedCount: 0, deletedCount: 0, upsertedCount: 0, upsertedIds: {}, insertedIds: {}, ok: 1 };
    const errors = [];
    for (const [i, op] of ops.entries()) {
      try {
        if (op.updateOne) {
          const x = await this.updateOne(op.updateOne.filter, op.updateOne.update, { upsert: op.updateOne.upsert });
          r.matchedCount += x.matchedCount; r.modifiedCount += x.modifiedCount; r.upsertedCount += x.upsertedCount;
          if (x.upsertedCount) r.upsertedIds[i] = x.upsertedId;
        } else if (op.updateMany) {
          const x = await this.updateMany(op.updateMany.filter, op.updateMany.update, { upsert: op.updateMany.upsert });
          r.matchedCount += x.matchedCount; r.modifiedCount += x.modifiedCount; r.upsertedCount += x.upsertedCount;
        } else if (op.insertOne) {
          const x = await this.insertOne(op.insertOne.document); r.insertedCount++; r.insertedIds[i] = x.insertedId;
        } else if (op.deleteOne) {
          r.deletedCount += (await this.deleteOne(op.deleteOne.filter)).deletedCount;
        } else throw new Error(`fake bulkWrite: unsupported op ${Object.keys(op)[0]}`);
      } catch (e) { errors.push({ index: i, code: e.code, errmsg: e.message, err: { index: i, code: e.code, errmsg: e.message } }); }
    }
    // Same shape as the driver's MongoBulkWriteError: writeErrors[n].err.index / .code
    if (errors.length) throw Object.assign(new Error(errors[0].errmsg), { name: "MongoBulkWriteError", code: errors[0].code, writeErrors: errors, result: r });
    return r;
  }
}

/** Replace the driver under every compiled model with a fresh, empty fake. Returns the fakes by model name. */
export const installFakeDb = (models = mongoose.models) => {
  registry.clear();
  const fakes = {};
  for (const [modelName, Model] of Object.entries(models)) {
    const fake = new FakeCollection(Model.collection.name);
    Model.collection.collection = fake;
    Model.collection.buffer = false;
    fakes[modelName] = fake;
  }
  // runInTransaction() → runs inline, but with all-or-nothing semantics: every
  // fake collection is snapshotted first and restored if the callback throws
  // (a rolled-back transaction). Isolation between concurrent transactions and
  // write-conflict retries are NOT emulated.
  mongoose.startSession = async () => ({
    withTransaction: async (fn) => {
      const snapshots = Object.values(fakes).map((f) => [f, structuredClone(f.docs)]);
      try {
        return await fn();
      } catch (err) {
        for (const [f, docs] of snapshots) f.docs = docs;
        throw err;
      }
    },
    endSession: async () => {},
  });
  return fakes;
};

/** Create the indexes the CURRENT schemas define (what autoIndex does against a real server). */
export const buildSchemaIndexes = async (models = mongoose.models) => {
  for (const Model of Object.values(models)) await Model.createIndexes();
};

export { mongoose };
