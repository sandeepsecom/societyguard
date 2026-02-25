/**
 * SocietyGuard - Full Backend
 * Features: PostgreSQL, 3deye mapping, email alerts, thumbnails, strong passwords
 */

const express    = require("express");
const cors       = require("cors");
const { Pool }   = require("pg");
const nodemailer = require("nodemailer");
const bcrypt     = require("bcryptjs");

const app  = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "sg-mysociety-2026";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ── DATABASE ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
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
    CREATE INDEX IF NOT EXISTS idx_client  ON events(client_id);
    CREATE INDEX IF NOT EXISTS idx_cam     ON events(camera_id);
    CREATE INDEX IF NOT EXISTS idx_type    ON events(event_type);
    CREATE INDEX IF NOT EXISTS idx_ts_ist  ON events(timestamp_ist);

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL,
      name          TEXT NOT NULL,
      client_id     TEXT,
      email         TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  const { rowCount } = await pool.query("SELECT 1 FROM users LIMIT 1");
  if (rowCount === 0) {
    const users = [
      { username:"superadmin", password:"Super@Guard2026!",  role:"superuser", name:"Raj Mehta",    client:null,  email: process.env.ALERT_EMAIL||"" },
      { username:"secretary",  password:"GreenValley@2026!", role:"admin",     name:"Priya Sharma", client:"C01", email:"" },
      { username:"chairman",   password:"Sunrise@2026!",     role:"admin",     name:"Vikram Nair",  client:"C02", email:"" },
      { username:"guard1",     password:"Guard@Secure26!",   role:"operator",  name:"Suresh Kumar", client:"C01", email:"" },
    ];
    for (const u of users) {
      const hash = await bcrypt.hash(u.password, 12);
      await pool.query(
        "INSERT INTO users (username,password_hash,role,name,client_id,email) VALUES ($1,$2,$3,$4,$5,$6)",
        [u.username, hash, u.role, u.name, u.client, u.email]
      );
    }
    console.log("Default users seeded with strong passwords");
  }
  console.log("Database ready");
}

// ── EMAIL ALERTS ──
const transporter = process.env.SMTP_USER ? nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: 587, secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

async function sendOfflineAlert(event) {
  if (!transporter || !process.env.ALERT_EMAIL) return;
  try {
    await transporter.sendMail({
      from:    `"SocietyGuard Alert" <${process.env.SMTP_USER}>`,
      to:      process.env.ALERT_EMAIL,
      subject: `Camera Offline: ${event.camera_id} - ${event.camera_location}`,
      html: `<div style="font-family:sans-serif;max-width:500px">
        <div style="background:#0f1923;padding:24px;border-radius:12px;color:#e2e8f0">
          <h2 style="color:#f87171;margin:0 0 16px">Camera Offline Alert</h2>
          <p><b style="color:#64748b">Camera:</b> <span style="color:#38bdf8">${event.camera_id}</span></p>
          <p><b style="color:#64748b">Location:</b> ${event.camera_location}</p>
          <p><b style="color:#64748b">Society:</b> ${event.client_id}</p>
          <p><b style="color:#64748b">Time (IST):</b> ${new Date(event.timestamp_ist).toLocaleString("en-IN")}</p>
          <p style="margin-top:16px;color:#64748b;font-size:12px">SocietyGuard Security Platform</p>
        </div>
      </div>`,
    });
    console.log("Offline alert sent for " + event.camera_id);
  } catch (err) {
    console.error("Email failed:", err.message);
  }
}

// ── HELPERS ──
function toIST(utcStr) {
  const d = new Date(utcStr);
  if (isNaN(d)) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString();
}

function mapEventType(type) {
  if (!type) return "unknown";
  const t = type.toLowerCase();
  if (t.includes("motion")||t.includes("person")||t.includes("people")) return "person_detected";
  if (t.includes("vehicle")||t.includes("car")||t.includes("alpr"))     return "vehicle_detected";
  if (t.includes("crowd"))    return "crowd_detected";
  if (t.includes("loiter"))   return "loitering";
  if (t.includes("offline")||t.includes("disconnect")) return "camera_offline";
  if (t.includes("online")||t.includes("connect"))     return "camera_online";
  return t;
}

