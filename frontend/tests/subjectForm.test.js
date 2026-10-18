import test from 'node:test'
import assert from 'node:assert/strict'
import {
  pickSubjectFields, SUBJECT_CREATE_FIELDS, SUBJECT_EDIT_FIELDS, assignedTeacherId, assignedTeacherName,
  teacherOptionLabel, isReassignment, subjectErrorMessage,
} from '../src/utils/subjectForm.js'
import { stripCollegeFields } from '../src/utils/academicStructure.js'

test('pickSubjectFields keeps only accepted keys: a whole subject read from the API is not posted back', () => {
  const fromApi = {
    _id: 's1', subjectName: 'Networks', subjectCode: 'CSE-101', batch: '2024', department: 'CS', shift: 'Morning',
    teacher: { _id: 't1', name: 'Rina', email: 'r@x.com' }, collegeId: 'COL-X', createdAt: 'x', updatedAt: 'y', isArchived: false,
  }
  assert.deepEqual(pickSubjectFields(fromApi, ['subjectName', 'subjectCode']), { subjectName: 'Networks', subjectCode: 'CSE-101' })
  const edit = pickSubjectFields(fromApi)
  for (const k of ['_id', 'teacher', 'collegeId', 'createdAt', 'updatedAt']) assert.ok(!(k in edit), k)
  assert.equal(edit.isArchived, false, 'false is a real value and is kept')
})

test('pickSubjectFields drops an empty teacherId (= keep the default owner) but keeps a chosen one', () => {
  assert.deepEqual(pickSubjectFields({ subjectName: 'A', teacherId: '' }, SUBJECT_CREATE_FIELDS), { subjectName: 'A' })
  assert.deepEqual(pickSubjectFields({ subjectName: 'A', teacherId: null }, SUBJECT_CREATE_FIELDS), { subjectName: 'A' })
  assert.deepEqual(pickSubjectFields({ teacherId: 't9' }, SUBJECT_EDIT_FIELDS), { teacherId: 't9' })
  assert.deepEqual(pickSubjectFields(null), {})
})

test('a college field can never survive stripCollegeFields + pickSubjectFields', () => {
  const out = pickSubjectFields(stripCollegeFields({ subjectName: 'A', collegeId: 'COL-X', tenant: 'x', college: 'y' }), SUBJECT_CREATE_FIELDS)
  assert.deepEqual(out, { subjectName: 'A' })
  assert.ok(!SUBJECT_CREATE_FIELDS.concat(SUBJECT_EDIT_FIELDS).some((k) => /college|tenant/i.test(k)))
})

test('assigned teacher helpers tolerate populated, plain and hidden (null) teachers', () => {
  assert.equal(assignedTeacherId({ teacher: { _id: 't1', name: 'R' } }), 't1')
  assert.equal(assignedTeacherId({ teacher: 't2' }), 't2')
  assert.equal(assignedTeacherId({ teacher: null }), '')
  assert.equal(assignedTeacherId(undefined), '')
  assert.equal(assignedTeacherName({ teacher: { name: 'Rina' } }), 'Rina')
  assert.equal(assignedTeacherName({ teacher: null }), '—')
  assert.equal(teacherOptionLabel({ name: 'Rina', department: 'CST' }), 'Rina — CST')
  assert.equal(teacherOptionLabel({ name: 'Rina', department: '' }), 'Rina')
})

test('isReassignment is true only for a different, non-empty teacher', () => {
  const s = { teacher: { _id: 't1' } }
  assert.equal(isReassignment(s, 't1'), false)
  assert.equal(isReassignment(s, ''), false)
  assert.equal(isReassignment(s, 't2'), true)
  assert.equal(isReassignment({ teacher: null }, 't2'), true)
})

test('subjectErrorMessage: 404 means not in your college / gone; others show the server text', () => {
  const err = (status, message) => ({ response: { status, data: { message } } })
  assert.match(subjectErrorMessage(err(404, 'Subject not found.')), /not found in your college/i)
  assert.equal(subjectErrorMessage(err(403, 'Only an administrator can assign a subject to another teacher.')), 'Only an administrator can assign a subject to another teacher.')
  assert.match(subjectErrorMessage(err(403)), /not allowed/i)
  assert.equal(subjectErrorMessage(err(400, 'Teacher not found in your college.')), 'Teacher not found in your college.')
  assert.equal(subjectErrorMessage(err(409, "You already have a subject with code 'X'.")), "You already have a subject with code 'X'.")
  assert.equal(subjectErrorMessage({ message: 'Network Error' }), 'Network Error')
  assert.equal(subjectErrorMessage({}), 'Something went wrong')
})
