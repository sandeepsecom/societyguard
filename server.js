/**
 * SocietyGuard - Full Backend v3
 * Features: PostgreSQL, 3deye mapping, email alerts, strong passwords,
 *           society/wing/user management, audit logs, daily report cron
 */

const express    = require("express");
const cors       = require("cors");
const { Pool }   = require("pg");
const bcrypt     = require("bcryptjs");
const crypto     = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "sg-mysociety-2026";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://societyguard.vercel.app";

// ── DATABASE ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  // Add missing columns for migration from v2
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS society_id INT`);
    // Critical: allow NULL password_hash for invite-based users (set password later)
    await pool.query(`ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`);
    // Clean up any stuck users from failed invites (no password set, not the seeded ones)
    await pool.query(`DELETE FROM users WHERE password_hash IS NULL AND invite_token IS NOT NULL AND created_at < NOW() - INTERVAL '1 minute'`);
    console.log("Migration complete");
  } catch(e) { console.log("Migration note:", e.message); }

  await pool.query(`
    -- Societies table
    CREATE TABLE IF NOT EXISTS societies (
      id          SERIAL PRIMARY KEY,
      code        TEXT UNIQUE NOT NULL,
      name        TEXT NOT NULL,
      address     TEXT,
      logo_url    TEXT,
      is_active   BOOLEAN DEFAULT true,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- Wings/sub-groups inside a society
    CREATE TABLE IF NOT EXISTS wings (
      id          SERIAL PRIMARY KEY,
      society_id  INT REFERENCES societies(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- Cameras
    CREATE TABLE IF NOT EXISTS cameras (
      id             SERIAL PRIMARY KEY,
      camera_uid     TEXT UNIQUE NOT NULL,
      name           TEXT NOT NULL,
      society_id     INT REFERENCES societies(id) ON DELETE SET NULL,
      wing_id        INT REFERENCES wings(id) ON DELETE SET NULL,
      location       TEXT,
      is_active      BOOLEAN DEFAULT true,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    );

    -- Users
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      role          TEXT NOT NULL,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE NOT NULL,
      society_id    INT REFERENCES societies(id) ON DELETE SET NULL,
      is_active     BOOLEAN DEFAULT true,
      invite_token  TEXT,
      invite_expires TIMESTAMPTZ,
      last_login    TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );

    -- Events
    CREATE TABLE IF NOT EXISTS events (
      id              SERIAL PRIMARY KEY,
      event_uid       TEXT UNIQUE,
      camera_id       TEXT NOT NULL,
      camera_location TEXT,
      event_type      TEXT NOT NULL,
      event_type_raw  TEXT,
      visitor_count   INT DEFAULT 0,
      confidence      FLOAT,
      client_id       TEXT NOT NULL,
      thumbnail_url   TEXT,
      video_url       TEXT,
      metadata        JSONB,
      timestamp_utc   TIMESTAMPTZ,
      timestamp_ist   TIMESTAMPTZ,
      received_at     TIMESTAMPTZ DEFAULT NOW(),
      source_id       TEXT
    );

    -- Audit Logs
    CREATE TABLE IF NOT EXISTS audit_logs (
      id          SERIAL PRIMARY KEY,
      user_id     INT,
      username    TEXT,
      role        TEXT,
      action      TEXT NOT NULL,
      entity      TEXT,
      entity_id   TEXT,
      details     JSONB,
      ip_address  TEXT,
      society_id  INT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- User-Society access (multi-society support)
    CREATE TABLE IF NOT EXISTS user_societies (
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      society_id  INT REFERENCES societies(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, society_id)
    );

    -- User-Society access (multi-society per user)
    CREATE TABLE IF NOT EXISTS user_societies (
      user_id     INT REFERENCES users(id) ON DELETE CASCADE,
      society_id  INT REFERENCES societies(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, society_id)
    );

    -- App settings (logo etc)
    CREATE TABLE IF NOT EXISTS app_settings (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_events_client   ON events(client_id);
    CREATE INDEX IF NOT EXISTS idx_events_cam      ON events(camera_id);
    CREATE INDEX IF NOT EXISTS idx_events_type     ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_events_ts       ON events(timestamp_utc);
    CREATE INDEX IF NOT EXISTS idx_audit_user      ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created   ON audit_logs(created_at);
  `);

  // Seed default society
  const { rowCount: socCount } = await pool.query("SELECT 1 FROM societies LIMIT 1");
  if (socCount === 0) {
    await pool.query(`INSERT INTO societies (code,name,address) VALUES ('C01','Green Valley Society','Mumbai'),('C02','Sunrise Heights','Mumbai'),('C03','Royal Palms','Mumbai')`);
    console.log("Default societies seeded");
  }

  // Seed default users
  const { rowCount: userCount } = await pool.query("SELECT 1 FROM users WHERE password_hash IS NOT NULL LIMIT 1");
  if (userCount === 0) {
    const soc = await pool.query("SELECT id,code FROM societies");
    const socMap = {};
    soc.rows.forEach(r => socMap[r.code] = r.id);
    const users = [
      { username:"superadmin", password:"Super@Guard2026!", role:"superuser", name:"Raj Mehta",    email: process.env.SUPERADMIN_EMAIL||process.env.ALERT_EMAIL||"superadmin@societyguard.app", society_id: null },
      { username:"secretary",  password:"GreenValley@2026!", role:"admin",   name:"Priya Sharma", email:"secretary@greenvalley.com", society_id: socMap["C01"] },
      { username:"chairman",   password:"Sunrise@2026!",     role:"admin",   name:"Vikram Nair",  email:"chairman@sunrise.com",      society_id: socMap["C02"] },
      { username:"guard1",     password:"Guard@Secure26!",   role:"operator",name:"Suresh Kumar", email:"guard1@greenvalley.com",    society_id: socMap["C01"] },
    ];
    for (const u of users) {
      const hash = await bcrypt.hash(u.password, 12);
      await pool.query(
        "INSERT INTO users (username,password_hash,role,name,email,society_id) VALUES ($1,$2,$3,$4,$5,$6)",
        [u.username, hash, u.role, u.name, u.email, u.society_id]
      );
    }
    console.log("Default users seeded");
  }

  // Seed default cameras
  // Seed user_societies for existing users that have society_id set
  try {
    const { rows: usersWithSoc } = await pool.query("SELECT id,society_id FROM users WHERE society_id IS NOT NULL");
    for (const u of usersWithSoc) {
      await pool.query("INSERT INTO user_societies (user_id,society_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [u.id, u.society_id]);
    }
  } catch(e) { console.log("user_societies seed:", e.message); }

  const { rowCount: camCount } = await pool.query("SELECT 1 FROM cameras LIMIT 1");
  if (camCount === 0) {
    const { rows: socs } = await pool.query("SELECT id FROM societies WHERE code='C01'");
    if (socs.length) {
      await pool.query(`INSERT INTO cameras (camera_uid,name,society_id,location) VALUES
        ('93518','Main Gate',$1,'Main Entrance'),
        ('98308','Parking Lot',$1,'Parking Area'),
        ('93515','Lobby Entrance',$1,'Building Lobby')`, [socs[0].id]);
    }
    console.log("Default cameras seeded");
  }
  console.log("Database ready");
}

// ── EMAIL ──
// ── EMAIL via SendGrid API ──
async function sendEmail(to, subject, html) {
  const apiKey = process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY;
  const from   = process.env.EMAIL_FROM || process.env.RESEND_FROM || "SocietyGuard <noreply@cloudcctv.app>";
  if (!apiKey) { console.warn("No email API key set — email skipped"); return; }
  // Use SendGrid if SENDGRID_API_KEY set, else fall back to Resend
  const useSendGrid = !!process.env.SENDGRID_API_KEY;
  try {
    let res, data;
    if (useSendGrid) {
      res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to.trim() }] }],
          from: { email: from.replace(/.*<(.+)>.*/, "$1").trim() || "sandeepsecom@gmail.com", name: "SocietyGuard" },
          subject, content: [{ type: "text/html", value: html }]
        })
      });
      if (!res.ok) { const t=await res.text(); throw new Error(t); }
      console.log(`✉️  Email sent via SendGrid to ${to}: ${subject}`);
    } else {
      res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: to.trim(), subject, html })
      });
      data = await res.json();
      if (!res.ok) throw new Error(data.message || JSON.stringify(data));
      console.log(`✉️  Email sent via Resend to ${to}: ${subject} (id: ${data.id})`);
    }
  } catch (err) { console.error("Email error:", err.message); }
}

async function sendInviteEmail(user, token) {
  const link = `${FRONTEND_URL}?invite=${token}`;
  const cleanEmail = (user.email||"").trim();
  if (!cleanEmail || !cleanEmail.includes("@")) {
    console.error("Invalid email for user:", user.username, JSON.stringify(user.email));
    return;
  }
  await sendEmail(cleanEmail, "You've been invited to SocietyGuard", `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)"><div style="background:#0f1923;padding:28px 32px;text-align:center;border-bottom:3px solid #38bdf8"><span style="font-size:26px;font-weight:900;color:#38bdf8;letter-spacing:-1px">Society<span style="color:#e2e8f0">Guard</span></span><div style="font-size:10px;color:#64748b;letter-spacing:3px;text-transform:uppercase;margin-top:4px">Security Intelligence Platform</div></div><div style="background:#ffffff;padding:36px 32px">
        <h2 style="color:#0f1923;font-size:22px;font-weight:800;margin:0 0 8px">Welcome to SocietyGuard! 🏢</h2>
        <p style="color:#475569;font-size:14px;margin:0 0 24px">You have been invited to join the platform</p>
        <p style="color:#1e293b;font-size:15px;margin:0 0 8px">Hi <strong>${user.name}</strong>,</p>
        <p style="color:#475569;font-size:14px;line-height:1.6;margin:0 0 24px">You've been added as <strong style="color:#0ea5e9">${user.role}</strong> on SocietyGuard. Click the button below to set your password and activate your account.</p>
        <div style="text-align:center;margin:28px 0">
          <a href="${link}" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#0ea5e9,#38bdf8);color:#0a0c10;border-radius:10px;font-weight:800;font-size:15px;text-decoration:none;letter-spacing:0.3px">Set My Password →</a>
        </div>
        <div style="background:#f1f5f9;border-radius:8px;padding:14px 18px;margin-top:24px">
          <p style="margin:0;font-size:12px;color:#64748b">🔐 Your username: <strong style="color:#0ea5e9;font-size:13px">${user.username}</strong></p>
          <p style="margin:6px 0 0;font-size:11px;color:#94a3b8">⏰ This link expires in 24 hours. Do not share this email with anyone.</p>
        </div>
    </div><div style="background:#0f1923;padding:20px 32px;text-align:center"><p style="margin:0 0 6px;font-size:12px;color:#64748b">Powered by <strong style="color:#38bdf8">Securizen Technologies</strong></p><p style="margin:0;font-size:11px;color:#334155">This is an automated message from SocietyGuard. Please do not reply.</p><p style="margin:8px 0 0;font-size:11px;color:#334155">© 2026 Securizen Technologies. All rights reserved.</p></div></div>`);
}

async function sendOfflineAlert(event) {
  if (!process.env.ALERT_EMAIL) return;
  await sendEmail(process.env.ALERT_EMAIL, `🚨 Camera Offline Alert: ${event.camera_id}`, `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:560px;margin:0 auto;background:#f8fafc;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)"><div style="background:#0f1923;padding:28px 32px;text-align:center;border-bottom:3px solid #38bdf8"><span style="font-size:26px;font-weight:900;color:#38bdf8;letter-spacing:-1px">Society<span style="color:#e2e8f0">Guard</span></span><div style="font-size:10px;color:#64748b;letter-spacing:3px;text-transform:uppercase;margin-top:4px">Security Intelligence Platform</div></div><div style="background:#ffffff;padding:36px 32px">
        <div style="display:inline-block;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:8px 16px;margin-bottom:20px">
          <span style="color:#ef4444;font-weight:700;font-size:13px">🚨 CAMERA OFFLINE</span>
        </div>
        <h2 style="color:#0f1923;font-size:20px;font-weight:800;margin:0 0 20px">Immediate Attention Required</h2>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px;width:40%">Camera ID</td><td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#0ea5e9;font-weight:700">${event.camera_id}</td></tr>
          <tr><td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#64748b;font-size:13px">Location</td><td style="padding:10px 0;border-bottom:1px solid #e2e8f0;color:#1e293b;font-weight:600">${event.camera_location}</td></tr>
          <tr><td style="padding:10px 0;color:#64748b;font-size:13px">Time (IST)</td><td style="padding:10px 0;color:#1e293b">${new Date(event.timestamp_ist).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"})}</td></tr>
        </table>
        <div style="background:#fef2f2;border-left:4px solid #ef4444;padding:14px 18px;margin-top:24px;border-radius:4px">
          <p style="margin:0;font-size:13px;color:#991b1b">Please inspect the camera immediately and restore connection.</p>
        </div>
    </div><div style="background:#0f1923;padding:20px 32px;text-align:center"><p style="margin:0 0 6px;font-size:12px;color:#64748b">Powered by <strong style="color:#38bdf8">Securizen Technologies</strong></p><p style="margin:0;font-size:11px;color:#334155">This is an automated message from SocietyGuard. Please do not reply.</p><p style="margin:8px 0 0;font-size:11px;color:#334155">© 2026 Securizen Technologies. All rights reserved.</p></div></div>`);
}

// Daily report at 9 AM IST = 3:30 AM UTC
async function sendDailyReports() {
  try {
    const { rows: admins } = await pool.query(
      "SELECT u.email,u.name,s.name as society_name,s.code FROM users u JOIN societies s ON u.society_id=s.id WHERE u.role='admin' AND u.is_active=true"
    );
    for (const admin of admins) {
      const cid = admin.code;
      const vt = `('person_detected','vehicle_detected','crowd_detected')`;
      const [todayR, yestR, camsR, downR] = await Promise.all([
        pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND (timestamp_utc+INTERVAL '5 hours 30 minutes')::date=(NOW()-INTERVAL '5 hours 30 minutes')::date AND client_id=$1`,[cid]),
        pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND (timestamp_utc+INTERVAL '5 hours 30 minutes')::date=((NOW()-INTERVAL '5 hours 30 minutes')::date-INTERVAL '1 day') AND client_id=$1`,[cid]),
        pool.query(`SELECT camera_id,camera_location as location,COUNT(*) as count FROM events WHERE timestamp_utc>=NOW()-INTERVAL '1 day' AND client_id=$1 GROUP BY camera_id,camera_location ORDER BY count DESC`,[cid]),
        pool.query(`SELECT camera_id,COUNT(*) as incidents FROM events WHERE event_type='camera_offline' AND timestamp_utc>=NOW()-INTERVAL '1 day' AND client_id=$1 GROUP BY camera_id`,[cid]),
      ]);
      const today = parseInt(todayR.rows[0].v);
      const yest  = parseInt(yestR.rows[0].v);
      const delta = today - yest;
      const camRows = camsR.rows.map(r => `<tr><td style="padding:8px 12px;border-bottom:1px solid #1e293b">${r.camera_id}</td><td style="padding:8px 12px;border-bottom:1px solid #1e293b">${r.location}</td><td style="padding:8px 12px;border-bottom:1px solid #1e293b;color:#38bdf8">${r.count}</td></tr>`).join("");
      const downRows = downR.rows.length ? downR.rows.map(r => `<tr><td style="padding:8px 12px">${r.camera_id}</td><td style="padding:8px 12px;color:#f87171">${r.incidents} incident(s)</td></tr>`).join("") : `<tr><td colspan="2" style="padding:8px 12px;color:#4ade80">All cameras online ✅</td></tr>`;
      const date = new Date(Date.now()+IST_OFFSET_MS).toLocaleDateString("en-IN",{weekday:"long",year:"numeric",month:"long",day:"numeric"});
      await sendEmail(admin.email, `📊 Daily Report — ${admin.society_name} — ${date}`, `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
          <div style="background:#0f1923;padding:32px;border-radius:12px;color:#e2e8f0">
            <h2 style="color:#38bdf8;margin:0 0 4px">Daily Security Report</h2>
            <p style="color:#64748b;margin:0 0 24px">${admin.society_name} · ${date}</p>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px">
              <div style="background:#0a0c10;padding:16px;border-radius:8px;border:1px solid rgba(56,189,248,0.1)">
                <div style="color:#64748b;font-size:12px;margin-bottom:4px">TODAY'S VISITORS</div>
                <div style="font-size:32px;font-weight:800;color:#38bdf8">${today}</div>
                <div style="font-size:12px;color:${delta>=0?"#4ade80":"#f87171"}">${delta>=0?"▲":"▼"} ${Math.abs(delta)} vs yesterday</div>
              </div>
              <div style="background:#0a0c10;padding:16px;border-radius:8px;border:1px solid rgba(56,189,248,0.1)">
                <div style="color:#64748b;font-size:12px;margin-bottom:4px">YESTERDAY</div>
                <div style="font-size:32px;font-weight:800;color:#818cf8">${yest}</div>
              </div>
            </div>
            <h3 style="color:#e2e8f0;margin:0 0 12px">Camera Activity</h3>
            <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
              <thead><tr style="background:#0a0c10"><th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px">CAMERA</th><th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px">LOCATION</th><th style="padding:8px 12px;text-align:left;color:#64748b;font-size:11px">EVENTS</th></tr></thead>
              <tbody>${camRows||"<tr><td colspan='3' style='padding:8px 12px;color:#64748b'>No events today</td></tr>"}</tbody>
            </table>
            <h3 style="color:#e2e8f0;margin:0 0 12px">Camera Downtime</h3>
            <table style="width:100%;border-collapse:collapse">
              <tbody>${downRows}</tbody>
            </table>
            <p style="margin-top:24px;color:#475569;font-size:11px">SocietyGuard Security Platform · Auto-generated daily report</p>
          </div>
        </div>`);
    }
    console.log(`Daily reports sent to ${admins.length} admin(s)`);
  } catch (err) { console.error("Daily report error:", err.message); }
}

// Schedule daily report at 3:30 AM UTC (9 AM IST)
// ── KEEP-ALIVE PING (prevents Render free tier spin-down) ──
const SELF_URL = process.env.RENDER_EXTERNAL_URL || "https://societyguard-backend.onrender.com";
setInterval(async () => {
  try {
    await fetch(SELF_URL + "/health");
    console.log("Keep-alive ping sent");
  } catch(e) { console.log("Keep-alive ping failed:", e.message); }
}, 14 * 60 * 1000); // every 14 minutes

function scheduleDailyReport() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(3,30,0,0);
  if (next <= now) next.setUTCDate(next.getUTCDate()+1);
  const ms = next-now;
  console.log(`Daily report scheduled in ${Math.round(ms/60000)} minutes`);
  setTimeout(()=>{ sendDailyReports(); setInterval(sendDailyReports, 24*60*60*1000); }, ms);
}

// ── HELPERS ──
function toIST(utcStr) {
  const d = new Date(utcStr);
  if (isNaN(d)) return null;
  return new Date(d.getTime()+IST_OFFSET_MS).toISOString();
}
function mapEventType(type, raw) {
  if (!type) return "unknown";
  const t = type.toLowerCase();
  // Handle Analytic events — check objectsFound for actual type
  if (t === "analytic" || t.includes("analytic")) {
    const objects = raw?.data?.objectsFound || raw?.objectsFound || [];
    const types = objects.map(o => (o.type||"").toLowerCase());
    if (types.some(x => x.includes("person")||x.includes("people"))) return "person_detected";
    if (types.some(x => x.includes("vehicle")||x.includes("car")))   return "vehicle_detected";
    if (types.some(x => x.includes("crowd")))                         return "crowd_detected";
    if (types.some(x => x.includes("face")))                          return "person_detected";
    return "analytic"; // keep as analytic if no match
  }
  if (t.includes("motion")||t.includes("person")||t.includes("people")) return "person_detected";
  if (t.includes("vehicle")||t.includes("car")||t.includes("alpr"))     return "vehicle_detected";
  if (t.includes("crowd"))    return "crowd_detected";
  if (t.includes("loiter"))   return "loitering";
  if (t.includes("offline")||t.includes("disconnect")) return "camera_offline";
  if (t.includes("online")||t.includes("connect"))     return "camera_online";
  return t;
}
async function getCameraName(cameraUid) {
  const { rows } = await pool.query("SELECT name FROM cameras WHERE camera_uid=$1", [cameraUid]);
  return rows[0]?.name || `Camera ${cameraUid}`;
}
async function getSocietyCode(integration) {
  if (!integration) return "C01";
  const raw = integration.clientId || integration.siteId || "C01";
  const { rows } = await pool.query("SELECT code FROM societies WHERE code=$1 OR id::text=$1", [raw]);
  return rows[0]?.code || raw;
}
async function auditLog(action, entity, entity_id, details, user, ip, society_id) {
  try {
    await pool.query(
      "INSERT INTO audit_logs (user_id,username,role,action,entity,entity_id,details,ip_address,society_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [user?.id||null, user?.username||"system", user?.role||"system", action, entity||null, entity_id?.toString()||null, JSON.stringify(details||{}), ip||null, society_id||null]
    );
  } catch(e) { console.error("Audit log error:", e.message); }
}

// ── MIDDLEWARE ──
app.use(express.json({ limit: "10mb" }));
app.use(cors({ origin: true, methods:["GET","POST","PUT","DELETE"], allowedHeaders:["Content-Type","x-api-key","x-user-id"] }));

function requireApiKey(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error:"Unauthorized" });
  next();
}
async function requireAuth(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error:"Unauthorized" });
  const uid = req.headers["x-user-id"];
  if (uid) {
    const { rows } = await pool.query("SELECT id,username,role,society_id FROM users WHERE id=$1 AND is_active=true", [uid]);
    if (rows.length) req.currentUser = rows[0];
  }
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.currentUser) return res.status(401).json({ error:"Not authenticated" });
    if (!roles.includes(req.currentUser.role)) return res.status(403).json({ error:"Forbidden" });
    next();
  };
}

// ── POST /webhook ──
app.post("/webhook", async (req, res) => {
  console.log("📡 Webhook received:", JSON.stringify(req.body).slice(0,200));
  const rawEvents = Array.isArray(req.body) ? req.body : [req.body];
  let processed = 0;
  for (const raw of rawEvents) {
    const camera_id      = String(raw.deviceId || raw.camera_id || "UNKNOWN");
    const event_type_raw = raw.type || raw.event_type || "unknown";
    const event_type     = mapEventType(event_type_raw, raw);
    const timestamp_utc  = raw.data?.startTimeUtc || raw.timestamp_utc || new Date().toISOString();
    const client_id      = await getSocietyCode(raw.integration);
    const thumbnail_url  = raw.data?.thumbnailUrl   || null;
    const video_url      = raw.data?.sharedVideoUrl || null;
    const ist            = toIST(timestamp_utc);
    if (!ist) { console.log("⚠️ Skipping event - invalid timestamp:", timestamp_utc); continue; }
    const camName        = await getCameraName(camera_id);
    const visitorTypes   = ["person_detected","vehicle_detected","crowd_detected"];
    const event_uid      = `${camera_id}-${raw.id||Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const objects = raw?.data?.objectsFound || raw?.objectsFound || [];
    const visitorCount = visitorTypes.includes(event_type) ? Math.max(1, objects.filter(o=>["person","people","face"].includes((o.type||"").toLowerCase())).length) : 0;
    const event = { event_uid, camera_id, camera_location:camName, event_type, event_type_raw, visitor_count:visitorCount, confidence:raw.confidence||null, client_id, thumbnail_url, video_url, metadata:raw.data||{}, timestamp_utc, timestamp_ist:ist, source_id:String(raw.id||"") };
    try {
      await pool.query(
        `INSERT INTO events (event_uid,camera_id,camera_location,event_type,event_type_raw,visitor_count,confidence,client_id,thumbnail_url,video_url,metadata,timestamp_utc,timestamp_ist,source_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (event_uid) DO NOTHING`,
        [event.event_uid,event.camera_id,event.camera_location,event.event_type,event.event_type_raw,event.visitor_count,event.confidence,event.client_id,event.thumbnail_url,event.video_url,JSON.stringify(event.metadata),event.timestamp_utc,event.timestamp_ist,event.source_id]
      );
      processed++;
      await auditLog("webhook_event", "event", event_uid, {camera_id, event_type, client_id}, null, null, null);
      if (event_type==="camera_offline") await sendOfflineAlert(event);
    } catch (err) { console.error("DB insert error:", err.message, JSON.stringify(event).slice(0,200)); }
  }
  return res.status(200).json({ received:processed });
});

// ── POST /api/login ──
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username||!password) return res.status(400).json({ error:"Missing credentials" });
  try {
    const { rows } = await pool.query(`
      SELECT u.*,
        COALESCE(json_agg(json_build_object('id',s.id,'name',s.name,'code',s.code)) FILTER (WHERE s.id IS NOT NULL),'[]') as societies
      FROM users u
      LEFT JOIN user_societies us ON us.user_id=u.id
      LEFT JOIN societies s ON s.id=us.society_id
      WHERE u.username=$1 AND u.is_active=true
      GROUP BY u.id
    `, [username]);
    if (!rows.length) return res.status(401).json({ error:"Invalid credentials" });
    const user = rows[0];
    if (!user.password_hash) return res.status(401).json({ error:"Account not activated. Check your email." });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error:"Invalid credentials" });
    await pool.query("UPDATE users SET last_login=NOW() WHERE id=$1", [user.id]);
    await auditLog("login", "user", user.id, { username }, user, req.ip, user.society_id);
    return res.json({ id:user.id, username:user.username, role:user.role, name:user.name, societies:user.societies||[], client:(user.societies&&user.societies[0]?.code)||user.society_code||null, society_name:(user.societies&&user.societies[0]?.name)||user.society_name||null });
  } catch (err) { return res.status(500).json({ error:"Login failed" }); }
});

