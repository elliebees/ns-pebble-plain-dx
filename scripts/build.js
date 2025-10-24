// Build a minimal, token-optional Nightscout /pebble HTML page
// Features: token support, timezone via /status.json (with override), units (mg/dL or mmol/L)

import fs from "node:fs/promises";

const NS = process.env.NIGHTSCOUT_URL;
const TOKEN = process.env.NIGHTSCOUT_TOKEN?.trim();
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

function isValidIanaTZ(tz) {
  try {
    if (typeof Intl.supportedValuesOf === "function") {
      return Intl.supportedValuesOf("timeZone").includes(tz);
    }
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch { return false; }
}

// Pull /status.json once (best effort) for timezone + unit
async function getStatus() {
  try {
    return await getJSON(statusURL);
  } catch {
    return null;
  }
}

function deriveTimezone(status) {
  // 1) explicit override
  const override = process.env.NIGHTSCOUT_TZ?.trim();
  if (override && isValidIanaTZ(override)) return override;

  // 2) from Nightscout status
  const tz = status?.settings?.timezone?.trim();
  if (tz && isValidIanaTZ(tz)) return tz;

  // 3) local or UTC
  const localTZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidIanaTZ(localTZ) ? localTZ : "UTC";
}

function deriveUnits(status) {
  // Nightscout typically reports "mg/dl" or "mmol" in settings.units (sometimes units_bg)
  const raw =
    status?.settings?.units ??
    status?.settings?.units_bg ??
    status?.units ??
    "mg/dl";
  const v = String(raw).toLowerCase();
  return v.includes("mmol") ? "mmol/L" : "mg/dL";
}

function formatBG(valueMgdl, units) {
  const n = Number(valueMgdl);
  if (!Number.isFinite(n)) return String(valueMgdl ?? "?");
  if (units === "mmol/L") return (n / MGDL_PER_MMOLL).toFixed(1);
  return String(Math.round(n)); // mg/dL as integer
}

function formatDelta(deltaStrOrNum, units) {
  if (deltaStrOrNum == null || deltaStrOrNum === "") return "";
  // Pebble often gives "+5" (string). Extract sign + number.
  const m = String(deltaStrOrNum).match(/^\s*([+-]?)(\d+(\.\d+)?)\s*$/);
  if (!m) return String(deltaStrOrNum); // if weird, just show as-is
  const sign = m[1] || "";
  const val = Number(m[2]);
  if (!Number.isFinite(val)) return String(deltaStrOrNum);

  if (units === "mmol/L") {
    const mmol = val / MGDL_PER_MMOLL;
    const s = (sign === "" ? (val >= 0 ? "+" : "") : sign);
    return `${s}${mmol.toFixed(1)}`;
  } else {
    // mg/dL integer delta
    const s = (sign === "" ? (val >= 0 ? "+" : "") : sign);
    return `${s}${Math.round(val)}`;
  }
}

try {
  const [data, status] = await Promise.all([getJSON(pebbleURL), getStatus()]);
  const tz = deriveTimezone(status);
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
