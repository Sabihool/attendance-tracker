/**
 * attendanceUtils.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared attendance calculation utilities.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * Aggregate per-student attendance stats from an array of Attendance records.
 *
 * @param {Array} records - Array of Attendance lean documents
 * @param {Object} [creditMap] - { categoryNameLowercase: credit } fallback map
 *   for legacy records that predate the classWeight snapshot. Get one via
 *   utils/creditUtils.js#getCategoryCreditMap().
 * @returns {Array<{ studentId, roll, name, attended, total, percentage }>}
 */
export const aggregateStudentStats = (records, creditMap = {}) => {
  const studentMap = new Map();

  for (const record of records) {
    const weight = record.classWeight ?? creditMap[record.classType?.toLowerCase()] ?? 1;

    for (const s of record.students) {
      if (!studentMap.has(s.studentId)) {
        studentMap.set(s.studentId, {
          studentId: s.studentId,
          roll: s.roll,
          name: s.name,
          attended: 0,
          total: 0,
        });
      }

      const entry = studentMap.get(s.studentId);
      entry.total += weight;
      if (s.status === "present") {
        entry.attended += weight;
      }
    }
  }

  return Array.from(studentMap.values()).map((entry) => ({
    ...entry,
    percentage:
      entry.total > 0 ? Math.round((entry.attended / entry.total) * 100) : 0,
  }));
};
