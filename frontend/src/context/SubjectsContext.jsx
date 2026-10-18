/**
 * SubjectsContext.jsx — Real API-backed subjects
 * Part 20: Full Integration
 */
import { createContext, useContext, useState, useCallback } from 'react'
import { subjectAPI } from '@services/api'
import { subjectErrorMessage } from '@utils/subjectForm'
import toast from 'react-hot-toast'

const SubjectsContext = createContext(null)

export function SubjectsProvider({ children }) {
  const [subjects, setSubjects]   = useState([])
  const [loading, setLoading]     = useState(false)
  const [meta, setMeta]           = useState(null)
  const [teachers, setTeachers]   = useState([])  // admin only: this college's assignable teachers

  const fetchSubjects = useCallback(async (params) => {
    setLoading(true)
    try {
      const res = await subjectAPI.getAll(params)
      const raw = res.data?.data
      const data = raw?.subjects || raw || []
      setSubjects(Array.isArray(data) ? data : [])
      return { success: true, data }
    } catch (error) {
      const msg = subjectErrorMessage(error)
      toast.error(msg)
      return { success: false, error: msg }
    } finally {
      setLoading(false)
    }
  }, [])

  const fetchMeta = useCallback(async () => {
    try {
      const res = await subjectAPI.getMeta()
      const m = res.data?.data || res.data; // data.data contains { departments, shifts, creditTypes, colors }
      setMeta(m)
      return m
    } catch {
      return null
    }
  }, [])

  const fetchTeachers = useCallback(async () => {
    try {
      const res = await subjectAPI.getTeachers()
      const list = res.data?.data?.teachers
      setTeachers(Array.isArray(list) ? list : [])
      return Array.isArray(list) ? list : []
    } catch {
      setTeachers([])
      return []
    }
  }, [])

  const addSubject = useCallback(async (data) => {
    try {
      const res = await subjectAPI.create(data)
      const newSubject = res.data?.data?.subject || res.data?.data || res.data
      setSubjects(prev => [newSubject, ...prev])
      toast.success('Subject created successfully!')
      return { success: true, data: newSubject }
    } catch (error) {
      const msg = subjectErrorMessage(error)
      toast.error(msg)
      return { success: false, error: msg }
    }
  }, [])

  const updateSubject = useCallback(async (id, data) => {
    try {
      const res = await subjectAPI.update(id, data)
      const updated = res.data?.data?.subject || res.data?.data || res.data
      setSubjects(prev => prev.map(s => s._id === id ? updated : s))
      toast.success('Subject updated!')
      return { success: true, data: updated }
    } catch (error) {
      const msg = subjectErrorMessage(error)
      toast.error(msg)
      return { success: false, error: msg }
    }
  }, [])

  const deleteSubject = useCallback(async (id, acknowledged = false) => {
    try {
      await subjectAPI.delete(id, acknowledged)
      setSubjects(prev => prev.filter(s => s._id !== id))
      toast.success('Subject and all its attendance data were permanently deleted.')
      return { success: true }
    } catch (error) {
      const msg = subjectErrorMessage(error)
      toast.error(msg)
      return { success: false, error: msg }
    }
  }, [])

  return (
    <SubjectsContext.Provider value={{
      subjects,
      loading,
      meta,
      teachers,
      fetchSubjects,
      fetchMeta,
      fetchTeachers,
      addSubject,
      updateSubject,
      deleteSubject,
    }}>
      {children}
    </SubjectsContext.Provider>
  )
}

export function useSubjects() {
  const ctx = useContext(SubjectsContext)
  if (!ctx) throw new Error('useSubjects must be used within SubjectsProvider')
  return ctx
}
