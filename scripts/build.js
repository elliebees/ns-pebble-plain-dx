// Build a minimal, token-optional Nightscout /pebble HTML page
// Features:
// - Read-only token support (optional)
// - Units auto-detect (mg/dL or mmol/L) via /status.json
// - Timezone: NIGHTSCOUT_TZ override > /status.json > runner local (UTC fallback)
// - Robust timezone formatting via moment-timezone (independent of runner ICU)
// - FORCE_MMOL=true to force mmol/L (for testing)
// - Cache-busting to avoid GitHub Pages / Opera Mini caching issues
// - Debug logs for transparency

import fs from "node:fs/promises";
import moment from "moment-timezone";

const NS = process.env.NIGHTSCOUT_URL;
const TOKEN = process.env.NIGHTSCOUT_TOKEN?.trim();
const RAW_TZ = process.env.NIGHTSCOUT_TZ;
const FORCE_MMOL = process.env.FORCE_MMOL?.trim()?.toLowerCase() === "true";

console.log("DEBUG NIGHTSCOUT_URL exists:", Boolean(NS));
console.log("DEBUG NIGHTSCOUT_TOKEN provided:", Boolean(TOKEN));
console.log("DEBUG NIGHTSCOUT_TZ (raw):", JSON.stringify(RAW_TZ));
console.log("DEBUG FORCE_MMOL (raw):", process.env.FORCE_MMOL, "→", FORCE_MMOL);

if (!NS) {
  console.error("❌ Missing NIGHTSCOUT_URL environment variable.");
  process.exit(1);
}

const NS_BASE = NS.replace(/\/+$/, "");
const pebbleURL = NS_BASE + "/pebble" + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");
const statusURL = NS_BASE + "/status.json" + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : "");
const MGDL_PER_MMOLL = 18.0182;

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function getStatus() {
  try { return await getJSON(statusURL); }
  catch (e) {
    console.log("DEBUG /status.json fetch error:", String(e?.message || e));
    return null;
  }
}

function deriveUnits(status) {
  if (FORCE_MMOL) {
    console.log("DEBUG forcing mmol/L via env var");
    return "mmol/L";
  }
  const raw =
    status?.settings?.units ??
    status?.settings?.units_bg ??
    status?.units ??
    "mg/dl";
  const v = String(raw).toLowerCase();
  const units = v.includes("mmol") ? "mmol/L" : "mg/dL";
  console.log("DEBUG units derived:", raw, "→", units);
  return units;
}

function resolveTimezone(status) {
  const override = RAW_TZ?.trim();
  if (override) {
    if (!moment.tz.zone(override)) {
      console.log("DEBUG WARNING: TZ override not found in moment DB:", override);
    } else {
      console.log("DEBUG using TZ override:", override);
    }
    return override;
  }

  const tzFromStatus = status?.settings?.timezone?.trim();
  if (tzFromStatus) {
    if (!moment.tz.zone(tzFromStatus)) {
      console.log("DEBUG WARNING: /status.json timezone not in moment DB:", tzFromStatus);
    } else {
      console.log("DEBUG using TZ from /status.json:", tzFromStatus);
    }
    return tzFromStatus;
  }

  const localTZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  if (!moment.tz.zone(localTZ)) {
    console.log("DEBUG WARNING: runner local TZ not in moment DB; using UTC:", localTZ);
    return "UTC";
  }
  console.log("DEBUG using runner local TZ:", localTZ);
  return localTZ;
}

function formatBG(valueMgdl, units) {
  const n = Number(valueMgdl);
  if (!Number.isFinite(n)) return String(valueMgdl ?? "?");
  if (units === "mmol/L") return (n / MGDL_PER_MMOLL).toFixed(1);
  return String(Math.round(n));
}

function formatDelta(deltaStrOrNum, units) {
  if (deltaStrOrNum == null || deltaStrOrNum === "") return "";
  const m = String(deltaStrOrNum).match(/^\s*([+-]?)(\d+(\.\d+)?)\s*$/);
  if (!m) return String(deltaStrOrNum);
  const sign = m[1] || (Number(m[2]) >= 0 ? "+" : "-");
  const val = Number(m[2]);
  if (!Number.isFinite(val)) return String(deltaStrOrNum);

  if (units === "mmol/L") {
    const mmol = val / MGDL_PER_MMOLL;
    return `${sign}${mmol.toFixed(1)}`;
  } else {
    return `${sign}${Math.round(val)}`;
  }
}

try {
  const [data, status] = await Promise.all([getJSON(pebbleURL), getStatus()]);

  const units = deriveUnits(status);
  const tz = resolveTimezone(status);

  const bg0 = (data?.bgs && data.bgs[0]) || {};
  const sgvRaw = bg0.sgv ?? "?";
  const deltaRaw = bg0.bgdelta ?? "";
  const trend = bg0.trend ?? bg0.direction;

  const tmap = {
    1: "↓", 2: "↘", 3: "→", 4: "↗", 5: "↑",
    DoubleDown: "↓↓", SingleDown: "↓", FortyFiveDown: "↘",
    Flat: "→", FortyFiveUp: "↗", SingleUp: "↑", DoubleUp: "↑↑"
  };
  const arrow = tmap[trend] || (typeof trend === "string" ? trend : "");

  const ts = Number(bg0.datetime ?? bg0.readingDate);
  let age = "?";
  if (!Number.isNaN(ts)) {
    const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
    age = `${mins}m ago`;
  }

  const sgvDisplay = formatBG(sgvRaw, units);
  const deltaDisplay = formatDelta(deltaRaw, units);
  const battery = data?.status?.device?.battery ?? data?.status?.battery ?? "?";

  const stamp = moment().tz(tz && moment.tz.zone(tz) ? tz : "UTC").format("YYYY-MM-DD HH:mm:ss z");

  // cache-busting every minute
  const cacheBust = Math.floor(Date.now() / 60000);

  const html = `<!doctype html>
<html>
<head>
<meta http-equiv="content-type" content="text/html; charset=utf-8">
<meta http-equiv="cache-control" content="no-cache, no-store, must-revalidate">
<meta http-equiv="pragma" content="no-cache">
<meta http-equiv="expires" content="0">
<meta http-equiv="refresh" content="60;url=./?r=${cacheBust}">
<title>BG Simple</title>
</head>
<body>
<pre>
BG: <big>${sgvDisplay}</big> ${units} ${arrow} ${deltaDisplay}
Time: ${age}
Battery: ${battery}
Updated: ${stamp} (${tz || "UTC"})
</pre>
</body>
</html>`;

  await fs.writeFile("index.html", html, "utf8");
  console.log(`✅ Built index.html from ${pebbleURL} [${tz || "UTC"}] [${units}]`);
} catch (err) {
  const msg = String(err?.message || err);
  const fallback = `<!doctype html><meta charset="utf-8"><pre>Build error: ${msg}
Source: ${pebbleURL}
</pre>`;
  await fs.writeFile("index.html", fallback, "utf8");
  console.error("⚠️ Build failed:", msg);
  process.exitCode = 0;
}
