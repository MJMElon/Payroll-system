import { Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import ResetPasswordGate from './components/ResetPasswordGate'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import AddJobRecord from './pages/operation/AddJobRecord'
import StationDetail from './pages/StationDetail'
import DemoMobile from './pages/DemoMobile'
import Operation from './pages/operation/Operation'
import WorkerManagement from './pages/workers/WorkerManagement'
import Payroll from './pages/Payroll'
import PieceRate from './pages/PieceRate'
import Settings from './pages/Settings'
import Unauthorized from './pages/Unauthorized'

export default function App() {
  return (
    <>
    <ResetPasswordGate />
    <Routes>
      <Route path="/login" element={<Login />} />

      {/* Any signed-in user */}
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/daily-job-record" element={<Navigate to="/operation" replace />} />
          <Route path="/daily-job-record/add" element={<Navigate to="/operation/add" replace />} />
          <Route path="/station/:stationId" element={<StationDetail />} />
          <Route path="/demo-mobile" element={<DemoMobile />} />
          <Route path="/operation" element={<Operation />} />
          <Route path="/operation/add" element={<AddJobRecord />} />
          <Route path="/workers" element={<WorkerManagement />} />
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
    </>
  )
}