// ── POST /api/set-password (invite token) ──
app.post("/api/set-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token||!password) return res.status(400).json({ error:"Missing fields" });
  const { rows } = await pool.query("SELECT * FROM users WHERE invite_token=$1 AND invite_expires>NOW()", [token]);
  if (!rows.length) return res.status(400).json({ error:"Invalid or expired invite link" });
  const hash = await bcrypt.hash(password, 12);
  await pool.query("UPDATE users SET password_hash=$1,invite_token=NULL,invite_expires=NULL WHERE id=$2", [hash, rows[0].id]);
  await auditLog("set_password", "user", rows[0].id, {}, rows[0], req.ip, rows[0].society_id);
  return res.json({ message:"Password set! You can now log in." });
});

// ── SOCIETIES ──
app.get("/api/societies", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT s.*,COUNT(DISTINCT u.id) as user_count,COUNT(DISTINCT c.id) as camera_count FROM societies s LEFT JOIN users u ON u.society_id=s.id LEFT JOIN cameras c ON c.society_id=s.id GROUP BY s.id ORDER BY s.name");
  return res.json(rows);
});
app.post("/api/societies", requireAuth, requireRole("superuser"), async (req, res) => {
  const { code, name, address } = req.body;
  if (!code||!name) return res.status(400).json({ error:"Code and name required" });
  try {
    const { rows } = await pool.query("INSERT INTO societies (code,name,address) VALUES ($1,$2,$3) RETURNING *", [code.toUpperCase(), name, address||""]);
    await auditLog("create_society", "society", rows[0].id, {code, name}, req.currentUser, req.ip, rows[0].id);
    return res.json(rows[0]);
  } catch(e) { return res.status(400).json({ error:"Society code already exists" }); }
});
app.put("/api/societies/:id", requireAuth, requireRole("superuser"), async (req, res) => {
  const { name, address, logo_url, is_active } = req.body;
  const { rows } = await pool.query("UPDATE societies SET name=COALESCE($1,name),address=COALESCE($2,address),logo_url=COALESCE($3,logo_url),is_active=COALESCE($4,is_active) WHERE id=$5 RETURNING *", [name, address, logo_url, is_active, req.params.id]);
  await auditLog("update_society", "society", req.params.id, req.body, req.currentUser, req.ip, req.params.id);
  return res.json(rows[0]);
});
app.delete("/api/societies/:id", requireAuth, requireRole("superuser"), async (req, res) => {
  await pool.query("DELETE FROM societies WHERE id=$1", [req.params.id]);
  await auditLog("delete_society", "society", req.params.id, {}, req.currentUser, req.ip, req.params.id);
  return res.json({ deleted:true });
});

