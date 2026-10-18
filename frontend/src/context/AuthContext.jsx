/**
 * context/AuthContext.jsx
 * Real API-backed authentication context.
 */
import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { authAPI, getErrorMessage } from '@services/api'
import { TOKEN_KEY, USER_KEY } from '@constants/app'
import { shouldClearSessionOnMeError } from '../utils/sessionErrors.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser]       = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const init = async () => {
      const storedToken = localStorage.getItem(TOKEN_KEY)
      const storedUser  = localStorage.getItem(USER_KEY)

      if (!storedToken || !storedUser) {
        setLoading(false)
        return
      }

      try {
        const parsedUser = JSON.parse(storedUser)
        setUser(parsedUser)
      } catch {
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(USER_KEY)
        setLoading(false)
        return
      }

      try {
        const res       = await authAPI.getMe()
        const freshUser = res.data?.data?.user
        if (!freshUser) throw new Error('Unexpected /auth/me response shape')
        setUser(freshUser)
        localStorage.setItem(USER_KEY, JSON.stringify(freshUser))
      } catch (err) {
        if (shouldClearSessionOnMeError(err)) {
          // Token invalid / account no longer allowed — clear state but don't hard-redirect here
          setUser(null)
          localStorage.removeItem(TOKEN_KEY)
          localStorage.removeItem(USER_KEY)
        }
        // Network error or 5xx: keep the stored session (user already set above from storage);
        // a server blip at page load must not sign everyone out.
      } finally {
        setLoading(false)
      }
    }
    init()
  }, [])

  const login = useCallback(async (email, password) => {
    try {
      const res  = await authAPI.login({ email, password })
      const data = res.data?.data
      if (!data?.token || !data?.user) {
        return { success: false, error: 'Invalid response from server' }
      }
      localStorage.setItem(TOKEN_KEY, data.token)
      localStorage.setItem(USER_KEY, JSON.stringify(data.user))
      setUser(data.user)
      return { success: true, user: data.user }
    } catch (error) {
      return { success: false, error: getErrorMessage(error), code: error?.response?.data?.code }
    }
  }, [])

  const signup = useCallback(async (userData) => {
    try {
      const res = await authAPI.signup(userData)
      // { college: { collegeId, name }, status: 'pending' } — no token: the account is not active yet
      return { success: true, college: res.data?.data?.college || null }
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
        fieldErrors: error?.response?.data?.errors,
      }
    }
  }, [])

  // Creates a college + its first admin, then signs that admin in.
  const registerCollege = useCallback(async (formData) => {
    try {
      const res  = await authAPI.registerCollege({
        collegeName: formData.collegeName, country: formData.country, district: formData.district,
        adminName: formData.adminName, adminEmail: formData.adminEmail,
        password: formData.password, confirmPassword: formData.confirmPassword,
      })
      const data = res.data?.data
      if (!data?.token || !data?.user || !data?.college) {
        return { success: false, error: 'Invalid response from server' }
      }
      localStorage.setItem(TOKEN_KEY, data.token)
      const signedInUser = { ...data.user, college: data.college || data.user.college || null }
      localStorage.setItem(USER_KEY, JSON.stringify(signedInUser))
      setUser(signedInUser)
      return { success: true, user: signedInUser, college: data.college }
    } catch (error) {
      return {
        success: false,
        error: getErrorMessage(error),
        fieldErrors: error?.response?.data?.errors,
      }
    }
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    setUser(null)
  }, [])

  const refreshUser = useCallback(async () => {
    try {
      const res       = await authAPI.getMe()
      const freshUser = res.data?.data?.user
      if (freshUser) {
        setUser(freshUser)
        localStorage.setItem(USER_KEY, JSON.stringify(freshUser))
      }
    } catch { /* silent */ }
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, isAuthenticated: !!user, login, signup, registerCollege, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
