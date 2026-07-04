import { Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Production from './pages/Production'
import Payroll from './pages/Payroll'
import Settings from './pages/Settings'
import Unauthorized from './pages/Unauthorized'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      {/* Any signed-in user */}
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/unauthorized" element={<Unauthorized />} />

          {/* Role-restricted areas */}
          <Route element={<ProtectedRoute allowedRoles={['admin', 'manager', 'operator']} />}>
            <Route path="/production" element={<Production />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['admin', 'manager']} />}>
            <Route path="/payroll" element={<Payroll />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
