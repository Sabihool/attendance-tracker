import test from 'node:test'
import assert from 'node:assert/strict'
import {
  stripCollegeFields, stripCollegeFormData, isDuplicateName, groupDeleteConfirm, academicErrorMessage, namesFrom,
} from '../src/utils/academicStructure.js'

test('stripCollegeFields removes every college/tenant key (any case) and keeps the rest', () => {
  const out = stripCollegeFields({ name: 'CST', collegeId: 'COL-X', College: 'x', tenant_id: 'y', order: 2 })
  assert.deepEqual(out, { name: 'CST', order: 2 })
})

test('stripCollegeFields leaves non-plain payloads alone and does not mutate the input', () => {
  const input = { name: 'A', collegeId: 'COL-X' }
  stripCollegeFields(input)
  assert.equal(input.collegeId, 'COL-X')
  assert.equal(stripCollegeFields(null), null)
  assert.equal(stripCollegeFields('x'), 'x')
  const arr = [1]
  assert.equal(stripCollegeFields(arr), arr)
})

test('stripCollegeFormData removes college fields from an upload form', () => {
  const fd = new FormData()
  fd.append('department', 'CST'); fd.append('collegeId', 'COL-X'); fd.append('batch', '2024')
  stripCollegeFormData(fd)
  assert.deepEqual([...fd.keys()], ['department', 'batch'])
})

test('isDuplicateName: case-insensitive, trims, ignores own id on rename', () => {
  const list = [{ _id: '1', name: 'Computer Science' }, { _id: '2', name: 'Civil' }]
  assert.equal(isDuplicateName(list, '  computer science '), true)
  assert.equal(isDuplicateName(list, 'Computer Science', '1'), false)
  assert.equal(isDuplicateName(list, 'Computer Science', '2'), true)
  assert.equal(isDuplicateName(list, 'Physics'), false)
  assert.equal(isDuplicateName(list, '   '), false)
  assert.equal(isDuplicateName(['Day', 'Morning'], 'MORNING'), true)
  assert.equal(isDuplicateName(undefined, 'x'), false)
})

test('a name that is a duplicate in college A is NOT a duplicate in college B (lists are per college)', () => {
  const alpha = [{ _id: '1', name: 'Computer Science' }]
  const beta = []
  assert.equal(isDuplicateName(alpha, 'Computer Science'), true)
  assert.equal(isDuplicateName(beta, 'Computer Science'), false)
})

test('groupDeleteConfirm names the group and the college, and says other colleges are safe', () => {
  const t = groupDeleteConfirm({ department: 'CST', batch: '2024', shift: 'Morning', collegeName: 'Alpha Polytechnic' })
  assert.match(t, /CST \/ Batch 2024 \/ Morning at Alpha Polytechnic/)
  assert.match(t, /Other colleges are not affected/)
  assert.doesNotMatch(groupDeleteConfirm({ department: 'A', batch: '1', shift: 'M' }), / at /)
})

test('academicErrorMessage: 404 → college-aware text, 409 → server text, 403 → admin only', () => {
  assert.match(academicErrorMessage({ response: { status: 404, data: { message: 'Department not found' } } }), /your college/)
  assert.equal(academicErrorMessage({ response: { status: 409, data: { message: 'Cannot delete "CST" — it is used by 2 student(s)' } } }), 'Cannot delete "CST" — it is used by 2 student(s)')
  assert.match(academicErrorMessage({ response: { status: 403 } }), /admin/)
  assert.equal(academicErrorMessage({ message: 'Network Error' }), 'Network Error')
  assert.equal(academicErrorMessage({}, 'oops'), 'oops')
})

test('namesFrom tolerates missing or malformed responses', () => {
  assert.deepEqual(namesFrom({ data: { data: { departments: ['A', 'B', 3, null] } } }), ['A', 'B'])
  assert.deepEqual(namesFrom({ data: { data: { shifts: ['Day'] } } }, 'shifts'), ['Day'])
  assert.deepEqual(namesFrom(undefined), [])
  assert.deepEqual(namesFrom({ data: { data: { departments: 'x' } } }), [])
})