// ── WINGS ──
app.get("/api/wings", requireAuth, async (req, res) => {
  const { society_id } = req.query;
  const { rows } = await pool.query("SELECT * FROM wings WHERE ($1::int IS NULL OR society_id=$1) ORDER BY name", [society_id||null]);
  return res.json(rows);
});
app.post("/api/wings", requireAuth, requireRole("superuser"), async (req, res) => {
  const { society_id, name, description } = req.body;
  const { rows } = await pool.query("INSERT INTO wings (society_id,name,description) VALUES ($1,$2,$3) RETURNING *", [society_id, name, description||""]);
  await auditLog("create_wing", "wing", rows[0].id, {name, society_id}, req.currentUser, req.ip, society_id);
  return res.json(rows[0]);
});
app.delete("/api/wings/:id", requireAuth, requireRole("superuser"), async (req, res) => {
  await pool.query("DELETE FROM wings WHERE id=$1", [req.params.id]);
  return res.json({ deleted:true });
});

// ── CAMERAS ──
app.get("/api/cameras", requireAuth, async (req, res) => {
  const { society_id } = req.query;
  const { rows } = await pool.query("SELECT c.*,s.name as society_name,w.name as wing_name FROM cameras c LEFT JOIN societies s ON c.society_id=s.id LEFT JOIN wings w ON c.wing_id=w.id WHERE ($1::int IS NULL OR c.society_id=$1) ORDER BY c.name", [society_id||null]);
  return res.json(rows);
});
app.post("/api/cameras", requireAuth, requireRole("superuser"), async (req, res) => {
  const { camera_uid, name, society_id, wing_id, location } = req.body;
  if (!camera_uid||!name) return res.status(400).json({ error:"UID and name required" });
  try {
    const { rows } = await pool.query("INSERT INTO cameras (camera_uid,name,society_id,wing_id,location) VALUES ($1,$2,$3,$4,$5) RETURNING *", [camera_uid, name, society_id||null, wing_id||null, location||""]);
    await auditLog("create_camera", "camera", rows[0].id, {camera_uid, name, society_id}, req.currentUser, req.ip, society_id);
    return res.json(rows[0]);
  } catch(e) { return res.status(400).json({ error:"Camera UID already exists" }); }
});
app.put("/api/cameras/:id", requireAuth, requireRole("superuser"), async (req, res) => {
  const { name, society_id, wing_id, location, is_active } = req.body;
  const { rows } = await pool.query("UPDATE cameras SET name=COALESCE($1,name),society_id=COALESCE($2,society_id),wing_id=COALESCE($3,wing_id),location=COALESCE($4,location),is_active=COALESCE($5,is_active) WHERE id=$6 RETURNING *", [name,society_id,wing_id,location,is_active,req.params.id]);
  await auditLog("update_camera", "camera", req.params.id, req.body, req.currentUser, req.ip, society_id);
  return res.json(rows[0]);
});
app.delete("/api/cameras/:id", requireAuth, requireRole("superuser"), async (req, res) => {
  await pool.query("DELETE FROM cameras WHERE id=$1", [req.params.id]);
  return res.json({ deleted:true });
});

