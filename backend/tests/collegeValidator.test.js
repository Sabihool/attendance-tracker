import test from "node:test";
import assert from "node:assert/strict";
import { validateCollegeRegistration, buildDedupeKey, cleanText } from "../validators/collegeValidator.js";

const good = () => ({
  collegeName: "Feni Computer Institute",
  country: "Bangladesh",
  district: "Feni",
  adminName: "Sabihool Alam",
  adminEmail: "Admin@Example.com ",
  password: "Secret123",
  confirmPassword: "Secret123",
});

test("accepts a valid payload and normalises it", () => {
  const r = validateCollegeRegistration(good());
  assert.equal(r.ok, true);
  assert.equal(r.values.adminEmail, "admin@example.com");
});

test("drops privileged / unknown fields", () => {
  const r = validateCollegeRegistration({ ...good(), role: "teacher", collegeId: "COL-HACK", approved: false });
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.values).sort(),
    ["adminEmail", "adminName", "collegeName", "country", "district", "password"]);
});

test("requires every field", () => {
  const r = validateCollegeRegistration({});
  assert.equal(r.ok, false);
  for (const k of ["collegeName", "country", "district", "adminName", "adminEmail", "password", "confirmPassword"])
    assert.ok(r.errors[k], `missing error for ${k}`);
});

test("rejects non-string values (NoSQL-style payloads)", () => {
  const r = validateCollegeRegistration({ ...good(), adminEmail: { $gt: "" }, collegeName: ["x"] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.adminEmail);
  assert.ok(r.errors.collegeName);
});

test("rejects non-object bodies", () => {
  for (const b of [null, undefined, "str", 5, []]) assert.equal(validateCollegeRegistration(b).ok, false);
});

test("email validation", () => {
  for (const e of ["nope", "a@b", "a@@b.com", "a b@c.com", "x@y..com"])
    assert.ok(validateCollegeRegistration({ ...good(), adminEmail: e }).errors.adminEmail, e);
});

test("password rules", () => {
  const bad = { short: "Ab1", noDigit: "abcdefgh", noLetter: "12345678", long: "a1".repeat(40) };
  for (const [k, p] of Object.entries(bad)) {
    const r = validateCollegeRegistration({ ...good(), password: p, confirmPassword: p });
    assert.ok(r.errors.password, k);
  }
});

test("password mismatch is reported on confirmPassword", () => {
  const r = validateCollegeRegistration({ ...good(), confirmPassword: "Different1" });
  assert.equal(r.errors.confirmPassword, "Passwords do not match.");
});

test("rejects markup / junk in names", () => {
  assert.ok(validateCollegeRegistration({ ...good(), collegeName: "<script>alert(1)</script>" }).errors.collegeName);
  assert.ok(validateCollegeRegistration({ ...good(), country: "B4ngladesh" }).errors.country);
  assert.ok(validateCollegeRegistration({ ...good(), district: "Feni!!" }).errors.district);
  assert.ok(validateCollegeRegistration({ ...good(), adminName: "R0bot" }).errors.adminName);
});

test("accepts non-ASCII names", () => {
  const r = validateCollegeRegistration({ ...good(), collegeName: "ফেনী কম্পিউটার ইনস্টিটিউট", adminName: "José Núñez" });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});

test("dedupe key ignores case, spacing and accents", () => {
  const a = buildDedupeKey({ name: "Feni  Computer Institute", country: "Bangladesh", district: "Feni" });
  const b = buildDedupeKey({ name: " feni computer institute ", country: "BANGLADESH", district: "féni" });
  assert.equal(a, b);
  assert.equal(cleanText("  a   b "), "a b");
});
