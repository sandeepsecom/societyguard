/**
 * SocietyGuard - Webhook Receiver Backend
 * Supports 3deye VMS webhook payload format
 */

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.API_KEY || "sg-mysociety-2026";
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

let eventStore = [];
const MAX_EVENTS = 5000;

function toIST(utcDateStr) {
  const d = new Date(utcDateStr);
  if (isNaN(d)) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString();
}

app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST", "DELETE"],
  allowedHeaders: ["Content-Type", "x-api-key", "x-webhook-signature"],
}));

// ── Map 3deye event types to our internal types ──
function mapEventType(type) {
  if (!type) return "unknown";
  const t = type.toLowerCase();
  if (t.includes("motion") || t.includes("person") || t.includes("people")) return "person_detected";
  if (t.includes("vehicle") || t.includes("car") || t.includes("alpr"))     return "vehicle_detected";
  if (t.includes("crowd"))                                                    return "crowd_detected";
  if (t.includes("loiter"))                                                   return "loitering";
  if (t.includes("offline") || t.includes("disconnect"))                     return "camera_offline";
  if (t.includes("online")  || t.includes("connect"))                        return "camera_online";
  return t; // pass through unknown types as-is
}

// ── Map 3deye client/site ID to our client_id ──
// Edit this map to match your society setup
const CLIENT_MAP = {
  "54321": "C01",  // Green Valley Society
  "54322": "C02",  // Sunrise Heights
  "54323": "C03",  // Royal Palms
  // Add more as needed
};

function resolveClientId(integration) {
  if (!integration) return "C01";
  const raw = integration.clientId || integration.siteId || integration.deviceId || "C01";
  return CLIENT_MAP[raw] || raw;
}

