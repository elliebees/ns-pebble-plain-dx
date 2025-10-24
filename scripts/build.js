// Build a minimal, token-optional Nightscout /pebble HTML page
// Adds timezone awareness by reading Nightscout's /status.json

import fs from "node:fs/promises";

const NS = process.env.NIGHTSCOUT_URL;
const TOKEN = process.env.NIGHTSCOUT_TOKEN?.trim();
if (!NS) {
  console.error("Missing NIGHTSCOUT_URL environment variable.");
  process.exit(1);
}

// Build /pebble URL (optionally with token)
let pebbleURL = NS.replace(/\/+$/, "") + "/pebble";
if (TOKEN) pebbleURL += `?token=${encodeURIComponent(TOKEN)}`;

// Helper to safely fetch JSON
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

// Determine Nightscout's timezone
async function getTimezone() {
  try {
    const statusURL = NS.replace(/\/+$/, "") + "/status.json";
    const s = await getJSON(statusURL);
    const tz = s?.settings?.timezone;
    if (tz && typeof tz === "string" && tz.trim()) return tz.trim();
  } catch {
    // ignore
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

try {
  const [data, tz] = await Promise.all([getJSON(pebbleURL), getTimezone()]);

  const bg0 = (data?.bgs && data.bgs[0]) || {};
  const sgv = bg0.sgv ?? "?";
  const delta = bg0.bgdelta ?? "";
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

  const battery = data?.status?.device?.battery ?? data?.status?.battery ?? "?";

  // Format updated time in Nightscout's timezone
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
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
BG: <big>${sgv}</big> ${arrow} ${delta}
Time: ${age}
Battery: ${battery}
Updated: ${stamp} (${tz})
</pre>
</body>
</html>`;

  await fs.writeFile("index.html", html, "utf8");
  console.log(`✅ Built index.html from ${pebbleURL} (${tz})`);
} catch (err) {
  const msg = String(err?.message || err);
  const fallback = `<!doctype html><meta charset="utf-8"><pre>Build error: ${msg}
Source: ${pebbleURL}
</pre>`;
  await fs.writeFile("index.html", fallback, "utf8");
  console.error("⚠️ Build failed:", msg);
  process.exitCode = 0;
}
