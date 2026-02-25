/**
 * SocietyGuard - Webhook Receiver Backend
 * Deploy on Render / Railway / any Node.js host
 *
 * POST /webhook        → receives camera events from your analytics system
 * GET  /api/events     → dashboard fetches stored events
 * GET  /api/stats      → pre-aggregated stats for quick load
 * DELETE /api/events   → (superuser only) clear event log
 */

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Optional webhook secret (set in env vars on Render/Railway) ───
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || null;

// ─── In-memory store (replace with DB like Postgres/MongoDB for production) ───
let eventStore = [];
const MAX_EVENTS = 5000; // keep last 5000 events in memory

// ─── IST offset ───
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +5:30 in ms

function toIST(utcDateStr) {
  const d = new Date(utcDateStr);
  if (isNaN(d)) return null;
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString();
}

// ─── Middleware ───
app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "*", // Set to your Vercel URL in production
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "x-api-key", "x-webhook-signature"],
  })
);

// ─── Webhook signature verifier (HMAC-SHA256) ───
function verifySignature(req) {
  if (!WEBHOOK_SECRET) return true; // skip if not configured
  const sig = req.headers["x-webhook-signature"];
  if (!sig) return false;
  const expected = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(JSON.stringify(req.body))
    .digest("hex");
  return sig === `sha256=${expected}`;
}