// ─────────────────────────────────────────────────────
// POST /webhook  — accepts 3deye payload (array or single)
// No API key required (3deye doesn't send one)
// ─────────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  const payload = req.body;
  const rawEvents = Array.isArray(payload) ? payload : [payload];
  const processed = [];

  for (const raw of rawEvents) {
    // ── Map 3deye fields to our schema ──
    const camera_id       = String(raw.deviceId || raw.camera_id || "UNKNOWN");
    const event_type_raw  = raw.type || raw.event_type || "unknown";
    const event_type      = mapEventType(event_type_raw);
    const timestamp_utc   = (raw.data && raw.data.startTimeUtc) || raw.timestamp_utc || new Date().toISOString();
    const client_id       = resolveClientId(raw.integration);
    const thumbnail_url   = (raw.data && raw.data.thumbnailUrl)   || null;
    const video_url       = (raw.data && raw.data.sharedVideoUrl) || null;
    const ist             = toIST(timestamp_utc);
    if (!ist) continue;

    const visitorTypes = ["person_detected", "vehicle_detected", "crowd_detected"];

    const event = {
      id:               `${camera_id}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      camera_id,
      camera_location:  raw.camera_location || `Camera ${camera_id}`,
      event_type,
      event_type_raw,
      visitor_count:    visitorTypes.includes(event_type) ? 1 : 0,
      confidence:       raw.confidence || null,
      client_id,
      thumbnail_url,
      video_url,
      metadata:         raw.data || {},
      timestamp_utc,
      timestamp_ist:    ist,
      received_at:      new Date().toISOString(),
      source_id:        raw.id || null,
    };

    eventStore.unshift(event);
    processed.push(event);
  }

  if (eventStore.length > MAX_EVENTS) eventStore = eventStore.slice(0, MAX_EVENTS);

  console.log(`[WEBHOOK] 3deye: ${processed.length} event(s) at ${new Date().toISOString()}`);
  return res.status(200).json({ received: processed.length, skipped: rawEvents.length - processed.length });
});

// ── API Key middleware for dashboard routes ──
function requireApiKey(req, res, next) {
  if (req.headers["x-api-key"] !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ─────────────────────────────────────────────────────
// GET /api/events
// ─────────────────────────────────────────────────────
app.get("/api/events", requireApiKey, (req, res) => {
  const { client_id, event_type, from, to, limit = 200 } = req.query;
  let filtered = eventStore;
  if (client_id) filtered = filtered.filter(e => e.client_id === client_id);
  if (event_type) filtered = filtered.filter(e => e.event_type === event_type);
  if (from) filtered = filtered.filter(e => new Date(e.timestamp_ist) >= new Date(from));
  if (to)   filtered = filtered.filter(e => new Date(e.timestamp_ist) <= new Date(to));
  return res.json({ total: filtered.length, events: filtered.slice(0, parseInt(limit)) });
});

// ─────────────────────────────────────────────────────
// GET /api/stats
// ─────────────────────────────────────────────────────
app.get("/api/stats", requireApiKey, (req, res) => {
  const { client_id } = req.query;
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0,0,0,0);
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate()-1);
  const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate()-7);

  let events = client_id ? eventStore.filter(e => e.client_id === client_id) : eventStore;
  const visitorTypes = ["person_detected","vehicle_detected","crowd_detected"];
  const vEvents = events.filter(e => visitorTypes.includes(e.event_type));

  const todayV     = vEvents.filter(e => new Date(e.timestamp_ist) >= todayStart).reduce((s,e) => s+e.visitor_count, 0);
  const yesterdayV = vEvents.filter(e => { const d=new Date(e.timestamp_ist); return d>=yesterdayStart&&d<todayStart; }).reduce((s,e) => s+e.visitor_count, 0);
  const weekV      = vEvents.filter(e => new Date(e.timestamp_ist) >= weekStart).reduce((s,e) => s+e.visitor_count, 0);

  // Camera activity
  const camMap = {};
  events.filter(e => new Date(e.timestamp_ist) >= weekStart).forEach(e => {
    if (!camMap[e.camera_id]) camMap[e.camera_id] = { camera_id:e.camera_id, location:e.camera_location, count:0 };
    camMap[e.camera_id].count++;
  });

  // Downtime
  const offlineEvts = events.filter(e => e.event_type==="camera_offline");
  const onlineEvts  = events.filter(e => e.event_type==="camera_online");
  const dtMap = {};
  offlineEvts.forEach(off => {
    if (!dtMap[off.camera_id]) dtMap[off.camera_id] = { camera_id:off.camera_id, location:off.camera_location, downtime_minutes:0, incidents:0 };
    const rec = onlineEvts.find(on => on.camera_id===off.camera_id && new Date(on.timestamp_ist)>new Date(off.timestamp_ist));
    dtMap[off.camera_id].downtime_minutes += rec ? (new Date(rec.timestamp_ist)-new Date(off.timestamp_ist))/60000 : 30;
    dtMap[off.camera_id].incidents++;
  });

  // Hourly trend
  const hourly = Array.from({length:18},(_,i) => {
    const h = i+5;
    return {
      hour: h, label: `${h}:00`,
      today:     vEvents.filter(e => { const d=new Date(e.timestamp_ist); return d>=todayStart&&d.getHours()===h; }).reduce((s,e)=>s+e.visitor_count,0),
      yesterday: vEvents.filter(e => { const d=new Date(e.timestamp_ist); return d>=yesterdayStart&&d<todayStart&&d.getHours()===h; }).reduce((s,e)=>s+e.visitor_count,0),
    };
  });

  // Weekly trend
  const weekly = Array.from({length:7},(_,i) => {
    const ds = new Date(todayStart); ds.setDate(ds.getDate()-(6-i));
    const de = new Date(ds); de.setDate(de.getDate()+1);
    return {
      date:  ds.toISOString().split("T")[0],
      label: ds.toLocaleDateString("en-IN",{weekday:"short",day:"numeric"}),
      visitors: vEvents.filter(e => { const d=new Date(e.timestamp_ist); return d>=ds&&d<de; }).reduce((s,e)=>s+e.visitor_count,0),
    };
  });

  return res.json({
    generated_at_ist: toIST(new Date().toISOString()),
    visitors: { today:todayV, yesterday:yesterdayV, week:weekV },
    camera_activity: Object.values(camMap).sort((a,b)=>b.count-a.count),
    downtime: Object.values(dtMap),
    trends: { hourly, weekly },
    total_events_stored: eventStore.length,
  });
});

// ─────────────────────────────────────────────────────
// GET /api/raw  — see last 5 raw events as received
// Useful for debugging 3deye payload mapping
// ─────────────────────────────────────────────────────
app.get("/api/raw", requireApiKey, (req, res) => {
  return res.json({ last_5_events: eventStore.slice(0,5) });
});

app.delete("/api/events", requireApiKey, (req, res) => {
  const count = eventStore.length; eventStore = [];
  return res.json({ cleared: count });
});

app.get("/health", (_, res) => res.json({
  status: "ok",
  events_stored: eventStore.length,
  time_ist: toIST(new Date().toISOString()),
  source: "3deye VMS"
}));

app.listen(PORT, () => {
  console.log(`SocietyGuard backend running on port ${PORT}`);
  console.log(`Accepting 3deye webhook payload format`);
});
