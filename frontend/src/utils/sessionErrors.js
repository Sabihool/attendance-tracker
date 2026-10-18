/** 403 codes meaning the account can no longer use the app (see backend/utils/authErrors.js). */
export const SESSION_ENDING_403 = new Set(['ACCOUNT_REJECTED', 'ACCOUNT_PENDING', 'COLLEGE_SUSPENDED', 'COLLEGE_UNAVAILABLE', 'NO_COLLEGE'])

/** Should this failed response sign the user out? 401 always; 403 only for the codes above. */
export const isSessionEndingResponse = (response) =>
  response?.status === 401 || (response?.status === 403 && SESSION_ENDING_403.has(response?.data?.code))

/** AuthContext init: clear the stored session only when the server said the token/account is not valid. */
export const shouldClearSessionOnMeError = (err) => {
  const s = err?.response?.status
  return s === 401 || s === 403
}
