/**
 * Index migration for Part 9.
 *
 * Mongoose creates NEW indexes from the schema but never drops OLD ones. The
 * pre-Part-9 schema had GLOBAL unique indexes (department name, shift name,
 * studentId, roll within a group). Left in place they would stop a second
 * college from using the same department name or student registration number,
 * defeating the whole point of multi-college operation. They are dropped here
 * (by exact name, so nothing else is touched) and the new per-college indexes
 * are then built from the schema.
 *
 * Idempotent: running it again drops nothing and rebuilds nothing.
 */

export const LEGACY_INDEXES = Object.freeze({
  departments: ["name_1"],
  shifts: ["name_1"],
  students: [
    "studentId_1_department_1_batch_1_shift_1",
    "studentId_1",
    "roll_1_department_1_batch_1_shift_1",
    "department_1_batch_1_shift_1",
  ],
  subjects: ["department_1_batch_1"],
});

export const isIndexNotFound = (e) => e?.code === 27 || e?.codeName === "IndexNotFound" || /index not found/i.test(String(e?.message));
export const isNamespaceMissing = (e) => e?.code === 26 || e?.codeName === "NamespaceNotFound" || /ns does not exist|does not exist/i.test(String(e?.message));

/**
 * @param {Record<string, import("mongoose").Model>} models  keyed by collection name
 * @returns {Promise<{dropped: string[], built: string[]}>}
 */
export const migrateAcademicIndexes = async (models) => {
  const dropped = [];
  const built = [];
  for (const [collName, Model] of Object.entries(models)) {
    let existing = [];
    try {
      existing = (await Model.collection.indexes()).map((i) => i.name);
    } catch (e) {
      if (!isNamespaceMissing(e)) throw e; // brand-new database: nothing to drop
    }
    for (const name of LEGACY_INDEXES[collName] || []) {
      if (!existing.includes(name)) continue;
      try {
        await Model.collection.dropIndex(name);
        dropped.push(`${collName}.${name}`);
      } catch (e) {
        if (!isIndexNotFound(e)) throw e;
      }
    }
    await Model.createIndexes();
    built.push(collName);
  }
  return { dropped, built };
};
