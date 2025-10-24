// Build a minimal, token-optional Nightscout /pebble HTML page
// Usage: NIGHTSCOUT_URL="https://your-nightscout.app" [NIGHTSCOUT_TOKEN="abc123"] node scripts/build.js

import fs from "node:fs/promises";

const NS = process.env.NIGHTSCOUT_URL;
const TOKEN = process.env.NIGHTSCOUT_TOKEN?.trim();
if (!NS) {
  console.error("Missing NIGHTSCOUT_URL environment variable.");
  process.exit(1);
}

// Construct the URL safely and only append the token if provided
let src = NS.replace(/\/+$/, "") + "/pebble";
if (TOKEN) src += `?token=${encodeURIComponent(TOKEN)}`;

try {
  const r = await fetch(src, { headers: { "Accept": "application/json" } });
  if (!r.ok) throw new Error(`Upstream returned ${r.status} ${r.statusText}`);
  const data = await r.json();

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
  const stamp = new Date().toISOString().replace("T"," ").slice(0,19);

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
Updated: ${stamp}
</pre>
</body>
</html>`;

  await fs.writeFile("index.html", html, "utf8");
  console.log("✅ Built index.html from", src);
} catch (err) {
  const msg = String(err?.message || err);
  const fallback = `<!doctype html><meta charset="utf-8"><pre>Build error: ${msg}
Source: ${src}
</pre>`;
  await fs.writeFile("index.html", fallback, "utf8");
  console.error("⚠️ Build failed:", msg);
  process.exitCode = 0; // don’t break the GitHub Action
}
