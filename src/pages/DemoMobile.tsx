import { useState } from 'react'
import { Link } from 'react-router-dom'

// Sandbox for the future mobile app (separate repo later). Each role gets a
// mock screen inside a phone frame so the UI can be designed here first.
const ROLES = [
  'Operator',
  'Assistant Station Head',
  'Station Head',
  'Engineer',
  'Manager',
] as const

type DemoRole = (typeof ROLES)[number]

export default function DemoMobile() {
  const [role, setRole] = useState<DemoRole>('Operator')

  return (
    <div className="stack">
      <div>
        <Link to="/" className="small muted">← Overall status</Link>
        <h1>Demo Mobile View</h1>
        <p className="muted">
          Design sandbox for the mobile app (will move to its own repo). Pick a role to
          preview its screen.
        </p>
      </div>

      <div className="tabs">
        {ROLES.map((r) => (
          <button
            key={r}
            className={`tab ${role === r ? 'active' : ''}`}
            onClick={() => setRole(r)}
          >
            {r}
          </button>
        ))}
      </div>

      <div className="phone-wrap">
        <div className="phone">
          <div className="phone-screen">
            <div className="mob-status">
              <span>09:41</span>
              <span>MJM</span>
              <span>▮▮▮</span>
            </div>
            <div className="mob-header">
              <div>
                <div className="mob-role">{role}</div>
                <div className="mob-sub">Sterilizer Station</div>
              </div>
              <div className="mob-avatar">A</div>
            </div>
            <div className="mob-body">
              {role === 'Operator' && <OperatorScreen />}
              {role === 'Assistant Station Head' && <AssistantScreen />}
              {role === 'Station Head' && <StationHeadScreen />}
              {role === 'Engineer' && <EngineerScreen />}
              {role === 'Manager' && <ManagerScreen />}
            </div>
            <div className="mob-nav">
              <span className="on">Home</span>
              <span>Records</span>
              <span>Alerts</span>
              <span>Me</span>
            </div>
          </div>
        </div>
        <p className="muted small">Static mockups — no data is saved from this screen.</p>
      </div>
    </div>
  )
}

function OperatorScreen() {
  return (
    <>
      <div className="mob-card mob-highlight">
        <div className="mob-big">14</div>
        <div className="mob-sub">tips this shift · last 14:32</div>
        <button className="mob-btn">+ Record tip</button>
      </div>
      <div className="mob-card">
        <div className="mob-title">Quick entry</div>
        <div className="mob-row"><span>Job</span><span className="mob-chip">Sterilize FFB</span></div>
        <div className="mob-row"><span>Quantity</span><span className="mob-chip">1 cage</span></div>
        <button className="mob-btn ghost">Submit entry</button>
      </div>
      <div className="mob-card">
        <div className="mob-title">Today</div>
        <div className="mob-row"><span>14:32 · cage #14</span><span>✓</span></div>
        <div className="mob-row"><span>13:58 · cage #13</span><span>✓</span></div>
        <div className="mob-row"><span>13:20 · cage #12</span><span>✓</span></div>
      </div>
    </>
  )
}

function AssistantScreen() {
  return (
    <>
      <div className="mob-card">
        <div className="mob-title">Pending confirmation (3)</div>
        <div className="mob-row"><span>Ali · 3 cages · 14:30</span><button className="mob-mini">Confirm</button></div>
        <div className="mob-row"><span>Ravi · 2 cages · 14:05</span><button className="mob-mini">Confirm</button></div>
        <div className="mob-row"><span>Kumar · 4 cages · 13:40</span><button className="mob-mini">Confirm</button></div>
      </div>
      <div className="mob-card">
        <div className="mob-title">Shift summary</div>
        <div className="mob-row"><span>Confirmed</span><span>22</span></div>
        <div className="mob-row"><span>Rejected</span><span>1</span></div>
      </div>
    </>
  )
}

function StationHeadScreen() {
  return (
    <>
      <div className="mob-card mob-highlight">
        <div className="mob-title">Station today</div>
        <div className="mob-big">86 t</div>
        <div className="mob-sub">throughput · target 100 t</div>
        <div className="mob-bar"><div style={{ width: '86%' }} /></div>
      </div>
      <div className="mob-card">
        <div className="mob-title">Team (6 on shift)</div>
        <div className="mob-row"><span>Ali</span><span>14 entries</span></div>
        <div className="mob-row"><span>Ravi</span><span>11 entries</span></div>
        <div className="mob-row"><span>Kumar</span><span>9 entries</span></div>
        <button className="mob-btn ghost">Approve day sheet</button>
      </div>
    </>
  )
}

function EngineerScreen() {
  return (
    <>
      <div className="mob-card">
        <div className="mob-title">Station health</div>
        <div className="mob-row"><span>Sterilizer #1</span><span className="mob-chip ok">Running</span></div>
        <div className="mob-row"><span>Sterilizer #2</span><span className="mob-chip warn">Idle 42m</span></div>
        <div className="mob-row"><span>Press #1</span><span className="mob-chip ok">Running</span></div>
      </div>
      <div className="mob-card">
        <div className="mob-title">Downtime log</div>
        <div className="mob-row"><span>10:20 · Press #2 belt</span><span>35m</span></div>
        <div className="mob-row"><span>08:05 · Boiler feed</span><span>12m</span></div>
        <button className="mob-btn ghost">+ Log downtime</button>
      </div>
    </>
  )
}

function ManagerScreen() {
  return (
    <>
      <div className="mob-grid2">
        <div className="mob-card mob-highlight">
          <div className="mob-big">412 t</div>
          <div className="mob-sub">FFB processed</div>
        </div>
        <div className="mob-card mob-highlight">
          <div className="mob-big">57</div>
          <div className="mob-sub">workers on shift</div>
        </div>
      </div>
      <div className="mob-card">
        <div className="mob-title">Stations now</div>
        <div className="mob-row"><span>Loading Ramp</span><span className="mob-chip ok">4/hr</span></div>
        <div className="mob-row"><span>Sterilizer</span><span className="mob-chip ok">4/hr</span></div>
        <div className="mob-row"><span>Press</span><span className="mob-chip warn">0/hr</span></div>
      </div>
      <div className="mob-card">
        <div className="mob-title">Payroll</div>
        <div className="mob-row"><span>June run</span><span className="mob-chip ok">finalized</span></div>
        <div className="mob-row"><span>July (to date)</span><span>RM 48,210</span></div>
      </div>
    </>
  )
}
