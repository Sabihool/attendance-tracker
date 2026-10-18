/**
 * Monthly attendance trend built ONLY from real session summaries.
 * Months with no recorded sessions get `attendance: null` (never an invented number).
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Add one subject's session records into the running { 'YYYY-M': { present, total } } map. */
export const addRecordsToMonthMap = (byMonth, records = []) => {
  for (const r of records) {
    const d = new Date(r?.date)
    const total = r?.summary?.totalStudents ?? 0
    if (Number.isNaN(d.getTime()) || !total) continue
    const key = `${d.getFullYear()}-${d.getMonth()}`
    byMonth[key] ??= { present: 0, total: 0 }
    byMonth[key].present += r.summary?.presentCount ?? 0
    byMonth[key].total += total
  }
  return byMonth
}

/** The last `months` calendar months (oldest first) ending with the month of `now`. */
export const buildTrend = (byMonth, now = new Date(), months = 6) =>
  Array.from({ length: months }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (months - 1) + i, 1)
    const m = byMonth[`${d.getFullYear()}-${d.getMonth()}`]
    return { month: MONTHS[d.getMonth()], attendance: m ? Math.round((m.present / m.total) * 100) : null }
  })