const CLIENT_MAP = {
  "54321": "C01",
  "54322": "C02",
  "54323": "C03",
};
function resolveClientId(integration) {
  if (!integration) return "C01";
  const raw = integration.clientId || integration.siteId || integration.deviceId || "C01";
  return CLIENT_MAP[raw] || raw;
}

// ── MIDDLEWARE ──
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL||"*", methods:["GET","POST","DELETE"], allowedHeaders:["Content-Type","x-api-key"] }));

function requireApiKey(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error:"Unauthorized" });
  next();
}

// ── POST /webhook ──
app.post("/webhook", async (req, res) => {
  const rawEvents = Array.isArray(req.body) ? req.body : [req.body];
  let processed = 0;
  for (const raw of rawEvents) {
    const camera_id      = String(raw.deviceId || raw.camera_id || "UNKNOWN");
    const event_type_raw = raw.type || raw.event_type || "unknown";
    const event_type     = mapEventType(event_type_raw);
    const timestamp_utc  = raw.data?.startTimeUtc || raw.timestamp_utc || new Date().toISOString();
    const client_id      = resolveClientId(raw.integration);
    const thumbnail_url  = raw.data?.thumbnailUrl   || null;
    const video_url      = raw.data?.sharedVideoUrl || null;
    const ist            = toIST(timestamp_utc);
    if (!ist) continue;
    const visitorTypes   = ["person_detected","vehicle_detected","crowd_detected"];
    const event_uid      = `${camera_id}-${raw.id||Date.now()}-${Math.random().toString(36).slice(2,6)}`;
    const event = { event_uid, camera_id, camera_location: raw.camera_location||`Camera ${camera_id}`, event_type, event_type_raw, visitor_count: visitorTypes.includes(event_type)?1:0, confidence: raw.confidence||null, client_id, thumbnail_url, video_url, metadata: raw.data||{}, timestamp_utc, timestamp_ist: ist, source_id: String(raw.id||"") };
    try {
      await pool.query(
        `INSERT INTO events (event_uid,camera_id,camera_location,event_type,event_type_raw,visitor_count,confidence,client_id,thumbnail_url,video_url,metadata,timestamp_utc,timestamp_ist,source_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (event_uid) DO NOTHING`,
        [event.event_uid,event.camera_id,event.camera_location,event.event_type,event.event_type_raw,event.visitor_count,event.confidence,event.client_id,event.thumbnail_url,event.video_url,JSON.stringify(event.metadata),event.timestamp_utc,event.timestamp_ist,event.source_id]
      );
      processed++;
      if (event_type === "camera_offline") await sendOfflineAlert(event);
    } catch (err) { console.error("DB insert:", err.message); }
  }
  console.log(`[WEBHOOK] ${processed} event(s) stored`);
  return res.status(200).json({ received: processed });
});

// ── POST /api/login ──
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username||!password) return res.status(400).json({ error:"Missing credentials" });
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE username=$1", [username]);
    if (!rows.length) return res.status(401).json({ error:"Invalid credentials" });
    const match = await bcrypt.compare(password, rows[0].password_hash);
    if (!match) return res.status(401).json({ error:"Invalid credentials" });
    const u = rows[0];
    return res.json({ id:u.id, username:u.username, role:u.role, name:u.name, client:u.client_id });
  } catch (err) { return res.status(500).json({ error:"Login failed" }); }
});

// ── GET /api/events ──
app.get("/api/events", requireApiKey, async (req, res) => {
  const { client_id, event_type, from, to, limit=200 } = req.query;
  let where=[]; let params=[];
  if (client_id)  { params.push(client_id);  where.push(`client_id=$${params.length}`); }
  if (event_type) { params.push(event_type); where.push(`event_type=$${params.length}`); }
  if (from)       { params.push(from);       where.push(`timestamp_ist>=$${params.length}`); }
  if (to)         { params.push(to);         where.push(`timestamp_ist<=$${params.length}`); }
  params.push(parseInt(limit));
  const sql = `SELECT * FROM events ${where.length?"WHERE "+where.join(" AND "):""} ORDER BY timestamp_ist DESC LIMIT $${params.length}`;
  try {
    const { rows } = await pool.query(sql, params);
    return res.json({ total:rows.length, events:rows });
  } catch (err) { return res.status(500).json({ error:err.message }); }
});

