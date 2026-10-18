import test from 'node:test'
import assert from 'node:assert/strict'
import { activitySummary, confirmMessage, actionFailure, roleChangeNotice, TYPE_TABS } from '../src/utils/teacherManagement.js'

test('activitySummary words subjects, sessions and recency', () => {
  const now = Date.parse('2026-10-16T00:00:00Z')
  assert.equal(activitySummary({ totalSubjects: 1, totalSessions: 2, lastAttendanceDate: '2026-10-13T00:00:00Z' }, now), '1 subject · 2 sessions · last session 3 d ago')
  assert.equal(activitySummary({ totalSubjects: 0, totalSessions: 0, lastAttendanceDate: null }, now), '0 subjects · 0 sessions · no sessions yet')
  assert.equal(activitySummary(null), '')
})

test('confirmMessage names the person and warns about the sign-in', () => {
  const m = { name: 'Rafi' }
  assert.match(confirmMessage('promote', m), /Rafi.*administrator.*sign in again/)
  assert.match(confirmMessage('demote', m), /Rafi.*teacher/)
  assert.match(confirmMessage('remove', m), /permanently/)
})

test('actionFailure maps server codes to clear text and refreshes on conflicts', () => {
  const f = actionFailure({ response: { status: 403, data: { code: 'FOUNDER_PROTECTED', message: 'x' } } })
  assert.match(f.message, /original administrator/); assert.equal(f.refresh, true)
  assert.match(actionFailure({ response: { status: 409, data: { code: 'LAST_ADMIN' } } }).message, /at least one administrator/)
  const net = actionFailure({ message: 'Network Error' })
  assert.equal(net.message, 'Network Error'); assert.equal(net.refresh, false)
})

test('roleChangeNotice and tabs', () => {
  assert.equal(roleChangeNotice('promote', 'A'), 'A is now an administrator')
  assert.equal(roleChangeNotice('demote', 'A'), 'A is now a teacher')
  assert.deepEqual(TYPE_TABS.map((t) => t.value), ['teacher', 'admin', 'all'])
})