// ─── API Key auth for dashboard reads ───
const API_KEY = process.env.API_KEY || "sg-dev-key-change-me";
function requireApiKey(req, res, next) {
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// ─────────────────────────────────────────────────────
// POST /webhook
// Called by your analytics system with camera event data
// ─────────────────────────────────────────────────────
app.post("/webhook", (req, res) => {
  // Verify signature if secret is set
  if (!verifySignature(req)) {
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  const payload = req.body;

  // Support single event or array of events
  const rawEvents = Array.isArray(payload) ? payload : [payload];
  const processed = [];

  for (const raw of rawEvents) {
    // Validate required fields
    if (!raw.camera_id || !raw.event_type || !raw.timestamp_utc) {
      continue; // skip malformed events silently
    }

    const istTimestamp = toIST(raw.timestamp_utc);
    if (!istTimestamp) continue;

    const event = {
      id: `${raw.camera_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      camera_id: raw.camera_id,
      camera_location: raw.camera_location || "Unknown",
      event_type: raw.event_type,                    // e.g. person_detected, camera_offline
      visitor_count: parseInt(raw.visitor_count) || 0,
      confidence: parseFloat(raw.confidence) || null,
      client_id: raw.client_id || "default",
      metadata: raw.metadata || {},
      timestamp_utc: raw.timestamp_utc,
      timestamp_ist: istTimestamp,
      received_at: new Date().toISOString(),
    };

    eventStore.unshift(event); // newest first
    processed.push(event);
  }

  // Trim store to MAX_EVENTS
  if (eventStore.length > MAX_EVENTS) {
    eventStore = eventStore.slice(0, MAX_EVENTS);
  }

  console.log(`[WEBHOOK] Received ${processed.length} event(s) at ${new Date().toISOString()}`);

  return res.status(200).json({
    received: processed.length,
    skipped: rawEvents.length - processed.length,
    timestamp_ist: toIST(new Date().toISOString()),
  });
});

// ─────────────────────────────────────────────────────
// GET /api/events
// Dashboard fetches events with optional filters
// Query params: client_id, event_type, from (ISO), to (ISO), limit
// ─────────────────────────────────────────────────────
app.get("/api/events", requireApiKey, (req, res) => {
  const { client_id, event_type, from, to, limit = 200 } = req.query;

  let filtered = eventStore;

  if (client_id) {
    filtered = filtered.filter((e) => e.client_id === client_id);
  }
  if (event_type) {
    filtered = filtered.filter((e) => e.event_type === event_type);
  }
  if (from) {
    const fromDate = new Date(from);
    filtered = filtered.filter((e) => new Date(e.timestamp_ist) >= fromDate);
  }
  if (to) {
    const toDate = new Date(to);
    filtered = filtered.filter((e) => new Date(e.timestamp_ist) <= toDate);
  }

  return res.json({
    total: filtered.length,
    events: filtered.slice(0, parseInt(limit)),
  });
});

// ─────────────────────────────────────────────────────
// GET /api/stats
// Pre-aggregated stats for the dashboard
// Query params: client_id
// ─────────────────────────────────────────────────────
app.get("/api/stats", requireApiKey, (req, res) => {
  const { client_id } = req.query;

  const now = new Date();
  // All times in IST
  const todayStart = new Date(now.toISOString());
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(weekStart.getDate() - 7);

  let events = eventStore;
  if (client_id) events = events.filter((e) => e.client_id === client_id);

  const visitorTypes = ["person_detected", "vehicle_detected", "crowd_detected"];
  const visitorEvents = events.filter((e) => visitorTypes.includes(e.event_type));

  // Today visitors
  const todayVisitors = visitorEvents
    .filter((e) => new Date(e.timestamp_ist) >= todayStart)
    .reduce((s, e) => s + e.visitor_count, 0);

  // Yesterday visitors
  const yesterdayVisitors = visitorEvents
    .filter((e) => {
      const d = new Date(e.timestamp_ist);
      return d >= yesterdayStart && d < todayStart;
    })
    .reduce((s, e) => s + e.visitor_count, 0);

  // Week visitors
  const weekVisitors = visitorEvents
    .filter((e) => new Date(e.timestamp_ist) >= weekStart)
    .reduce((s, e) => s + e.visitor_count, 0);

  // Camera event counts (last 7 days)
  const cameraMap = {};
  events
    .filter((e) => new Date(e.timestamp_ist) >= weekStart)
    .forEach((e) => {
      if (!cameraMap[e.camera_id]) {
        cameraMap[e.camera_id] = { camera_id: e.camera_id, location: e.camera_location, count: 0 };
      }
      cameraMap[e.camera_id].count++;
    });

  const cameraCounts = Object.values(cameraMap).sort((a, b) => b.count - a.count);

  // Downtime per camera
  const offlineEvents = events.filter((e) => e.event_type === "camera_offline");
  const onlineEvents = events.filter((e) => e.event_type === "camera_online");

  const downtimeMap = {};
  offlineEvents.forEach((off) => {
    if (!downtimeMap[off.camera_id]) {
      downtimeMap[off.camera_id] = { camera_id: off.camera_id, location: off.camera_location, downtime_minutes: 0, incidents: 0 };
    }
    const recovery = onlineEvents.find(
      (on) => on.camera_id === off.camera_id && new Date(on.timestamp_ist) > new Date(off.timestamp_ist)
    );
    const durationMs = recovery
      ? new Date(recovery.timestamp_ist) - new Date(off.timestamp_ist)
      : 30 * 60 * 1000; // assume 30 min if no recovery
    downtimeMap[off.camera_id].downtime_minutes += durationMs / 60000;
    downtimeMap[off.camera_id].incidents++;
  });

  // Hourly visitor trend (today vs yesterday)
  const hourlyTrend = Array.from({ length: 18 }, (_, i) => {
    const hour = i + 5; // 5am to 10pm IST
    return {
      hour,
      label: `${hour}:00`,
      today: visitorEvents
        .filter((e) => {
          const d = new Date(e.timestamp_ist);
          return d >= todayStart && d.getHours() === hour;
        })
        .reduce((s, e) => s + e.visitor_count, 0),
      yesterday: visitorEvents
        .filter((e) => {
          const d = new Date(e.timestamp_ist);
          return d >= yesterdayStart && d < todayStart && d.getHours() === hour;
        })
        .reduce((s, e) => s + e.visitor_count, 0),
    };
  });

  // Weekly trend (last 7 days)
  const weeklyTrend = Array.from({ length: 7 }, (_, i) => {
    const dayStart = new Date(todayStart);
    dayStart.setDate(dayStart.getDate() - (6 - i));
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    return {
      date: dayStart.toISOString().split("T")[0],
      label: dayStart.toLocaleDateString("en-IN", { weekday: "short", day: "numeric" }),
      visitors: visitorEvents
        .filter((e) => {
          const d = new Date(e.timestamp_ist);
          return d >= dayStart && d < dayEnd;
        })
        .reduce((s, e) => s + e.visitor_count, 0),
    };
  });

  return res.json({
    generated_at_ist: toIST(new Date().toISOString()),
    visitors: { today: todayVisitors, yesterday: yesterdayVisitors, week: weekVisitors },
    camera_activity: cameraCounts,
    downtime: Object.values(downtimeMap),
    trends: { hourly: hourlyTrend, weekly: weeklyTrend },
    total_events_stored: eventStore.length,
  });
});

// ─────────────────────────────────────────────────────
// DELETE /api/events  (superuser only via API key)
// ─────────────────────────────────────────────────────
app.delete("/api/events", requireApiKey, (req, res) => {
  const count = eventStore.length;
  eventStore = [];
  return res.json({ cleared: count });
});

// ─── Health check ───
app.get("/health", (_, res) => res.json({ status: "ok", events_stored: eventStore.length, time_ist: toIST(new Date().toISOString()) }));

app.listen(PORT, () => {
  console.log(`SocietyGuard backend running on port ${PORT}`);
  console.log(`Webhook endpoint: POST /webhook`);
  console.log(`API key required for /api/* routes`);
});
