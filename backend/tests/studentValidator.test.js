import test from "node:test";
import assert from "node:assert/strict";
import { validateStudentJSON, stripBom, MAX_LISTED_ERRORS } from "../validators/studentValidator.js";

const ok = (n) => Array.from({ length: n }, (_, i) => ({ studentId: `S${i}`, roll: String(i + 1), name: `Student ${i}` }));

test("valid array and { students } wrapper are normalised: trimmed strings, numbers → strings", () => {
  const a = validateStudentJSON([{ studentId: " 7 ", roll: 3, name: "  Ann Lee ", email: " a@b.co ", section: 2 }]);
  assert.equal(a.valid, true);
  assert.deepEqual(a.students, [{ studentId: "7", roll: "3", name: "Ann Lee", email: "a@b.co", section: "2" }]);
  assert.equal(validateStudentJSON({ students: ok(2) }).valid, true);
});

test("errors keep the 'Student[i]: …' wording and add index / row / field / code", () => {
  const r = validateStudentJSON([{ studentId: "A", roll: "1", name: "Okay Name" }, { studentId: "B", roll: "", name: "Okay Name" }]);
  assert.equal(r.valid, false);
  assert.deepEqual(r.errors, ['Student[1]: field "roll" must not be empty.']);
  assert.deepEqual(r.details, [{ index: 1, row: 2, studentId: "B", field: "roll", code: "EMPTY_FIELD", message: 'Student[1]: field "roll" must not be empty.' }]);
  assert.equal(r.totalErrors, 1);
});

test("duplicate ids / rolls inside a file are case-insensitive and point at the first occurrence", () => {
  const r = validateStudentJSON([
    { studentId: "ab-1", roll: "X1", name: "First One" },
    { studentId: "AB-1", roll: "x1", name: "Second One" },
  ]);
  assert.deepEqual(r.details.map((d) => d.code), ["DUPLICATE_STUDENT_ID", "DUPLICATE_ROLL"]);
  assert.match(r.errors[0], /already used by Student\[0\]/);
});

test("limits: identifiers 64, name 2..150, email 254, section 50; wrong types are reported, not coerced", () => {
  const long = "x".repeat(65);
  const r = validateStudentJSON([
    { studentId: long, roll: "1", name: "Valid Name" },
    { studentId: "B", roll: "2", name: "n".repeat(151) },
    { studentId: "C", roll: "3", name: "Valid Name", section: { a: 1 }, email: 5 },
    { studentId: "D", roll: true, name: "Valid Name" },
  ]);
  assert.deepEqual(r.details.map((d) => `${d.index}:${d.field}:${d.code}`), [
    "0:studentId:TOO_LONG", "1:name:TOO_LONG", "2:email:WRONG_TYPE", "2:section:WRONG_TYPE", "3:roll:WRONG_TYPE",
  ]);
});

test("all problems are counted; at most 50 are listed", () => {
  const r = validateStudentJSON(Array.from({ length: 60 }, () => ({})));
  assert.equal(r.totalErrors, 180);
  assert.equal(r.details.length, MAX_LISTED_ERRORS);
  assert.match(r.errors.at(-1), /130 more problem\(s\) not listed \(180 in total\)/);
});

test("file-level problems return a single coded error", () => {
  for (const [input, code] of [[null, "BAD_STRUCTURE"], [{ students: 1 }, "BAD_STRUCTURE"], [[], "EMPTY_LIST"], [ok(1001), "TOO_MANY_STUDENTS"]]) {
    const r = validateStudentJSON(input);
    assert.equal(r.valid, false);
    assert.equal(r.details[0].code, code);
  }
  assert.equal(validateStudentJSON(ok(1000)).valid, true);
});

test("stripBom removes only a leading byte-order mark", () => {
  assert.equal(stripBom("\uFEFF[1]"), "[1]");
  assert.equal(stripBom("[\uFEFF1]"), "[\uFEFF1]");
});