// ── USERS ──
app.get("/api/users", requireAuth, requireRole("superuser"), async (req, res) => {
  const { rows } = await pool.query(`
    SELECT u.id,u.username,u.role,u.name,u.email,u.is_active,u.last_login,u.created_at,
      COALESCE(json_agg(json_build_object('id',s.id,'name',s.name,'code',s.code)) FILTER (WHERE s.id IS NOT NULL),'[]') as societies
    FROM users u
    LEFT JOIN user_societies us ON us.user_id=u.id
    LEFT JOIN societies s ON s.id=us.society_id
    GROUP BY u.id ORDER BY u.created_at DESC
  `);
  return res.json(rows);
});
app.post("/api/users", requireAuth, requireRole("superuser"), async (req, res) => {
  const { username, role, name, society_id, society_ids } = req.body;
  const email = (req.body.email||'').trim();
  if (!username||!role||!name||!email) return res.status(400).json({ error:"All fields required" });
  // Pre-check — auto-delete stuck incomplete records (no password set), block real conflicts
  try {
    const check = await pool.query("SELECT id,username,email,password_hash FROM users WHERE username=$1 OR email=$2", [username, email]);
    for (const row of check.rows) {
      if (!row.password_hash) {
        await pool.query("DELETE FROM users WHERE id=$1", [row.id]);
        console.log("Cleaned stuck user:", row.username, row.email);
      } else {
        if (row.username===username) return res.status(400).json({ error:`Username "${username}" is already taken. Choose a different one.` });
        if (row.email===email) return res.status(400).json({ error:`Email "${email}" is already used by an active account.` });
      }
    }
  } catch(e) { console.error("Pre-check error:", e.message); }
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now()+24*60*60*1000);
  try {
    const { rows } = await pool.query(
      "INSERT INTO users (username,role,name,email,invite_token,invite_expires) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [username, role, name, email, token, expires]
    );
    const newUser = rows[0];
    // Insert all society access
    const sids = Array.isArray(society_ids) ? society_ids : (society_id ? [society_id] : []);
    for (const sid of sids) {
      await pool.query("INSERT INTO user_societies (user_id,society_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [newUser.id, sid]);
    }
    await sendInviteEmail(newUser, token);
    await auditLog("create_user", "user", newUser.id, {username, role, name, email}, req.currentUser, req.ip, sids[0]||null);
    return res.json({ ...newUser, message:`Invite sent to ${email}` });
  } catch(e) {
    console.error("User create DB error:", e.message, "code:", e.code, "constraint:", e.constraint);
    return res.status(400).json({ error: e.detail || e.message || "Failed to create user" });
  }
});
app.put("/api/users/:id", requireAuth, requireRole("superuser"), async (req, res) => {
  const { name, role, email, society_ids, is_active } = req.body;
  const { rows } = await pool.query(
    "UPDATE users SET name=COALESCE($1,name),role=COALESCE($2,role),email=COALESCE($3,email),is_active=COALESCE($4,is_active) WHERE id=$5 RETURNING id,username,role,name,email,is_active",
    [name,role,email,is_active,req.params.id]
  );
  if (Array.isArray(society_ids)) {
    await pool.query("DELETE FROM user_societies WHERE user_id=$1", [req.params.id]);
    for (const sid of society_ids) {
      await pool.query("INSERT INTO user_societies (user_id,society_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [req.params.id, sid]);
    }
  }
  await auditLog("update_user", "user", req.params.id, req.body, req.currentUser, req.ip, null);
  return res.json(rows[0]);
});
app.delete("/api/users/:id", requireAuth, requireRole("superuser"), async (req, res) => {
  await pool.query("UPDATE users SET is_active=false WHERE id=$1", [req.params.id]);
  await auditLog("deactivate_user", "user", req.params.id, {}, req.currentUser, req.ip, null);
  return res.json({ deactivated:true });
});
app.post("/api/users/:id/resend-invite", requireAuth, requireRole("superuser"), async (req, res) => {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now()+24*60*60*1000);
  const { rows } = await pool.query("UPDATE users SET invite_token=$1,invite_expires=$2 WHERE id=$3 RETURNING *", [token, expires, req.params.id]);
  if (!rows.length) return res.status(404).json({ error:"User not found" });
  await sendInviteEmail(rows[0], token);
  return res.json({ message:"Invite resent" });
});

