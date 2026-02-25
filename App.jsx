import { useState, useEffect, useCallback, useRef } from "react";
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer
} from "recharts";

// ─────────────────────────────────────────────
// CONFIG — update BACKEND_URL after deploying
// ─────────────────────────────────────────────
const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:3001";
const API_KEY = process.env.REACT_APP_API_KEY || "sg-dev-key-change-me";

const CAMERAS = [
  { id: "CAM-01", location: "Main Gate" },
  { id: "CAM-02", location: "Parking Lot A" },
  { id: "CAM-03", location: "Lobby - Block B" },
  { id: "CAM-04", location: "Swimming Pool" },
  { id: "CAM-05", location: "Rear Gate" },
  { id: "CAM-06", location: "Gym Entrance" },
];

const CLIENTS = [
  { id: "C01", name: "Green Valley Society" },
  { id: "C02", name: "Sunrise Heights" },
  { id: "C03", name: "Royal Palms" },
];

const USERS = [
  { id: 1, username: "superadmin", password: "super123", role: "superuser", name: "Raj Mehta" },
  { id: 2, username: "secretary", password: "admin123", role: "admin", name: "Priya Sharma", client: "C01" },
  { id: 3, username: "chairman", password: "chair123", role: "admin", name: "Vikram Nair", client: "C02" },
  { id: 4, username: "guard1", password: "op123", role: "operator", name: "Suresh Kumar", client: "C01" },
];

const CHART_COLORS = ["#38bdf8", "#818cf8", "#34d399", "#fb923c", "#f472b6", "#a78bfa"];