// ── GET /api/stats ──
app.get("/api/stats", requireApiKey, async (req, res) => {
  const { client_id } = req.query;
  const cid = client_id ? `AND client_id='${client_id.replace(/'/g,"''")}'` : "";
  const vt  = `('person_detected','vehicle_detected','crowd_detected')`;
  try {
    const [todayR,yestR,weekR,camsR,downR,countR] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND timestamp_ist::date=CURRENT_DATE ${cid}`),
      pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND timestamp_ist::date=CURRENT_DATE-1 ${cid}`),
      pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND timestamp_ist>=NOW()-INTERVAL '7 days' ${cid}`),
      pool.query(`SELECT camera_id,camera_location as location,COUNT(*) as count FROM events WHERE timestamp_ist>=NOW()-INTERVAL '7 days' ${cid} GROUP BY camera_id,camera_location ORDER BY count DESC`),
      pool.query(`SELECT camera_id,camera_location as location,COUNT(*) as incidents,COUNT(*)*30 as downtime_minutes FROM events WHERE event_type='camera_offline' ${cid} GROUP BY camera_id,camera_location`),
      pool.query("SELECT COUNT(*) as total FROM events"),
    ]);

    // Hourly trend
    const hourly=[];
    for (let h=5;h<=22;h++) {
      const [t,y]=await Promise.all([
        pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND EXTRACT(HOUR FROM timestamp_ist)=$1 AND timestamp_ist::date=CURRENT_DATE ${cid}`,[h]),
        pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND EXTRACT(HOUR FROM timestamp_ist)=$1 AND timestamp_ist::date=CURRENT_DATE-1 ${cid}`,[h]),
      ]);
      hourly.push({hour:h,label:`${h}:00`,today:parseInt(t.rows[0].v),yesterday:parseInt(y.rows[0].v)});
    }

    // Weekly trend
    const weekly=[];
    for (let i=6;i>=0;i--) {
      const {rows}=await pool.query(`SELECT COALESCE(SUM(visitor_count),0) as v FROM events WHERE event_type IN ${vt} AND timestamp_ist::date=CURRENT_DATE-$1 ${cid}`,[i]);
      const d=new Date(); d.setDate(d.getDate()-i);
      weekly.push({label:d.toLocaleDateString("en-IN",{weekday:"short",day:"numeric"}),visitors:parseInt(rows[0]?.v||0)});
    }

    return res.json({
      generated_at_ist: toIST(new Date().toISOString()),
      visitors:{ today:parseInt(todayR.rows[0].v), yesterday:parseInt(yestR.rows[0].v), week:parseInt(weekR.rows[0].v) },
      camera_activity: camsR.rows.map(r=>({...r,count:parseInt(r.count)})),
      downtime: downR.rows.map(r=>({...r,incidents:parseInt(r.incidents),downtime_minutes:parseInt(r.downtime_minutes)})),
      trends:{ hourly, weekly },
      total_events_stored: parseInt(countR.rows[0].total),
    });
  } catch (err) { return res.status(500).json({ error:err.message }); }
});

// ── DELETE /api/events ──
app.delete("/api/events", requireApiKey, async (req,res) => {
  const {rows}=await pool.query("SELECT COUNT(*) as total FROM events");
  await pool.query("DELETE FROM events");
  return res.json({ cleared:parseInt(rows[0].total) });
});

// ── GET /health ──
app.get("/health", async (_,res) => {
  const {rows}=await pool.query("SELECT COUNT(*) as total FROM events");
  return res.json({ status:"ok", events_stored:parseInt(rows[0].total), time_ist:toIST(new Date().toISOString()), database:"PostgreSQL", email_alerts: transporter?"enabled":"disabled (set SMTP env vars)" });
});

// ── START ──
initDB().then(()=>{
  app.listen(PORT,()=>{
    console.log(`SocietyGuard running on port ${PORT}`);
    console.log(`Email alerts: ${transporter?"enabled":"disabled"}`);
  });
}).catch(err=>{ console.error("DB init failed:",err.message); process.exit(1); });