// ── APP SETTINGS (logo) ──
app.get("/api/settings", requireApiKey, async (req, res) => {
  const { rows } = await pool.query("SELECT key,value FROM app_settings");
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  return res.json(settings);
});
app.post("/api/settings", requireAuth, requireRole("superuser"), async (req, res) => {
  const { key, value } = req.body;
  await pool.query("INSERT INTO app_settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2,updated_at=NOW()", [key, value]);
  await auditLog("update_setting", "setting", key, {key, value: key==="logo_url"?"[image]":value}, req.currentUser, req.ip, null);
  return res.json({ key, value });
});

// ── AUDIT LOGS ──
app.get("/api/logs", requireAuth, async (req, res) => {
  const { limit=100, offset=0, society_id, action } = req.query;
  let where=[]; let params=[];
  if (req.currentUser?.role==="admin") { params.push(req.currentUser.society_id); where.push(`society_id=$${params.length}`); }
  else if (society_id) { params.push(society_id); where.push(`society_id=$${params.length}`); }
  if (action) { params.push(action); where.push(`action=$${params.length}`); }
  params.push(parseInt(limit)); params.push(parseInt(offset));
  const sql = `SELECT * FROM audit_logs ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`;
  const { rows } = await pool.query(sql, params);
  const { rows:cnt } = await pool.query(`SELECT COUNT(*) as total FROM audit_logs ${where.length?"WHERE "+where.slice(0,-2).join(" AND "):""}`);
  return res.json({ total:parseInt(cnt[0]?.total||0), logs:rows });
});

