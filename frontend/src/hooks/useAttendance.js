import { useState, useCallback } from 'react'
import { attendanceAPI, getErrorMessage } from '@services/api'
import toast from 'react-hot-toast'

export function useAttendance(subjectId) {
  const [sessions, setSessions]     = useState([])
  const [percentage, setPercentage] = useState([])
  const [dates, setDates]           = useState([])
  const [loading, setLoading]       = useState(false)
  const [saving, setSaving]         = useState(false)

  const fetchSessions = useCallback(async (params) => {
    if (!subjectId) return
    setLoading(true)
    try {
      const res = await attendanceAPI.getAll(subjectId, params)
      const data = res.data?.data?.records || res.data?.data || []
      setSessions(data)
      return { success: true, data }
    } catch (error) {
      toast.error(getErrorMessage(error))
      return { success: false }
    } finally {
      setLoading(false)
    }
  }, [subjectId])

  const fetchPercentage = useCallback(async (params) => {
    if (!subjectId) return
    try {
      const res = await attendanceAPI.getPercentage(subjectId, params)
      const data = res.data?.data?.studentStats || res.data?.data || []
      setPercentage(data)
      return { success: true, data }
    } catch (error) {
      toast.error(getErrorMessage(error))
      return { success: false }
    }
  }, [subjectId])

  // Edit Attendance step 2: dates + daily percentage for a subject
  const fetchDates = useCallback(async () => {
    if (!subjectId) return
    setLoading(true)
    try {
      const res = await attendanceAPI.getDates(subjectId)
      const data = res.data?.data?.dates || []
      setDates(data)
      return { success: true, data }
    } catch (error) {
      toast.error(getErrorMessage(error))
      return { success: false }
    } finally {
      setLoading(false)
    }
  }, [subjectId])

  const saveSession = useCallback(async (data) => {
    if (!subjectId) return
    setSaving(true)
    try {
      const res = await attendanceAPI.save(subjectId, data)
      const saved = res.data?.data?.attendance || res.data?.data
      setSessions(prev => saved ? [saved, ...prev] : prev)
      toast.success('Attendance saved successfully!')
      return { success: true, data: saved }
    } catch (error) {
      const msg = getErrorMessage(error)
      toast.error(msg)
      return { success: false, error: msg }
    } finally {
      setSaving(false)
    }
  }, [subjectId])

  // Edit Attendance steps 3-4: flip present/absent on an existing session
  const updateSession = useCallback(async (sessionId, data) => {
    if (!subjectId) return
    setSaving(true)
    try {
      const res = await attendanceAPI.update(subjectId, sessionId, data)
      const updated = res.data?.data?.attendance || res.data?.data
      setSessions(prev => prev.map(s => s._id === sessionId ? updated : s))
      toast.success('Attendance updated successfully!')
      return { success: true, data: updated }
    } catch (error) {
      const msg = getErrorMessage(error)
      toast.error(msg)
      return { success: false, error: msg }
    } finally {
      setSaving(false)
    }
  }, [subjectId])

  const deleteSession = useCallback(async (sessionId) => {
    try {
      await attendanceAPI.delete(subjectId, sessionId)
      setSessions(prev => prev.filter(s => s._id !== sessionId))
      toast.success('Session moved to trash')
      return { success: true }
    } catch (error) {
      toast.error(getErrorMessage(error))
      return { success: false }
    }
  }, [subjectId])

  return {
    sessions, percentage, dates, loading, saving,
    fetchSessions, fetchPercentage, fetchDates,
    saveSession, updateSession, deleteSession,
  }
}

export default useAttendance
