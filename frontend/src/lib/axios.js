/**
 * lib/axios.js
 * Configured Axios instance with JWT interceptors.
 * Imported by services/api.js — do not use directly in components.
 */
import axios from 'axios'
import { TOKEN_KEY, USER_KEY } from '@constants/app'
import { isSessionEndingResponse } from '../utils/sessionErrors.js'

// A production build without VITE_API_URL would silently talk to localhost. Fail loudly instead.
if (import.meta.env.PROD && !import.meta.env.VITE_API_URL) {
  console.error('VITE_API_URL was not set at build time: API requests will go to http://localhost:5000/api. Set it and rebuild.')
}
const BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'


const axiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
})

// Attach JWT token to every request
axiosInstance.interceptors.request.use(
  (config) => {
    // Public endpoints (config.skipAuth) never carry a login token.
    if (config.skipAuth) return config
    const token = localStorage.getItem(TOKEN_KEY)
    if (token) config.headers.Authorization = `Bearer ${token}`
    return config
  },
  (error) => Promise.reject(error)
)

// Handle 401 (and session-ending 403s) — redirect to login except for auth probe endpoints
axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    // Downloads use responseType 'blob'; on failure the JSON error body arrives as a Blob. Decode it so
    // getErrorMessage() can show the server's message instead of "Request failed with status code 4xx".
    const body = error.response?.data
    if (typeof Blob !== 'undefined' && body instanceof Blob && body.type?.includes('json')) {
      try { error.response.data = JSON.parse(await body.text()) } catch { /* leave as is */ }
    }
    const url = error.config?.url || ''
    const isAuthProbe =
      url.includes('/auth/login') ||
      url.includes('/auth/me') ||
      url.includes('/auth/signup') ||
      url.includes('/colleges/register')

    if (isSessionEndingResponse(error.response) && !isAuthProbe) {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(USER_KEY)
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

export default axiosInstance
