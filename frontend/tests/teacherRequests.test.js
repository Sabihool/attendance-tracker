import test from 'node:test'
import assert from 'node:assert/strict'
import {
  formatRegisteredAt, timeAgo, formatCollege, decisionFailure, badgeLabel, toPanelNotification, STATUS_TABS,
} from '../src/utils/teacherRequests.js'

test('formatRegisteredAt gives a readable absolute time and tolerates bad input', () => {
  const out = formatRegisteredAt('2026-10-03T09:22:00.000Z', 'en-GB')
  assert.match(out, /2026/)
  assert.equal(formatRegisteredAt(undefined), '—')
  assert.equal(formatRegisteredAt('nonsense'), '—')
})

test('timeAgo buckets', () => {
  const now = Date.parse('2026-10-03T12:00:00Z')
  assert.equal(timeAgo('2026-10-03T11:59:40Z', now), 'just now')
  assert.equal(timeAgo('2026-10-03T11:55:00Z', now), '5 min ago')
  assert.equal(timeAgo('2026-10-03T09:00:00Z', now), '3 h ago')
  assert.equal(timeAgo('2026-10-01T12:00:00Z', now), '2 d ago')
  assert.equal(timeAgo('bad', now), '')
})

test('formatCollege shows name with place, and a fallback', () => {
  assert.equal(formatCollege({ name: 'Alpha College', district: 'Feni', country: 'Bangladesh' }), 'Alpha College · Feni, Bangladesh')
  assert.equal(formatCollege({ name: 'Alpha College' }), 'Alpha College')
  assert.equal(formatCollege(null), 'No college assigned')
})

test('decisionFailure: conflicts and permission problems refresh the list and explain why', () => {
  const c = decisionFailure({ response: { status: 409, data: { message: 'This request was already approved.', currentStatus: 'approved' } } })
  assert.equal(c.refresh, true); assert.equal(c.conflict, true); assert.equal(c.currentStatus, 'approved')
  assert.equal(decisionFailure({ response: { status: 403, data: { message: 'Your college is suspended.' } } }).refresh, true)
  assert.equal(decisionFailure({ response: { status: 404, data: {} } }).refresh, true)
  const net = decisionFailure({ message: 'Network Error' })
  assert.equal(net.refresh, false); assert.equal(net.message, 'Network Error')
})

test('badgeLabel', () => {
  assert.equal(badgeLabel(0), ''); assert.equal(badgeLabel(undefined), '')
  assert.equal(badgeLabel(4), '4'); assert.equal(badgeLabel(25), '9+')
})

test('toPanelNotification keeps string ids and falls back to title', () => {
  const n = toPanelNotification({ id: 'abc', type: 't', title: 'Hello', read: 0, createdAt: 'x' })
  assert.equal(n.id, 'abc'); assert.equal(n.message, 'Hello'); assert.equal(n.read, false)
})

test('tabs: pending first, includes rejected', () => {
  assert.deepEqual(STATUS_TABS.map(t => t.value), ['pending', 'approved', 'rejected', 'all'])
})