// ─────────────────────────────────────────────
// API HELPERS
// ─────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...options,
    headers: { "x-api-key": API_KEY, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────
const S = {
  app: { minHeight: "100vh", background: "#0a0c10", color: "#e2e8f0", fontFamily: "'DM Sans', 'Segoe UI', sans-serif" },
  loginPage: { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "linear-gradient(135deg, #0a0c10 0%, #0d1117 50%, #0f1923 100%)", position: "relative", overflow: "hidden" },
  loginCard: { background: "rgba(15,23,36,0.95)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 16, padding: "48px 40px", width: 400, boxShadow: "0 0 60px rgba(56,189,248,0.08), 0 40px 80px rgba(0,0,0,0.6)", position: "relative", zIndex: 1 },
  logo: { display: "flex", alignItems: "center", gap: 10, marginBottom: 32 },
  logoIcon: { width: 40, height: 40, background: "linear-gradient(135deg, #38bdf8, #0ea5e9)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 },
  logoText: { fontSize: 20, fontWeight: 700, color: "#f1f5f9", letterSpacing: -0.5 },
  logoSub: { fontSize: 11, color: "#64748b", letterSpacing: 2, textTransform: "uppercase" },
  label: { fontSize: 12, color: "#64748b", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6, display: "block" },
  input: { width: "100%", padding: "12px 14px", background: "rgba(30,41,59,0.8)", border: "1px solid rgba(51,65,85,0.8)", borderRadius: 8, color: "#e2e8f0", fontSize: 14, outline: "none", boxSizing: "border-box" },
  btn: { width: "100%", padding: "13px", background: "linear-gradient(135deg, #0ea5e9, #38bdf8)", border: "none", borderRadius: 8, color: "#0a0c10", fontSize: 14, fontWeight: 700, cursor: "pointer", letterSpacing: 0.5, marginTop: 8 },
  error: { color: "#f87171", fontSize: 12, marginTop: 8, textAlign: "center" },
  nav: { background: "rgba(10,12,16,0.98)", borderBottom: "1px solid rgba(56,189,248,0.12)", padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", height: 60, position: "sticky", top: 0, zIndex: 100, backdropFilter: "blur(10px)" },
  navLeft: { display: "flex", alignItems: "center", gap: 16 },
  navBrand: { fontSize: 16, fontWeight: 700, color: "#38bdf8", letterSpacing: -0.5 },
  badge: (role) => ({ padding: "3px 10px", borderRadius: 20, fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", background: role === "superuser" ? "rgba(168,85,247,0.15)" : role === "admin" ? "rgba(56,189,248,0.15)" : "rgba(34,197,94,0.15)", color: role === "superuser" ? "#c084fc" : role === "admin" ? "#38bdf8" : "#4ade80", border: `1px solid ${role === "superuser" ? "rgba(168,85,247,0.3)" : role === "admin" ? "rgba(56,189,248,0.3)" : "rgba(34,197,94,0.3)"}` }),
  navRight: { display: "flex", alignItems: "center", gap: 16 },
  logoutBtn: { padding: "7px 16px", background: "transparent", border: "1px solid rgba(248,113,113,0.3)", borderRadius: 6, color: "#f87171", fontSize: 12, fontWeight: 600, cursor: "pointer" },
  main: { padding: "24px", maxWidth: 1400, margin: "0 auto" },
  pageTitle: { fontSize: 22, fontWeight: 700, color: "#f1f5f9", marginBottom: 4, letterSpacing: -0.5 },
  pageSub: { fontSize: 13, color: "#64748b", marginBottom: 24 },
  statsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 24 },
  statCard: (accent) => ({ background: "rgba(15,23,36,0.9)", border: `1px solid ${accent}22`, borderRadius: 12, padding: "20px 24px", position: "relative", overflow: "hidden" }),
  statGlow: (accent) => ({ position: "absolute", top: 0, right: 0, width: 80, height: 80, background: `radial-gradient(circle, ${accent}15 0%, transparent 70%)`, borderRadius: "50%" }),
  statLabel: { fontSize: 11, color: "#64748b", fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 },
  statValue: (accent) => ({ fontSize: 32, fontWeight: 800, color: accent, lineHeight: 1, marginBottom: 4 }),
  statDelta: (positive) => ({ fontSize: 12, color: positive ? "#4ade80" : "#f87171", fontWeight: 600 }),
  chartGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 20, marginBottom: 24 },
  chartCard: { background: "rgba(15,23,36,0.9)", border: "1px solid rgba(56,189,248,0.1)", borderRadius: 12, padding: "20px 24px" },
  chartHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20, flexWrap: "wrap", gap: 10 },
  chartTitle: { fontSize: 14, fontWeight: 700, color: "#e2e8f0" },
  chartSub: { fontSize: 11, color: "#64748b", marginTop: 2 },
  toggleGroup: { display: "flex", gap: 4 },
  toggleBtn: (active) => ({ padding: "5px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, border: "1px solid rgba(56,189,248,0.2)", background: active ? "rgba(56,189,248,0.15)" : "transparent", color: active ? "#38bdf8" : "#64748b", cursor: "pointer" }),
  pill: (active) => ({ padding: "6px 14px", borderRadius: 20, background: active ? "rgba(56,189,248,0.15)" : "rgba(30,41,59,0.5)", border: `1px solid ${active ? "rgba(56,189,248,0.4)" : "rgba(51,65,85,0.5)"}`, color: active ? "#38bdf8" : "#94a3b8", fontSize: 12, fontWeight: 600, cursor: "pointer" }),
  filterRow: { display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" },
  tableWrap: { background: "rgba(15,23,36,0.9)", border: "1px solid rgba(56,189,248,0.1)", borderRadius: 12, overflow: "hidden", marginBottom: 24 },
  tableHeader: { padding: "16px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid rgba(56,189,248,0.08)" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { padding: "12px 16px", textAlign: "left", color: "#64748b", fontSize: 11, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase", borderBottom: "1px solid rgba(51,65,85,0.5)" },
  td: { padding: "12px 16px", borderBottom: "1px solid rgba(51,65,85,0.3)", color: "#cbd5e1" },
  select: { padding: "8px 12px", background: "rgba(15,23,36,0.95)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 8, color: "#e2e8f0", fontSize: 13, cursor: "pointer", outline: "none" },
  statusDot: (status) => ({ width: 8, height: 8, borderRadius: "50%", display: "inline-block", marginRight: 6, background: status === "online" ? "#4ade80" : "#f87171", boxShadow: `0 0 6px ${status === "online" ? "#4ade80" : "#f87171"}` }),
  webhookPanel: { background: "rgba(10,12,16,0.95)", border: "1px solid rgba(56,189,248,0.1)", borderRadius: 12, padding: 16, marginBottom: 24 },
  endpointBox: { background: "rgba(30,41,59,0.5)", border: "1px solid rgba(56,189,248,0.15)", borderRadius: 8, padding: "12px 16px", fontFamily: "monospace", fontSize: 12, color: "#38bdf8", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  copyBtn: { padding: "4px 10px", background: "rgba(56,189,248,0.1)", border: "1px solid rgba(56,189,248,0.3)", borderRadius: 4, color: "#38bdf8", fontSize: 11, cursor: "pointer", fontWeight: 600 },
  liveLog: { maxHeight: 140, overflowY: "auto", fontFamily: "monospace", fontSize: 11, marginTop: 8 },
  connectionBadge: (ok) => ({ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: ok ? "rgba(74,222,128,0.1)" : "rgba(248,113,113,0.1)", color: ok ? "#4ade80" : "#f87171", border: `1px solid ${ok ? "rgba(74,222,128,0.2)" : "rgba(248,113,113,0.2)"}` }),
};

// ─────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────
function StatCard({ label, value, delta, deltaPositive, accent = "#38bdf8", icon }) {
  return (
    <div style={S.statCard(accent)}>
      <div style={S.statGlow(accent)} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={S.statLabel}>{label}</div>
          <div style={S.statValue(accent)}>{value ?? "—"}</div>
          {delta && <div style={S.statDelta(deltaPositive)}>{deltaPositive ? "▲" : "▼"} {delta}</div>}
        </div>
        <div style={{ fontSize: 24, opacity: 0.4 }}>{icon}</div>
      </div>
    </div>
  );
}

function ChartToggle({ options, value, onChange }) {
  return (
    <div style={S.toggleGroup}>
      {options.map(o => <button key={o} style={S.toggleBtn(value === o)} onClick={() => onChange(o)}>{o}</button>)}
    </div>
  );
}

function Spinner() {
  return <div style={{ textAlign: "center", padding: 40, color: "#38bdf8", fontSize: 13 }}>⏳ Loading data...</div>;
}

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────
function LoginPage({ onLogin }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleLogin = () => {
    const user = USERS.find(u => u.username === username && u.password === password);
    if (user) onLogin(user);
    else setError("Invalid credentials. Try again.");
  };

  return (
    <div style={S.loginPage}>
      <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(rgba(56,189,248,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(56,189,248,0.03) 1px, transparent 1px)", backgroundSize: "40px 40px" }} />
      <div style={S.loginCard}>
        <div style={S.logo}>
          <div style={S.logoIcon}>🏢</div>
          <div>
            <div style={S.logoText}>SocietyGuard</div>
            <div style={S.logoSub}>Security Intelligence Platform</div>
          </div>
        </div>
        <div style={{ marginBottom: 20 }}>
          <label style={S.label}>Username</label>
          <input style={S.input} value={username} onChange={e => setUsername(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="Enter username" />
        </div>
        <div style={{ marginBottom: 24 }}>
          <label style={S.label}>Password</label>
          <input style={S.input} type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleLogin()} placeholder="Enter password" />
        </div>
        <button style={S.btn} onClick={handleLogin}>Sign In →</button>
        {error && <div style={S.error}>{error}</div>}
        <div style={{ marginTop: 24, padding: "12px", background: "rgba(30,41,59,0.5)", borderRadius: 8, fontSize: 11, color: "#475569" }}>
          <div style={{ fontWeight: 700, marginBottom: 4, color: "#64748b" }}>DEMO CREDENTIALS</div>
          <div>superadmin / super123 — Super User</div>
          <div>secretary / admin123 — Admin (Green Valley)</div>
          <div>guard1 / op123 — Operator</div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN DASHBOARD
// ─────────────────────────────────────────────
function Dashboard({ user, onLogout }) {
  const [selectedClient, setSelectedClient] = useState(user.client || "C01");
  const [stats, setStats] = useState(null);
  const [recentEvents, setRecentEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [backendOk, setBackendOk] = useState(null);
  const [visitorFilter, setVisitorFilter] = useState("today");
  const [visitorChart, setVisitorChart] = useState("Bar");
  const [cameraChart, setCameraChart] = useState("Bar");
  const [downtimeChart, setDowntimeChart] = useState("Bar");
  const [liveLog, setLiveLog] = useState([]);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef(null);

  const clientId = user.role === "superuser" ? selectedClient : user.client;
  const webhookUrl = `${BACKEND_URL}/webhook`;

  const fetchData = useCallback(async () => {
    try {
      const [statsData, eventsData] = await Promise.all([
        apiFetch(`/api/stats?client_id=${clientId}`),
        apiFetch(`/api/events?client_id=${clientId}&limit=15`),
      ]);
      setStats(statsData);
      setRecentEvents(eventsData.events || []);
      setBackendOk(true);

      // Build live log from recent events
      if (eventsData.events?.length > 0) {
        setLiveLog(eventsData.events.slice(0, 10).map(e => {
          const t = new Date(e.timestamp_ist).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
          return `[${t} IST] ${e.event_type.toUpperCase()} @ ${e.camera_location}${e.visitor_count ? ` — ${e.visitor_count} person(s)` : ""}`;
        }));
      }
    } catch (err) {
      setBackendOk(false);
      console.error("Backend fetch failed:", err.message);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  // Poll every 15 seconds
  useEffect(() => {
    fetchData();
    pollRef.current = setInterval(fetchData, 15000);
    return () => clearInterval(pollRef.current);
  }, [fetchData]);

  const copyWebhookUrl = () => {
    navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const visitorTrend = stats
    ? (visitorFilter === "today" ? stats.trends.hourly.filter(h => h.hour >= 6) : stats.trends.weekly)
    : [];

  const cameraActivity = stats?.camera_activity || [];
  const downtimeData = (stats?.downtime || []).map(d => ({
    ...d,
    "Downtime (hrs)": parseFloat((d.downtime_minutes / 60).toFixed(1)),
  }));

  const maxCam = cameraActivity[0];
  const todayVisitors = stats?.visitors.today ?? 0;
  const yesterdayVisitors = stats?.visitors.yesterday ?? 0;
  const delta = todayVisitors - yesterdayVisitors;
  const totalDowntime = downtimeData.reduce((s, c) => s + c["Downtime (hrs)"], 0).toFixed(1);
  const offlineCams = downtimeData.filter(c => c.incidents > 0).length;

  const tooltipStyle = { contentStyle: { background: "#0f1923", border: "1px solid #1e293b", borderRadius: 8, color: "#e2e8f0" } };

  return (
    <div style={S.app}>
      {/* NAV */}
      <nav style={S.nav}>
        <div style={S.navLeft}>
          <div style={{ fontSize: 20 }}>🏢</div>
          <div style={S.navBrand}>SocietyGuard</div>
          <span style={S.badge(user.role)}>{user.role}</span>
          {backendOk !== null && (
            <span style={S.connectionBadge(backendOk)}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: backendOk ? "#4ade80" : "#f87171", display: "inline-block" }} />
              {backendOk ? "Backend Connected" : "Backend Offline — Check URL"}
            </span>
          )}
        </div>
        <div style={S.navRight}>
          {user.role === "superuser" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 11, color: "#64748b" }}>CLIENT:</span>
              <select style={S.select} value={selectedClient} onChange={e => setSelectedClient(e.target.value)}>
                {CLIENTS.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          <div style={{ fontSize: 13, color: "#94a3b8" }}>👤 {user.name}</div>
          <button style={S.logoutBtn} onClick={onLogout}>Sign Out</button>
        </div>
      </nav>

      <main style={S.main}>
        {/* HEADER */}
        <div style={{ marginBottom: 24 }}>
          <div style={S.pageTitle}>{CLIENTS.find(c => c.id === clientId)?.name || "Dashboard"}</div>
          <div style={S.pageSub}>{new Date().toLocaleDateString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} · All times in IST</div>
        </div>

        {/* WEBHOOK PANEL */}
        <div style={S.webhookPanel}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, letterSpacing: 2 }}>⚡ WEBHOOK ENDPOINT</div>
            <div style={{ fontSize: 11, color: "#64748b" }}>Auto-refreshes every 15s · Header required: <code style={{ color: "#818cf8" }}>x-api-key</code></div>
          </div>
          <div style={S.endpointBox}>
            <span>POST &nbsp;{webhookUrl}</span>
            <button style={S.copyBtn} onClick={copyWebhookUrl}>{copied ? "✓ Copied" : "Copy"}</button>
          </div>

          {/* Sample payload hint */}
          <details style={{ marginBottom: 10 }}>
            <summary style={{ fontSize: 11, color: "#64748b", cursor: "pointer", marginBottom: 6 }}>View expected JSON payload schema</summary>
            <pre style={{ background: "rgba(15,23,36,0.8)", border: "1px solid rgba(51,65,85,0.5)", borderRadius: 6, padding: 12, fontSize: 10, color: "#94a3b8", overflowX: "auto", marginTop: 6 }}>{`{
  "camera_id": "CAM-01",           // required
  "camera_location": "Main Gate",  // optional label
  "event_type": "person_detected", // required  (person_detected | vehicle_detected | crowd_detected | loitering | camera_offline | camera_online)
  "visitor_count": 2,              // optional, default 0
  "confidence": 0.92,              // optional float
  "client_id": "C01",              // required — links to society
  "timestamp_utc": "2026-02-25T08:30:00Z",  // required ISO UTC
  "metadata": {}                   // optional passthrough
}
// Can also send an array of events in a single POST`}</pre>
          </details>

          {/* Live log */}
          <div style={{ fontSize: 10, color: "#64748b", letterSpacing: 1, marginBottom: 4 }}>LIVE EVENT LOG</div>
          <div style={S.liveLog}>
            {liveLog.length === 0
              ? <div style={{ color: "#475569" }}>No events received yet. Send a POST to the webhook URL above.</div>
              : liveLog.map((log, i) => (
                <div key={i} style={{ color: i === 0 ? "#4ade80" : "#475569", marginBottom: 2 }}>{log}</div>
              ))}
          </div>
        </div>

        {loading ? <Spinner /> : (
          <>
            {/* STAT CARDS */}
            <div style={S.statsGrid}>
              <StatCard label="Today's Visitors" value={todayVisitors} delta={`${Math.abs(delta)} vs yesterday`} deltaPositive={delta >= 0} accent="#38bdf8" icon="👁️" />
              <StatCard label="This Week" value={stats?.visitors.week ?? 0} accent="#818cf8" icon="📅" />
              <StatCard label="Busiest Camera" value={maxCam?.camera_id || "—"} delta={maxCam ? `${maxCam.count} events · ${maxCam.location}` : "No data yet"} deltaPositive={false} accent="#fb923c" icon="📷" />
              <StatCard label="Total Downtime" value={`${totalDowntime}h`} delta={`${offlineCams} camera${offlineCams !== 1 ? "s" : ""} affected`} deltaPositive={false} accent="#f87171" icon="⚠️" />
            </div>

            {/* CHARTS ROW */}
            <div style={S.chartGrid}>
              {/* VISITOR TRENDS */}
              <div style={S.chartCard}>
                <div style={S.chartHeader}>
                  <div>
                    <div style={S.chartTitle}>Visitor Trends</div>
                    <div style={S.chartSub}>IST time · from webhook data</div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <div style={S.filterRow}>
                      {["today", "week"].map(f => (
                        <button key={f} style={S.pill(visitorFilter === f)} onClick={() => setVisitorFilter(f)}>
                          {f === "today" ? "Today vs Yesterday" : "Week by Week"}
                        </button>
                      ))}
                    </div>
                    <ChartToggle options={["Bar", "Pie"]} value={visitorChart} onChange={setVisitorChart} />
                  </div>
                </div>
                {visitorTrend.length === 0
                  ? <div style={{ textAlign: "center", padding: 40, color: "#475569", fontSize: 12 }}>No visitor events yet</div>
                  : (
                    <ResponsiveContainer width="100%" height={220}>
                      {visitorChart === "Bar" ? (
                        <BarChart data={visitorTrend} barSize={14}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" />
                          <XAxis dataKey="label" tick={{ fill: "#64748b", fontSize: 10 }} />
                          <YAxis tick={{ fill: "#64748b", fontSize: 10 }} />
                          <Tooltip {...tooltipStyle} />
                          <Legend />
                          {visitorFilter === "week"
                            ? <Bar dataKey="visitors" fill="#38bdf8" radius={[4, 4, 0, 0]} />
                            : <>
                              <Bar dataKey="today" name="Today" fill="#38bdf8" radius={[4, 4, 0, 0]} />
                              <Bar dataKey="yesterday" name="Yesterday" fill="#818cf8" radius={[4, 4, 0, 0]} />
                            </>
                          }
                        </BarChart>
                      ) : (
                        <PieChart>
                          <Pie data={visitorTrend.filter(d => (d.today || d.visitors || 0) > 0)} dataKey={visitorFilter === "week" ? "visitors" : "today"} nameKey="label" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                            {visitorTrend.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                          </Pie>
                          <Tooltip {...tooltipStyle} />
                        </PieChart>
                      )}
                    </ResponsiveContainer>
                  )}
              </div>

              {/* CAMERA ACTIVITY */}
              <div style={S.chartCard}>
                <div style={S.chartHeader}>
                  <div>
                    <div style={S.chartTitle}>Camera Activity</div>
                    <div style={S.chartSub}>Events this week by camera</div>
                  </div>
                  <ChartToggle options={["Bar", "Pie"]} value={cameraChart} onChange={setCameraChart} />
                </div>
                {cameraActivity.length === 0
                  ? <div style={{ textAlign: "center", padding: 40, color: "#475569", fontSize: 12 }}>No camera events yet</div>
                  : (
                    <ResponsiveContainer width="100%" height={220}>
                      {cameraChart === "Bar" ? (
                        <BarChart data={cameraActivity} layout="vertical" barSize={14}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" horizontal={false} />
                          <XAxis type="number" tick={{ fill: "#64748b", fontSize: 10 }} />
                          <YAxis type="category" dataKey="camera_id" tick={{ fill: "#64748b", fontSize: 10 }} width={60} />
                          <Tooltip {...tooltipStyle} formatter={(val, _, props) => [val, props.payload.location]} />
                          <Bar dataKey="count" name="Events" radius={[0, 4, 4, 0]}>
                            {cameraActivity.map((_, i) => <Cell key={i} fill={i === 0 ? "#fb923c" : CHART_COLORS[i % CHART_COLORS.length]} />)}
                          </Bar>
                        </BarChart>
                      ) : (
                        <PieChart>
                          <Pie data={cameraActivity} dataKey="count" nameKey="camera_id" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                            {cameraActivity.map((_, i) => <Cell key={i} fill={i === 0 ? "#fb923c" : CHART_COLORS[i % CHART_COLORS.length]} />)}
                          </Pie>
                          <Tooltip {...tooltipStyle} />
                        </PieChart>
                      )}
                    </ResponsiveContainer>
                  )}
                {maxCam && (
                  <div style={{ marginTop: 12, padding: "10px 14px", background: "rgba(251,146,60,0.08)", border: "1px solid rgba(251,146,60,0.2)", borderRadius: 8, fontSize: 12, color: "#fdba74" }}>
                    🚨 <strong>{maxCam.camera_id} ({maxCam.location})</strong> has highest activity — consider deploying guard
                  </div>
                )}
              </div>
            </div>

            {/* DOWNTIME CHART */}
            <div style={{ ...S.chartCard, marginBottom: 24 }}>
              <div style={S.chartHeader}>
                <div>
                  <div style={S.chartTitle}>Camera Downtime Analysis</div>
                  <div style={S.chartSub}>Detected via camera_offline webhook events · UTC→IST converted</div>
                </div>
                <ChartToggle options={["Bar", "Pie"]} value={downtimeChart} onChange={setDowntimeChart} />
              </div>
              {downtimeData.length === 0
                ? <div style={{ textAlign: "center", padding: 40, color: "#475569", fontSize: 12 }}>No camera_offline events received yet</div>
                : (
                  <ResponsiveContainer width="100%" height={200}>
                    {downtimeChart === "Bar" ? (
                      <BarChart data={downtimeData} barSize={20}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(51,65,85,0.4)" />
                        <XAxis dataKey="camera_id" tick={{ fill: "#64748b", fontSize: 11 }} />
                        <YAxis tick={{ fill: "#64748b", fontSize: 11 }} unit="h" />
                        <Tooltip {...tooltipStyle} formatter={(val, _, props) => [`${val}h (${props.payload.incidents} incidents)`, props.payload.location || props.payload.camera_id]} />
                        <Bar dataKey="Downtime (hrs)" radius={[4, 4, 0, 0]}>
                          {downtimeData.map((d, i) => <Cell key={i} fill={d["Downtime (hrs)"] > 1 ? "#f87171" : "#34d399"} />)}
                        </Bar>
                      </BarChart>
                    ) : (
                      <PieChart>
                        <Pie data={downtimeData.filter(d => d["Downtime (hrs)"] > 0)} dataKey="Downtime (hrs)" nameKey="camera_id" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}>
                          {downtimeData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                        </Pie>
                        <Tooltip {...tooltipStyle} />
                      </PieChart>
                    )}
                  </ResponsiveContainer>
                )}
            </div>

            {/* CAMERA STATUS TABLE */}
            {downtimeData.length > 0 && (
              <div style={S.tableWrap}>
                <div style={S.tableHeader}>
                  <div style={S.chartTitle}>Camera Status Overview</div>
                  <div style={{ fontSize: 11, color: "#64748b" }}>Derived from camera_offline / camera_online events</div>
                </div>
                <table style={S.table}>
                  <thead>
                    <tr>{["Camera ID", "Location", "Incidents", "Total Downtime", "Action"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {downtimeData.sort((a, b) => b["Downtime (hrs)"] - a["Downtime (hrs)"]).map((cam, i) => (
                      <tr key={i} style={{ background: cam.incidents > 1 ? "rgba(248,113,113,0.03)" : "transparent" }}>
                        <td style={S.td}><strong style={{ color: "#e2e8f0" }}>{cam.camera_id}</strong></td>
                        <td style={S.td}>{cam.location || cam.camera_id}</td>
                        <td style={S.td}>{cam.incidents}</td>
                        <td style={S.td}>{cam["Downtime (hrs)"]}h</td>
                        <td style={{ ...S.td, fontSize: 11, color: cam["Downtime (hrs)"] > 1 ? "#fbbf24" : "#4ade80" }}>
                          {cam["Downtime (hrs)"] > 1 ? "⚠️ Schedule maintenance" : "✅ Healthy"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* RECENT EVENTS FEED — Admin & Superuser only */}
            {(user.role === "admin" || user.role === "superuser") && recentEvents.length > 0 && (
              <div style={S.tableWrap}>
                <div style={S.tableHeader}>
                  <div style={S.chartTitle}>Recent Events Feed</div>
                  <div style={{ fontSize: 11, color: "#64748b" }}>Last 15 events · UTC auto-converted to IST</div>
                </div>
                <table style={S.table}>
                  <thead>
                    <tr>{["IST Time", "Camera", "Location", "Event Type", "Count", "Confidence"].map(h => <th key={h} style={S.th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {recentEvents.map((e, i) => (
                      <tr key={i}>
                        <td style={S.td}>{new Date(e.timestamp_ist).toLocaleString("en-IN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" })}</td>
                        <td style={S.td}><span style={{ color: "#38bdf8", fontWeight: 600 }}>{e.camera_id}</span></td>
                        <td style={S.td}>{e.camera_location}</td>
                        <td style={S.td}>
                          <span style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, background: e.event_type === "camera_offline" ? "rgba(248,113,113,0.15)" : e.event_type === "loitering" ? "rgba(251,191,36,0.15)" : "rgba(56,189,248,0.1)", color: e.event_type === "camera_offline" ? "#f87171" : e.event_type === "loitering" ? "#fbbf24" : "#38bdf8" }}>
                            {e.event_type.replace(/_/g, " ")}
                          </span>
                        </td>
                        <td style={S.td}>{e.visitor_count || "—"}</td>
                        <td style={S.td}>{e.confidence ? `${(e.confidence * 100).toFixed(0)}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>

      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #0a0c10; }
        ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
        select option { background: #0f1923; }
        details summary::-webkit-details-marker { color: #64748b; }
      `}</style>
    </div>
  );
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  return currentUser
    ? <Dashboard user={currentUser} onLogout={() => setCurrentUser(null)} />
    : <LoginPage onLogin={setCurrentUser} />;
}
