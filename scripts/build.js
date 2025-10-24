// Build a minimal, token-optional Nightscout /pebble HTML page
// Features: token support, timezone (override > /status.json > local), mmol support
// Includes DEBUG logs so you can see exactly what's happening in the Actions log.

import fs from "node:fs/promises";

const NS = process.env.NIGHTSCOUT_URL;
const TOKEN = process.env.NIGHTSCOUT_TOKEN?.trim();
const RAW_TZ = process.env.NIGHTSCOUT_TZ; // may be undefined
console.log("DEBUG NIGHTSCOUT_URL exists:", Boolean(NS));
console.log("DEBUG NIGHTSCOUT_TOKEN provided:", Boolean(TOKEN));
console.log("DEBUG NIGHTSCOUT_TZ (raw):", JSON.stringify(RAW_TZ));

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

// We trust override if present (avoids ICU/runner issues).
async function getTimezone() {
  const override = RAW_TZ?.trim();
  if (override) {
    console.log("DEBUG using TZ override:", override);
    return override;
  }

  try {
    const s = await getJSON(statusURL);
    const tzFromStatus = s?.settings?.timezone?.trim();
    console.log("DEBUG /status.json timezone:", tzFromStatus || "(none)");
    if (tzFromStatus) return tzFromStatus;
  } catch (e) {
    console.log("DEBUG fetching /status.json failed:", String(e?.message || e));
  }

  const localTZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  console.log("DEBUG fallback timezone:", localTZ);
  return localTZ;
}

async function getStatus() {
  try { return await getJSON(statusURL); }
  catch (e) {
    console.log("DEBUG /status.json fetch error:", String(e?.message || e));
    return null;
  }
}

function deriveUnits(status) {
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
  const [data, status, tz] = await Promise.all([getJSON(pebbleURL), getStatus(), getTimezone()]);

  const units = deriveUnits(status);

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

  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  });
  const stamp = fmt.format(now);

  const html = `<!doctype html>
<html>
<head>
<meta http-equiv="content-type" content="text/html; charset=utf-8">
<meta http-equiv="refresh" content="60">
<title>BG Simple</title>
</head>
<body>
<pre>
BG: <big>${sgvDisplay}</big> ${units} ${arrow} ${deltaDisplay}
Time: ${age}
Battery: ${battery}
Updated: ${stamp} (${tz})
</pre>
</body>
</html>`;

  await fs.writeFile("index.html", html, "utf8");
  console.log(`✅ Built index.html from ${pebbleURL} [${tz}] [${units}]`);
} catch (err) {
  const msg = String(err?.message || err);
  const fallback = `<!doctype html><meta charset="utf-8"><pre>Build error: ${msg}
Source: ${pebbleURL}
</pre>`;
  await fs.writeFile("index.html", fallback, "utf8");
  console.error("⚠️ Build failed:", msg);
  process.exitCode = 0;
}
