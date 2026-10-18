import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanField, validateLookupForm, buildLookupPayload, lookupError, statusTone, percentTone, percentLabel, EMPTY_LOOKUP_FORM,
} from '../src/utils/publicLookup.js'

const college = { collegeId: 'COL-AAAAAAAAAA', name: 'Alpha', district: 'Feni', country: 'Bangladesh' }
const form = { department: ' CST ', batch: '2024', shift: 'Morning', roll: ' 17 ' }

test('validateLookupForm requires a chosen college and every field', () => {
  assert.deepEqual(validateLookupForm(college, form), {})
  const e = validateLookupForm(null, EMPTY_LOOKUP_FORM)
  assert.deepEqual(Object.keys(e).sort(), ['batch', 'college', 'department', 'roll', 'shift'])
  assert.ok(validateLookupForm({ collegeId: 'typed text', name: 'x' }, form).college)
  assert.ok(validateLookupForm(college, { ...form, roll: 'x'.repeat(65) }).roll)
})

test('buildLookupPayload sends ONLY collegeId + the four typed fields, cleaned', () => {
  const p = buildLookupPayload({ ...college, secret: 1 }, { ...form, studentId: 'REG-1', _id: 'abc' })
  assert.deepEqual(p, { collegeId: 'COL-AAAAAAAAAA', department: 'CST', batch: '2024', shift: 'Morning', roll: '17' })
})

test('cleanField collapses whitespace and tolerates non-strings', () => {
  assert.equal(cleanField('  a   b '), 'a b')
  assert.equal(cleanField(null), '')
  assert.equal(cleanField(5), '')
})

test('lookupError maps statuses to friendly kinds', () => {
  assert.equal(lookupError({}).kind, 'network')
  assert.equal(lookupError({ response: { status: 404, data: { message: 'nope' } } }).message, 'nope')
  assert.equal(lookupError({ response: { status: 409, data: {} } }).kind, 'ambiguous')
  assert.equal(lookupError({ response: { status: 429, data: {} } }).kind, 'throttled')
  assert.deepEqual(lookupError({ response: { status: 400, data: { errors: { roll: 'bad' } } } }).fields, { roll: 'bad' })
  assert.equal(lookupError({ response: { status: 500, data: {} } }).kind, 'server')
})

test('statusTone / percentLabel', () => {
  assert.equal(statusTone('Critical'), 'danger')
  assert.equal(statusTone('Excellent'), 'success')
  assert.equal(statusTone('???'), 'info')
  assert.equal(percentLabel(66.6), '67%')
  assert.equal(percentLabel(undefined), '0%')
})

test('percentTone follows the server status bands', () => {
  assert.deepEqual([0, 49, 50, 64, 65, 74, 75, 100].map(percentTone),
    ['danger', 'danger', 'warning', 'warning', 'info', 'info', 'success', 'success'])
})