// ── EVENTS ──
app.get("/api/events", requireAuth, async (req, res) => {
  const { client_id, event_type, from, to, limit=200 } = req.query;
  let where=[]; let params=[];
  const cid = req.currentUser?.role==="admin" ? req.currentUser.society_id : null;
  if (client_id) { params.push(client_id); where.push(`client_id=$${params.length}`); }
  if (event_type) { params.push(event_type); where.push(`event_type=$${params.length}`); }
  if (from) { params.push(from); where.push(`timestamp_ist>=$${params.length}`); }
  if (to)   { params.push(to);   where.push(`timestamp_ist<=$${params.length}`); }
  params.push(parseInt(limit));
  const { rows } = await pool.query(`SELECT * FROM events ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY timestamp_ist DESC LIMIT $${params.length}`, params);
  return res.json({ total:rows.length, events:rows });
});

// ── STATS ──
app.get("/api/stats", requireAuth, async (req, res) => {
  const { client_id } = req.query;
  const cid = client_id ? `AND client_id='${client_id.replace(/'/g,"''")}'` : "";
  const vt  = `('person_detected','vehicle_detected','crowd_detected')`;
  try {
    const [todayR,yestR,weekR,camsR,downR,countR] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND (timestamp_utc+INTERVAL '5 hours 30 minutes')::date=(NOW()-INTERVAL '5 hours 30 minutes')::date ${cid}`),
      pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND (timestamp_utc+INTERVAL '5 hours 30 minutes')::date=((NOW()-INTERVAL '5 hours 30 minutes')::date-INTERVAL '1 day') ${cid}`),
      pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND timestamp_utc>=NOW()-INTERVAL '7 days' ${cid}`),
      pool.query(`SELECT e.camera_id,COALESCE(c.name,'Camera '||e.camera_id) as location,COUNT(*) as count FROM events e LEFT JOIN cameras c ON c.camera_uid=e.camera_id WHERE e.timestamp_utc>=NOW()-INTERVAL '7 days' ${cid} GROUP BY e.camera_id,c.name ORDER BY count DESC`),
      pool.query(`SELECT e.camera_id,COALESCE(c.name,'Camera '||e.camera_id) as location,COUNT(*) as incidents,COUNT(*)*30 as downtime_minutes FROM events e LEFT JOIN cameras c ON c.camera_uid=e.camera_id WHERE e.event_type='camera_offline' ${cid} GROUP BY e.camera_id,c.name`),
      pool.query("SELECT COUNT(*) as total FROM events"),
    ]);
    const hourly=[];
    for (let h=5;h<=22;h++) {
      const [t,y]=await Promise.all([
        pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND EXTRACT(HOUR FROM (timestamp_utc+INTERVAL '5 hours 30 minutes'))=$1 AND (timestamp_utc+INTERVAL '5 hours 30 minutes')::date=(NOW()-INTERVAL '5 hours 30 minutes')::date ${cid}`,[h]),
        pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND EXTRACT(HOUR FROM (timestamp_utc+INTERVAL '5 hours 30 minutes'))=$1 AND (timestamp_utc+INTERVAL '5 hours 30 minutes')::date=((NOW()-INTERVAL '5 hours 30 minutes')::date-INTERVAL '1 day') ${cid}`,[h]),
      ]);
      hourly.push({hour:h,label:`${h}:00`,today:parseInt(t.rows[0].v),yesterday:parseInt(y.rows[0].v)});
    }
    const weekly=[];
    for (let i=6;i>=0;i--) {
      const {rows}=await pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND (timestamp_utc+INTERVAL '5 hours 30 minutes')::date=((NOW()-INTERVAL '5 hours 30 minutes')::date-($1*INTERVAL '1 day')::interval) ${cid}`,[i]);
      const d=new Date(Date.now()+IST_OFFSET_MS); d.setDate(d.getDate()-i);
      weekly.push({label:d.toLocaleDateString("en-IN",{weekday:"short",day:"numeric"}),visitors:parseInt(rows[0]?.v||0)});
    }
    return res.json({
      generated_at_ist:toIST(new Date().toISOString()),
      visitors:{today:parseInt(todayR.rows[0].v),yesterday:parseInt(yestR.rows[0].v),week:parseInt(weekR.rows[0].v)},
      camera_activity:camsR.rows.map(r=>({...r,count:parseInt(r.count)})),
      downtime:downR.rows.map(r=>({...r,incidents:parseInt(r.incidents),downtime_minutes:parseInt(r.downtime_minutes)})),
      trends:{hourly,weekly},
      total_events_stored:parseInt(countR.rows[0].total),
    });
  } catch (err) { return res.status(500).json({ error:err.message }); }
});

app.delete("/api/events", requireAuth, requireRole("superuser"), async (req,res) => {
  const {rows}=await pool.query("SELECT COUNT(*) as total FROM events");
  await pool.query("DELETE FROM events");
  return res.json({ cleared:parseInt(rows[0].total) });
});

app.get("/health", async (_,res) => {
  const {rows}=await pool.query("SELECT COUNT(*) as total FROM events");
  return res.json({ status:"ok", events_stored:parseInt(rows[0].total), time_ist:toIST(new Date().toISOString()), database:"PostgreSQL", email_alerts:(process.env.SENDGRID_API_KEY||process.env.RESEND_API_KEY)?"enabled":"disabled" });
});

// ── START ──
initDB().then(()=>{
  scheduleDailyReport();
  app.listen(PORT,()=>{
    console.log(`SocietyGuard v3 running on port ${PORT}`);
    console.log(`Email: ${process.env.SENDGRID_API_KEY?"enabled (SendGrid)":process.env.RESEND_API_KEY?"enabled (Resend)":"disabled"}`);
  });
}).catch(err=>{ console.error("DB init failed:",err.message); process.exit(1); });
