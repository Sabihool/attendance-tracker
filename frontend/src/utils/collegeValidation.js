/**
 * Client-side mirror of backend/validators/collegeValidator.js.
 * For instant feedback only — the server re-validates everything.
 */
const NAME_CHARS   = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'’&()/-]*$/u
const PLACE_CHARS  = /^[\p{L}\p{M}][\p{L}\p{M} .,'’()-]*$/u
const PERSON_CHARS = /^[\p{L}\p{M}][\p{L}\p{M} .,'’-]*$/u
const EMAIL        = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/

const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()

const len = (label, v, min, max) =>
  v.length < min ? `${label} must be at least ${min} characters.`
  : v.length > max ? `${label} cannot exceed ${max} characters.` : null

export function validateCollegeForm(f) {
  const e = {}
  const collegeName = clean(f.collegeName)
  const country     = clean(f.country)
  const district    = clean(f.district)
  const adminName   = clean(f.adminName)
  const adminEmail  = clean(f.adminEmail).toLowerCase()

  if (!collegeName) e.collegeName = 'College name is required.'
  else if (len('College name', collegeName, 2, 120)) e.collegeName = len('College name', collegeName, 2, 120)
  else if (!/\p{L}/u.test(collegeName) || !NAME_CHARS.test(collegeName)) e.collegeName = 'College name contains invalid characters.'

  if (!country) e.country = 'Country is required.'
  else if (len('Country', country, 2, 80)) e.country = len('Country', country, 2, 80)
  else if (!PLACE_CHARS.test(country)) e.country = "Country may only contain letters, spaces and . , ' ( ) -"

  if (!district) e.district = 'District is required.'
  else if (len('District', district, 2, 80)) e.district = len('District', district, 2, 80)
  else if (!PLACE_CHARS.test(district)) e.district = "District may only contain letters, spaces and . , ' ( ) -"

  if (!adminName) e.adminName = 'Admin name is required.'
  else if (len('Admin name', adminName, 2, 100)) e.adminName = len('Admin name', adminName, 2, 100)
  else if (!PERSON_CHARS.test(adminName)) e.adminName = "Admin name may only contain letters, spaces and . ' -"

  if (!adminEmail) e.adminEmail = 'Admin email is required.'
  else if (adminEmail.length > 254 || !EMAIL.test(adminEmail)) e.adminEmail = 'Please enter a valid email address.'

  const pw = f.password || ''
  if (!pw) e.password = 'Password is required.'
  else if (pw.length < 8) e.password = 'Password must be at least 8 characters.'
  else if (new TextEncoder().encode(pw).length > 72) e.password = 'Password is too long (maximum 72 bytes).'
  else if (!/\p{L}/u.test(pw) || !/\d/.test(pw)) e.password = 'Password must contain at least one letter and one number.'
  else if (/^\s|\s$/.test(pw)) e.password = 'Password cannot start or end with a space.'

  if (!f.confirmPassword) e.confirmPassword = 'Please confirm your password.'
  else if (!e.password && pw !== f.confirmPassword) e.confirmPassword = 'Passwords do not match.'

  return e
}
