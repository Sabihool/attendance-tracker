import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeQuery, shouldSearch, formatCollegeMeta, moveIndex, toSelection,
  isValidSelection, searchErrorMessage, isCanceled, MAX_QUERY_LENGTH,
} from '../src/utils/collegeSearch.js'

test('normalizeQuery trims, collapses spaces, caps length, tolerates non-strings', () => {
  assert.equal(normalizeQuery('  Feni   Computer '), 'Feni Computer')
  assert.equal(normalizeQuery(null), '')
  assert.equal(normalizeQuery(undefined), '')
  assert.equal(normalizeQuery('x'.repeat(500)).length, MAX_QUERY_LENGTH)
})

test('shouldSearch needs 2+ real characters (empty query never calls the API)', () => {
  for (const q of ['', ' ', 'f', '  f  ', null]) assert.equal(shouldSearch(q), false)
  for (const q of ['fe', ' fe ', 'Feni']) assert.equal(shouldSearch(q), true)
})

test('formatCollegeMeta shows "District, Country" and skips blanks', () => {
  assert.equal(formatCollegeMeta({ district: 'Feni', country: 'Bangladesh' }), 'Feni, Bangladesh')
  assert.equal(formatCollegeMeta({ country: 'Bangladesh' }), 'Bangladesh')
  assert.equal(formatCollegeMeta(null), '')
})

test('moveIndex wraps around and handles empty lists', () => {
  assert.equal(moveIndex(-1, 3, 'down'), 0)
  assert.equal(moveIndex(2, 3, 'down'), 0)
  assert.equal(moveIndex(0, 3, 'up'), 2)
  assert.equal(moveIndex(-1, 3, 'up'), 2)
  assert.equal(moveIndex(1, 3, 'home'), 0)
  assert.equal(moveIndex(0, 3, 'end'), 2)
  assert.equal(moveIndex(0, 0, 'down'), -1)
})

test('toSelection keeps only public fields', () => {
  const s = toSelection({ collegeId: 'COL-AAAAAAAAAA', name: 'A', district: 'B', country: 'C', secret: 'x' })
  assert.deepEqual(Object.keys(s).sort(), ['collegeId', 'country', 'district', 'name'])
})

test('isValidSelection rejects typed text / partial objects', () => {
  assert.equal(isValidSelection(null), false)
  assert.equal(isValidSelection('Feni Computer Institute'), false)
  assert.equal(isValidSelection({ name: 'Feni' }), false)
  assert.equal(isValidSelection({ collegeId: 'nope', name: 'Feni' }), false)
  assert.equal(isValidSelection({ collegeId: 'COL-7K2M9XQ4TB', name: 'Feni' }), true)
})

test('searchErrorMessage distinguishes rate limit, offline and server errors', () => {
  assert.match(searchErrorMessage({ response: { status: 429 } }), /Too many searches/)
  assert.match(searchErrorMessage({ message: 'Network Error' }), /Can't reach the server/)
  assert.equal(searchErrorMessage({ response: { status: 400, data: { message: 'Bad' } } }), 'Bad')
  assert.match(searchErrorMessage({ response: { status: 500, data: {} } }), /try again/i)
})

test('isCanceled recognises aborted requests', () => {
  assert.equal(isCanceled({ code: 'ERR_CANCELED' }), true)
  assert.equal(isCanceled({ name: 'CanceledError' }), true)
  assert.equal(isCanceled({ name: 'AbortError' }), true)
  assert.equal(isCanceled(new Error('x')), false)
})
