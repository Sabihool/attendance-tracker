import test from 'node:test'
import assert from 'node:assert/strict'
import { addRecordsToMonthMap, buildTrend } from '../src/utils/attendanceTrend.js'
import { isSessionEndingResponse, shouldClearSessionOnMeError } from '../src/utils/sessionErrors.js'

const rec = (date, present, total) => ({ date, summary: { presentCount: present, totalStudents: total } })

test('trend: real percentages per month, null (never random) for months without sessions', () => {
  const m = addRecordsToMonthMap({}, [rec('2026-10-02', 8, 10), rec('2026-10-09', 6, 10), rec('2026-08-15', 5, 10)])
  const t = buildTrend(m, new Date(2026, 9, 18))
  assert.deepEqual(t.map((x) => x.month), ['May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'])
  assert.deepEqual(t.map((x) => x.attendance), [null, null, null, 50, null, 70])
  assert.deepEqual(buildTrend(m, new Date(2026, 9, 18)), t, 'deterministic')
})

test('trend: ignores bad dates and empty sessions; spans subjects and year boundary', () => {
  const m = {}
  addRecordsToMonthMap(m, [rec('not-a-date', 1, 1), rec('2026-01-05', 0, 0), rec('2025-12-20', 9, 10)])
  addRecordsToMonthMap(m, [rec('2025-12-21', 1, 10)])
  const t = buildTrend(m, new Date(2026, 0, 31))
  assert.equal(t[4].month, 'Dec'); assert.equal(t[4].attendance, 50)
  assert.equal(t[5].month, 'Jan'); assert.equal(t[5].attendance, null)
})

test('session: 401 and account-ending 403 codes sign out; ordinary 403/404/500 do not', () => {
  assert.equal(isSessionEndingResponse({ status: 401 }), true)
  for (const code of ['ACCOUNT_REJECTED', 'COLLEGE_SUSPENDED', 'COLLEGE_UNAVAILABLE', 'NO_COLLEGE', 'ACCOUNT_PENDING']) {
    assert.equal(isSessionEndingResponse({ status: 403, data: { code } }), true, code)
  }
  assert.equal(isSessionEndingResponse({ status: 403, data: { code: 'FORBIDDEN' } }), false)
  assert.equal(isSessionEndingResponse({ status: 404 }), false)
  assert.equal(isSessionEndingResponse(undefined), false)
})

test('session: a network error or 5xx on /auth/me keeps the stored session; 401/403 clears it', () => {
  assert.equal(shouldClearSessionOnMeError(new Error('Network Error')), false)
  assert.equal(shouldClearSessionOnMeError({ response: { status: 503 } }), false)
  assert.equal(shouldClearSessionOnMeError({ response: { status: 401 } }), true)
  assert.equal(shouldClearSessionOnMeError({ response: { status: 403 } }), true)
})
