import { Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import StationDetail from './pages/StationDetail'
import DemoMobile from './pages/DemoMobile'
import Payroll from './pages/Payroll'
import PieceRate from './pages/PieceRate'
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
          <Route path="/station/:stationId" element={<StationDetail />} />
          <Route path="/demo-mobile" element={<DemoMobile />} />
          <Route path="/piece-rate" element={<PieceRate />} />
          <Route path="/unauthorized" element={<Unauthorized />} />

          <Route path="/settings" element={<Settings />} />

          {/* Role-restricted areas */}
          <Route element={<ProtectedRoute allowedRoles={['admin', 'manager']} />}>
            <Route path="/payroll" element={<Payroll />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
