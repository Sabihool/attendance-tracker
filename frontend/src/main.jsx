/**
 * main.jsx — Application Bootstrap
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import '@styles/globals.css'
import App from './App.jsx'
import { AuthProvider } from '@context/AuthContext'
import { SubjectsProvider } from '@context/SubjectsContext'
import { NotificationProvider } from '@context/NotificationContext'

const toastStyle = {
  background: '#ffffff',
  color: '#111827',
  border: '1px solid #E5E7EB',
  borderRadius: '12px',
  fontSize: '14px',
  fontFamily: 'Poppins, sans-serif',
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <SubjectsProvider>
          <NotificationProvider>
            <App />
            <Toaster
              position="top-right"
              toastOptions={{
                duration: 3500,
                style: toastStyle,
              }}
            />
          </NotificationProvider>
        </SubjectsProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>
)
