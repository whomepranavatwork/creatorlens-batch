"use strict";

const express = require("express");
const app     = express();
app.use(express.json({ limit: "10mb" }));

// ── Constants — Gemini model kept exactly as-is ──────────────────────────────
const APIFY        = "https://api.apify.com/v2";
const ACTOR        = "apify~instagram-profile-scraper";
const GEMINI_URL   = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent";
const PORT         = process.env.PORT || 3002;
const GEMINI_KEY   = process.env.GEMINI_API_KEY || "";

if (!GEMINI_KEY) {
  console.error("WARNING: GEMINI_API_KEY is not set.");
} else {
  console.log("GEMINI_API_KEY is set (" + GEMINI_KEY.slice(0, 12) + "...)");
}

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, geminiKeySet: !!GEMINI_KEY }));

// ── Single: start Apify run ───────────────────────────────────────────────────
app.post("/start", async (req, res) => {
  const { username, apifyKey } = req.body || {};
  if (!username || !apifyKey)
    return res.status(400).json({ error: "[start] username and apifyKey are required." });
  try {
    const r = await fetch(`${APIFY}/acts/${ACTOR}/runs?token=${apifyKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], resultsLimit: 30 }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = b?.error?.message || b?.message || JSON.stringify(b).slice(0, 300);
      return res.status(r.status).json({ error: "[start] Apify error " + r.status + ": " + msg });
    }
    const runId = b?.data?.id;
    const datasetId = b?.data?.defaultDatasetId;
    if (!runId) return res.status(500).json({ error: "[start] Apify returned no runId.", raw: JSON.stringify(b).slice(0, 300) });
    return res.json({ runId, datasetId });
  } catch (e) {
    return res.status(500).json({ error: "[start] " + e.message });
  }
});

// ── Batch: start up to 10 runs with staggered delays ─────────────────────────
app.post("/start-batch", async (req, res) => {
  const { usernames, apifyKey } = req.body || {};
  if (!Array.isArray(usernames) || !usernames.length || !apifyKey)
    return res.status(400).json({ error: "[start-batch] usernames array and apifyKey required." });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const results = [];

  for (let i = 0; i < Math.min(usernames.length, 10); i++) {
    const username = usernames[i].trim();
    if (!username) { results.push({ username, error: "Empty handle" }); continue; }
    try {
      const r = await fetch(`${APIFY}/acts/${ACTOR}/runs?token=${apifyKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [username], resultsLimit: 30 }),
      });
      const b = await r.json().catch(() => ({}));
      if (!r.ok) {
        const msg = b?.error?.message || b?.message || "";
        results.push({ username, error: "Apify error " + r.status + ": " + msg.slice(0, 100) });
      } else {
        results.push({ username, runId: b?.data?.id, datasetId: b?.data?.defaultDatasetId });
      }
    } catch (e) {
      results.push({ username, error: e.message });
    }
    // Stagger starts by 1.5s to avoid hitting Apify rate limits
    if (i < usernames.length - 1) await sleep(1500);
  }
  return res.json({ runs: results });
});

// ── Poll run status ───────────────────────────────────────────────────────────
app.get("/status/:runId", async (req, res) => {
  const { apifyKey } = req.query;
  if (!apifyKey) return res.status(400).json({ error: "[status] apifyKey required." });
  try {
    const r = await fetch(`${APIFY}/actor-runs/${req.params.runId}?token=${apifyKey}`);
    const b = await r.json().catch(() => ({}));
    return res.json({ status: b?.data?.status || "UNKNOWN" });
  } catch (e) {
    return res.status(500).json({ error: "[status] " + e.message });
  }
});

// ── Fetch + trim dataset ──────────────────────────────────────────────────────
app.get("/dataset/:datasetId", async (req, res) => {
  const { apifyKey } = req.query;
  if (!apifyKey) return res.status(400).json({ error: "[dataset] apifyKey required." });
  try {
    const r = await fetch(`${APIFY}/datasets/${req.params.datasetId}/items?token=${apifyKey}&format=json`);
    const items = await r.json().catch(() => null);
    if (!r.ok || !items) return res.status(r.status || 500).json({ error: "[dataset] fetch failed (" + r.status + ")." });
    if (!Array.isArray(items) || !items.length)
      return res.status(404).json({ error: "[dataset] No data. Account may be private or username wrong." });
    const trimmed = items.map(p => ({
      username:       p.username,
      fullName:       p.fullName || p.name,
      biography:      p.biography || p.bio,
      profilePicUrl:  p.profilePicUrl || p.profilePicUrlHD,
      isVerified:     p.isVerified,
      followersCount: p.followersCount,
      followsCount:   p.followsCount,
      postsCount:     p.postsCount || p.mediaCount,
      latestPosts: (p.latestPosts || p.topPosts || p.posts || []).map(x => ({
        timestamp:      x.timestamp,
        likesCount:     x.likesCount,
        commentsCount:  x.commentsCount,
        videoViewCount: x.videoViewCount || x.videoPlayCount || x.playCount,
        type:           x.type || x.productType,
        caption:        (x.caption || "").slice(0, 500),
        url:            x.url,
        shortCode:      x.shortCode,
      })),
    }));
    return res.json({ data: trimmed });
  } catch (e) {
    return res.status(500).json({ error: "[dataset] " + e.message });
  }
});

// ── Single analyze via Gemini ─────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "[analyze] prompt is required." });
  if (!GEMINI_KEY) return res.status(500).json({ error: "[analyze] GEMINI_API_KEY not set. Add in Railway Variables." });
  try {
    const r = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 4000 } }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: "[analyze] Gemini error " + r.status + ": " + (b?.error?.message || "").slice(0, 200) });
    const raw   = b.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    const text  = match ? match[0] : "{}";
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return res.status(500).json({ error: "[analyze] Gemini returned malformed JSON. Retry.", raw: text.slice(0, 400) }); }
    return res.json({ result: parsed });
  } catch (e) {
    return res.status(500).json({ error: "[analyze] " + e.message });
  }
});

// ── Batch analyze — one Gemini call for all creators ─────────────────────────
app.post("/analyze-batch", async (req, res) => {
  const { metricsArray } = req.body || {};
  if (!Array.isArray(metricsArray) || !metricsArray.length)
    return res.status(400).json({ error: "[analyze-batch] metricsArray required." });
  if (!GEMINI_KEY)
    return res.status(500).json({ error: "[analyze-batch] GEMINI_API_KEY not set. Add in Railway Variables." });

  // Build a comparative prompt
  const lines = [
    "You are a brand-side social media analyst vetting multiple Instagram creators for a men's health brand (Man Matters — hair loss, testosterone, fitness).",
    "",
    "Analyze ALL creators below and return a comparative ranking plus individual analysis for each.",
    "",
  ];

  metricsArray.forEach(function(m, idx) {
    lines.push("=== CREATOR " + (idx + 1) + ": @" + m.handle + " (" + m.name + ") ===");
    lines.push("FOLLOWERS: " + m.followers.toLocaleString() + " | AVG ER: " + m.avgER + "% | AVG REEL VIEWS: " + m.avgViews + " | VFR: " + m.vfr + "% | CADENCE: " + m.cadence);
    lines.push("FORMAT: " + m.fmt.reel.pct + "% Reels / " + m.fmt.carousel.pct + "% Carousels / " + m.fmt.static.pct + "% Static");
    lines.push("BIO: " + (m.bio || "N/A"));
    lines.push("TOP HOOKS:");
    (m.hooks || []).slice(0, 8).forEach(function(h, i) { lines.push("  " + (i + 1) + '. "' + h + '"'); });
    lines.push("");
  });

  lines.push("Return ONLY raw JSON (no markdown, no backticks). Schema:");
  lines.push('{"ranking":[{"rank":1,"handle":"username","score":8.5,"oneliner":"One sentence on fit","topStrength":"strongest point","topFlag":"biggest concern"}],"analyses":{"username":{"hookAnalysis":[{"rank":1,"hook":"text","type":"mistake_based","label":"Mistake-Based","strength":8,"why":"one sentence"}],"patterns":[{"name":"n","freq":4,"pct":40,"signature":"one sentence","examples":["a","b"]}],"themes":[{"name":"n","pct":35,"desc":"one sentence","keywords":["a","b"]}],"frameworks":[{"name":"n","usage":"~40%","structure":"1) step 2) step 3) step","example":"example"}],"generatedHooks":[{"hook":"text","type":"mistake_based","angle":"Hair loss","note":"one sentence"}],"flags":[{"flag":"n","severity":"high","implication":"one sentence"}],"verdict":{"score":7.5,"strengths":["a"],"concerns":["a"],"bestUse":"sentence","formats":["Reel"]}}}}');
  lines.push("ranking must have one entry per creator. analyses must have one key per handle.");
  lines.push("hookAnalysis=5, patterns=3-4, themes=3-5, frameworks=2-3, generatedHooks=10, flags=2-5 per creator.");
  lines.push("Hook types: curiosity_gap|contrarian|mistake_based|number_led|identity_trigger|pain_first|bold_promise|social_proof|transformation|question");

  const prompt = lines.join("\n");

  try {
    const r = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 8000 } }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: "[analyze-batch] Gemini error " + r.status + ": " + (b?.error?.message || "").slice(0, 200) });
    const raw   = b.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    const text  = match ? match[0] : "{}";
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return res.status(500).json({ error: "[analyze-batch] Gemini returned malformed JSON. Retry.", raw: text.slice(0, 400) }); }
    return res.json({ result: parsed });
  } catch (e) {
    return res.status(500).json({ error: "[analyze-batch] " + e.message });
  }
});

// ── Serve UI ──────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getHTML());
});

app.listen(PORT, () => console.log("CreatorLens Batch running on port " + PORT));

// ═════════════════════════════════════════════════════════════════════════════
// HTML BUILDER
// ═════════════════════════════════════════════════════════════════════════════
function getHTML() {
  var css = [
    "*{box-sizing:border-box;margin:0;padding:0}",
    // New light sage-green design system
    ":root{",
    "  --bg:#DFE8DC;",          // sage green background
    "  --dark-card:#0D0D1C;",   // near-black cards
    "  --light-card:#FFFFFF;",  // white cards
    "  --green:#5EE87A;",       // primary green accent
    "  --green-dark:#22C55E;",  // darker green for text
    "  --purple:#9B8BF4;",      // purple accent
    "  --purple-soft:#EDE9FE;", // light purple bg
    "  --text-d:#0D0D1C;",      // dark text (on light)
    "  --text-l:#F0F0F8;",      // light text (on dark)
    "  --muted-d:#5A6B58;",     // muted on light bg
    "  --muted-l:#8888AA;",     // muted on dark cards
    "  --border-d:#1E1E32;",    // border on dark cards
    "  --border-l:#D0D9CE;",    // border on light bg
    "  --red:#EF4444;",
    "  --amber:#F59E0B;",
    "}",
    "body{background:var(--bg);color:var(--text-d);font-family:'DM Sans',system-ui,sans-serif;min-height:100vh}",
    ".mono{font-family:'Space Mono',monospace}",
    // Dark card
    ".dk{background:var(--dark-card);border:1px solid var(--border-d);border-radius:20px;padding:20px;color:var(--text-l)}",
    // Light card
    ".lt{background:var(--light-card);border:1px solid var(--border-l);border-radius:20px;padding:20px;color:var(--text-d)}",
    // Green card
    ".gn{background:var(--green);border-radius:20px;padding:20px;color:var(--dark-card)}",
    // Purple card
    ".pu{background:var(--purple);border-radius:20px;padding:20px;color:#FFFFFF}",
    "input,textarea{background:rgba(255,255,255,0.6);border:1.5px solid var(--border-l);border-radius:10px;padding:11px 13px;color:var(--text-d);font-size:14px;outline:none;width:100%;transition:all .2s;font-family:inherit}",
    "input:focus,textarea:focus{border-color:var(--green-dark);background:#fff;box-shadow:0 0 0 3px rgba(94,232,122,0.15)}",
    "textarea{resize:vertical;min-height:60px}",
    "button{cursor:pointer;font-family:inherit;font-weight:700;border:none;border-radius:10px;transition:opacity .15s}",
    "button:hover{opacity:.88}",
    ".btn-green{background:var(--green);color:var(--dark-card);padding:13px 24px;font-size:14px;width:100%;border-radius:12px}",
    ".btn-dark{background:var(--dark-card);color:var(--text-l);padding:10px 20px;font-size:13px;border-radius:10px}",
    ".btn-ghost{background:rgba(255,255,255,0.5);border:1.5px solid var(--border-l);color:var(--muted-d);padding:7px 16px;font-size:12px;border-radius:8px}",
    ".btn-sm{background:var(--green);color:var(--dark-card);padding:8px 16px;font-size:13px;border-radius:8px}",
    // Tags
    ".tag{display:inline-flex;align-items:center;border-radius:6px;padding:2px 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-family:'Space Mono',monospace;white-space:nowrap}",
    // Screens
    ".scr{display:none}",
    ".grid{display:grid;gap:12px}",
    // Tabs
    ".tab-bar{display:flex;gap:4px;background:rgba(255,255,255,0.5);border-radius:12px;padding:4px}",
    ".tab{padding:9px 20px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;border:none;background:transparent;color:var(--muted-d);transition:all .2s}",
    ".tab.active{background:var(--dark-card);color:var(--text-l)}",
    // Progress row
    ".prog-row{display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:10px;background:rgba(255,255,255,0.5);margin-bottom:6px}",
    ".prog-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}",
    // Rank badge
    ".rank-badge{width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;flex-shrink:0}",
    // Bar track
    ".bar-track{height:6px;background:rgba(255,255,255,0.15);border-radius:3px}.bar-fill{height:100%;border-radius:3px}",
    ".bar-track-l{height:6px;background:var(--border-l);border-radius:3px}",
    // Spinner
    "@keyframes spin{to{transform:rotate(360deg)}}",
    "@keyframes pulse{0%,100%{opacity:.9}50%{opacity:.4}}",
    ".spinner{width:44px;height:44px;border-radius:50%;border:3px solid rgba(255,255,255,.15);border-top:3px solid var(--green);animation:spin .9s linear infinite;margin:0 auto 20px}",
    // Scrollbar
    "::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border-l);border-radius:3px}",
    // Collapsible
    ".collapsible{display:none}.collapsible.open{display:block}",
  ].join("\n");

  // ── Setup screen ────────────────────────────────────────────────────────────
  var setupHTML = [
    '<div id="s-setup" class="scr" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">',
    '  <div style="width:100%;max-width:520px">',

    // Header
    '    <div style="margin-bottom:28px">',
    '      <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px">',
    '        <div style="width:38px;height:38px;background:var(--dark-card);border-radius:10px;display:flex;align-items:center;justify-content:center">',
    '          <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><circle cx="10" cy="10" r="4" fill="#5EE87A"/><circle cx="10" cy="10" r="8" stroke="#5EE87A" stroke-width="1.5" fill="none"/></svg>',
    '        </div>',
    '        <span style="font-size:18px;font-weight:800;color:var(--text-d)">CreatorLens</span>',
    '        <span class="tag" style="background:var(--dark-card);color:var(--green);border:none">Batch</span>',
    '      </div>',
    '      <h1 style="font-size:34px;font-weight:800;line-height:1.1;letter-spacing:-.03em;margin-bottom:10px;color:var(--text-d)">',
    '        From handle<br>to hiring decision.',
    '      </h1>',
    '      <p style="color:var(--muted-d);font-size:13px;line-height:1.75">Vet up to 10 creators at once. Full scrape + AI analysis. Ranked comparison on one screen.</p>',
    '    </div>',

    // Mode tabs
    '    <div class="tab-bar" style="margin-bottom:16px">',
    '      <button class="tab active" id="tab-single" onclick="switchTab(\'single\')">Single Creator</button>',
    '      <button class="tab" id="tab-batch" onclick="switchTab(\'batch\')">Batch (up to 10)</button>',
    '    </div>',

    // Form card
    '    <div class="lt" style="padding:24px">',

    // Single mode
    '      <div id="mode-single">',
    '        <div style="margin-bottom:14px">',
    '          <label style="font-size:11px;font-weight:700;color:var(--muted-d);text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:6px">Instagram Handle or URL</label>',
    '          <input id="i-url" placeholder="@handle  or  instagram.com/username" autocomplete="off"/>',
    '        </div>',
    '        <div>',
    '          <label style="font-size:11px;font-weight:700;color:var(--muted-d);text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:6px">Apify API Key</label>',
    '          <input id="i-apify" type="password" placeholder="apify_api_xxxxxxxxxxxxxxxx" class="mono"/>',
    '          <p style="font-size:11px;color:var(--muted-d);margin-top:5px">Free key &#8594; <span style="color:var(--green-dark);font-weight:600">console.apify.com</span> &#8594; Settings &#8594; API tokens</p>',
    '        </div>',
    '      </div>',

    // Batch mode
    '      <div id="mode-batch" style="display:none">',
    '        <div style="margin-bottom:14px">',
    '          <label style="font-size:11px;font-weight:700;color:var(--muted-d);text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:6px">Apify API Key (shared for all)</label>',
    '          <input id="b-apify" type="password" placeholder="apify_api_xxxxxxxxxxxxxxxx" class="mono"/>',
    '        </div>',
    '        <label style="font-size:11px;font-weight:700;color:var(--muted-d);text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:8px">Instagram Handles (one per line, up to 10)</label>',
    '        <div id="batch-inputs">',
    '        </div>',
    '        <button onclick="addBatchRow()" style="background:transparent;border:1.5px dashed var(--border-l);color:var(--muted-d);padding:8px;width:100%;border-radius:10px;font-size:12px;font-weight:600;margin-top:6px">+ Add Creator</button>',
    '      </div>',

    // Error
    '      <div id="setup-err" style="display:none;background:#EF444412;border:1.5px solid #EF444440;border-radius:10px;padding:11px 14px;margin-top:14px">',
    '        <div style="font-size:11px;color:var(--red);font-weight:700;margin-bottom:3px">Error</div>',
    '        <div id="setup-err-msg" class="mono" style="font-size:12px;color:var(--red);line-height:1.6;word-break:break-all"></div>',
    '      </div>',

    '      <button class="btn-green" onclick="startAnalysis()" style="margin-top:18px" id="analyze-btn">Analyze &#8594;</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join("\n");

  // ── Loading screen ──────────────────────────────────────────────────────────
  var loadingHTML = [
    '<div id="s-loading" class="scr" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">',
    '  <div style="max-width:420px;width:100%">',
    '    <div class="dk" style="padding:32px;text-align:center">',
    '      <div class="spinner"></div>',
    '      <h2 style="font-size:20px;font-weight:800;margin-bottom:6px;color:var(--text-l)">Analyzing creators&#8230;</h2>',
    '      <p id="load-msg" class="mono" style="color:var(--muted-l);font-size:12px;margin-bottom:24px;animation:pulse 2s ease infinite;min-height:18px"></p>',
    '      <div id="batch-progress" style="text-align:left"></div>',
    '      <p style="color:var(--muted-l);font-size:11px;margin-top:20px">Apify scrape takes 30&#8211;90s per creator &middot; running in parallel</p>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join("\n");

  // ── Error screen ─────────────────────────────────────────────────────────────
  var errorHTML = [
    '<div id="s-error" class="scr" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">',
    '  <div style="max-width:500px;width:100%;text-align:center">',
    '    <div style="font-size:44px;margin-bottom:14px">&#9888;</div>',
    '    <h2 style="color:var(--red);font-size:22px;font-weight:800;margin-bottom:14px">Analysis Failed</h2>',
    '    <div class="lt" style="border-color:#EF444440;margin-bottom:16px;text-align:left">',
    '      <div style="font-size:11px;color:var(--red);font-weight:700;margin-bottom:6px;text-transform:uppercase">Error Detail</div>',
    '      <div id="err-msg" class="mono" style="font-size:12px;color:var(--red);line-height:1.7;word-break:break-all"></div>',
    '    </div>',
    '    <div class="lt" style="margin-bottom:20px;text-align:left">',
    '      <div style="font-size:11px;color:var(--muted-d);font-weight:700;margin-bottom:10px;text-transform:uppercase">Error Label Guide</div>',
    '      <div style="font-size:12px;color:var(--muted-d);line-height:1.9">',
    '        &middot; <b style="color:var(--text-d)">[start]</b> &#8212; Apify key wrong or account is private<br>',
    '        &middot; <b style="color:var(--text-d)">[status]</b> &#8212; Apify run failed, check console.apify.com<br>',
    '        &middot; <b style="color:var(--text-d)">[dataset]</b> &#8212; No posts found or account went private<br>',
    '        &middot; <b style="color:var(--text-d)">[analyze]</b> &#8212; GEMINI_API_KEY missing in Railway Variables',
    '      </div>',
    '    </div>',
    "    <button class=\"btn-dark\" onclick=\"showScreen('setup')\" style=\"width:auto;padding:12px 32px\">&#8592; Try Again</button>",
    '  </div>',
    '</div>',
  ].join("\n");

  // ── Report screen ─────────────────────────────────────────────────────────────
  var reportHTML = [
    '<div id="s-report" class="scr">',
    '  <!-- Sticky nav -->',
    '  <div style="background:rgba(223,232,220,0.85);backdrop-filter:blur(12px);border-bottom:1px solid var(--border-l);padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10">',
    '    <div style="display:flex;align-items:center;gap:8px">',
    '      <div style="width:26px;height:26px;background:var(--dark-card);border-radius:7px;display:flex;align-items:center;justify-content:center">',
    '        <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="3" fill="#5EE87A"/><circle cx="7" cy="7" r="6" stroke="#5EE87A" stroke-width="1" fill="none"/></svg>',
    '      </div>',
    '      <span style="font-weight:800;font-size:14px;color:var(--text-d)">CreatorLens</span>',
    '      <span style="color:var(--border-l)">/</span>',
    '      <span id="nav-h" style="color:var(--muted-d);font-size:13px"></span>',
    '    </div>',
    "    <button class=\"btn-ghost\" onclick=\"showScreen('setup')\">&#8592; New analysis</button>",
    '  </div>',
    '  <div style="max-width:960px;margin:0 auto;padding:28px 20px 60px" id="report"></div>',
    '</div>',
  ].join("\n");

  var clientJS = getClientJS();

  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8"/>',
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>',
    "<title>CreatorLens Batch</title>",
    '<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet"/>',
    "<style>" + css + "</style>",
    "</head>",
    "<body>",
    setupHTML,
    loadingHTML,
    errorHTML,
    reportHTML,
    "<script>" + clientJS + "</script>",
    "</body>",
    "</html>",
  ].join("\n");
}

// ═════════════════════════════════════════════════════════════════════════════
// CLIENT JS BUILDER — plain string concatenation, zero template literal issues
// ═════════════════════════════════════════════════════════════════════════════
function getClientJS() {
  var js = "";

  // ── Constants ────────────────────────────────────────────────────────────────
  js += "var HOOK_COL={curiosity_gap:'#6366F1',contrarian:'#EF4444',mistake_based:'#F59E0B',number_led:'#22C55E',identity_trigger:'#8B5CF6',pain_first:'#EC4899',bold_promise:'#14B8A6',social_proof:'#3B82F6',transformation:'#F97316',question:'#84CC16'};\n";
  js += "var SEV_COL={high:'#EF4444',medium:'#F59E0B',low:'#22C55E'};\n";
  js += "var TCOLS=['#5EE87A','#9B8BF4','#22C55E','#EC4899','#F97316'];\n";
  js += "var currentMode='single';\n";
  js += "var batchRowCount=0;\n";
  js += "function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}\n";

  // ── Screen manager ────────────────────────────────────────────────────────────
  js += "function showScreen(id){\n";
  js += "  ['setup','loading','error','report'].forEach(function(s){document.getElementById('s-'+s).style.display='none';});\n";
  js += "  var el=document.getElementById('s-'+id);\n";
  js += "  el.style.display=(id==='report')?'block':'flex';\n";
  js += "}\n";

  // ── Tab switch ────────────────────────────────────────────────────────────────
  js += "function switchTab(mode){\n";
  js += "  currentMode=mode;\n";
  js += "  document.getElementById('mode-single').style.display=mode==='single'?'block':'none';\n";
  js += "  document.getElementById('mode-batch').style.display=mode==='batch'?'block':'none';\n";
  js += "  document.getElementById('tab-single').className='tab'+(mode==='single'?' active':'');\n";
  js += "  document.getElementById('tab-batch').className='tab'+(mode==='batch'?' active':'');\n";
  js += "  document.getElementById('analyze-btn').textContent=mode==='batch'?'Analyze All Creators \u2192':'Analyze \u2192';\n";
  js += "  if(mode==='batch'&&batchRowCount===0){addBatchRow();addBatchRow();addBatchRow();}\n";
  js += "}\n";

  // ── Add batch row ─────────────────────────────────────────────────────────────
  js += "function addBatchRow(){\n";
  js += "  var container=document.getElementById('batch-inputs');\n";
  js += "  if(container.children.length>=10)return;\n";
  js += "  batchRowCount++;\n";
  js += "  var idx=batchRowCount;\n";
  js += "  var row=document.createElement('div');\n";
  js += "  row.style.cssText='display:flex;gap:8px;align-items:center;margin-bottom:6px';\n";
  js += "  row.innerHTML='<span style=\"width:20px;font-size:12px;font-weight:700;color:var(--muted-d);flex-shrink:0;text-align:right\">'+idx+'</span>'\n";
  js += "    +'<input class=\"batch-handle\" placeholder=\"@handle or URL\" autocomplete=\"off\" style=\"flex:1\"/>'\n";
  js += "    +'<button onclick=\"this.parentNode.remove()\" style=\"background:transparent;border:none;color:var(--muted-d);font-size:16px;padding:4px;line-height:1;border-radius:4px\">&#215;</button>';\n";
  js += "  container.appendChild(row);\n";
  js += "}\n";

  // ── Utilities ─────────────────────────────────────────────────────────────────
  js += "function parseUser(s){s=(s||'').trim();try{var u=new URL(s.startsWith('http')?s:'https://'+s);return u.pathname.split('/').filter(Boolean)[0]||'';}catch(e){return s.replace(/^@/,'').split(/[/?#]/)[0];}}\n";
  js += "function fmt(n){if(n==null||isNaN(n))return '0';if(n>=1e6)return (n/1e6).toFixed(1)+'M';if(n>=1e3)return (n/1e3).toFixed(1)+'K';return Math.round(n).toLocaleString();}\n";
  js += "function pType(t){t=(t||'').toLowerCase();if(t.includes('video')||t==='reel')return 'reel';if(t.includes('sidecar')||t.includes('album')||t==='carousel')return 'carousel';return 'static';}\n";
  js += "function gv(p){return p.videoViewCount||p.videoPlayCount||0;}\n";
  js += "function getER(p,F){return F?(((p.likesCount||0)+(p.commentsCount||0))/F)*100:0;}\n";
  js += "function getScore(p,F){var e=(p.likesCount||0)+(p.commentsCount||0)*3,v=gv(p),a=(Date.now()-+new Date(p.timestamp))/36e5,r=a<720?1:a<2160?.8:.6;return(F?(e/F)*100*r:0)+(F?(v/F)*20:0);}\n";
  js += "function mean(arr,fn){return arr.length?arr.reduce(function(s,x){return s+fn(x);},0)/arr.length:0;}\n";
  js += "function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}\n";
  js += "function tag(col,txt){return '<span class=\"tag\" style=\"background:'+col+'18;color:'+col+';border:1px solid '+col+'33\">'+txt+'</span>';}\n";

  // ── Build metrics ─────────────────────────────────────────────────────────────
  js += "function buildMetrics(raw){\n";
  js += "  if(!raw||!raw.length)throw new Error('[buildMetrics] Empty dataset.');\n";
  js += "  var p=raw[0];\n";
  // Guard: if the first item looks like a post not a profile, surface a clear error
  js += "  if(!p.username&&!p.followersCount&&(p.likesCount!=null||p.videoViewCount!=null)){\n";
  js += "    throw new Error('[buildMetrics] Apify returned post objects instead of profile data. Remove resultsType from the Apify call.');\n";
  js += "  }\n";
  js += "  var rawP=(p.latestPosts||p.topPosts||p.posts||[]).filter(function(x){return x&&x.timestamp;});\n";
  js += "  var F=p.followersCount||1,N=rawP.length||1;\n";
  js += "  var scored=rawP.map(function(x){return Object.assign({},x,{_v:gv(x),_sc:getScore(x,F),_er:getER(x,F),_type:pType(x.type),_hook:((x.caption||'').split('\\n')[0]||'').trim().slice(0,200),_url:x.url||(x.shortCode?'https://instagram.com/p/'+x.shortCode:'#')});}).sort(function(a,b){return b._sc-a._sc;});\n";
  js += "  var rl=scored.filter(function(x){return x._type==='reel';}),ca=scored.filter(function(x){return x._type==='carousel';}),st=scored.filter(function(x){return x._type==='static';});\n";
  js += "  var avgV=mean(rl,function(x){return x._v;}),avgER=mean(scored,function(x){return x._er;});\n";
  js += "  var ts=rawP.map(function(x){return +new Date(x.timestamp);}).filter(Boolean).sort(function(a,b){return b-a;});\n";
  js += "  var span=ts.length>=2?(ts[0]-ts[ts.length-1])/864e5:7;\n";
  js += "  return{handle:p.username||'unknown',name:p.fullName||p.username||'',bio:p.biography||'',pic:p.profilePicUrl||'',verified:!!p.isVerified,followers:F,avgER:avgER.toFixed(2),avgViews:Math.round(avgV),vfr:((avgV/F)*100).toFixed(1),cadence:((N/Math.max(span,1))*7).toFixed(1)+'/wk',total:N,top5:scored.slice(0,5),hooks:scored.map(function(x){return x._hook;}).filter(Boolean).slice(0,20),fmt:{reel:{pct:Math.round(rl.length/N*100),avgViews:Math.round(avgV),avgER:mean(rl,function(x){return x._er;}).toFixed(2)},carousel:{pct:Math.round(ca.length/N*100),avgER:mean(ca,function(x){return x._er;}).toFixed(2)},static:{pct:Math.round(st.length/N*100),avgER:mean(st,function(x){return x._er;}).toFixed(2)}}};\n";
  js += "}\n";

  // ── Build single prompt ───────────────────────────────────────────────────────
  js += "function buildPrompt(m){\n";
  js += "  var lines=['You are a brand-side social media analyst vetting Instagram creators for a men\\'s health brand (Man Matters - hair loss, testosterone, fitness).','','CREATOR: @'+m.handle+' ('+m.name+')'+(m.verified?' verified':''),'BIO: '+(m.bio||'N/A'),'FOLLOWERS: '+m.followers.toLocaleString()+' | AVG ER: '+m.avgER+'% | AVG REEL VIEWS: '+fmt(m.avgViews)+' | VFR: '+m.vfr+'% | CADENCE: '+m.cadence,'FORMAT: '+m.fmt.reel.pct+'% Reels / '+m.fmt.carousel.pct+'% Carousels / '+m.fmt.static.pct+'% Static | POSTS: '+m.total,'','TOP 5 POSTS:'];\n";
  js += "  m.top5.forEach(function(p,i){lines.push((i+1)+'. ['+p._type.toUpperCase()+'] ER:'+p._er.toFixed(2)+'% Views:'+fmt(p._v)+' Likes:'+fmt(p.likesCount)+' Hook: \"'+p._hook+'\"');});\n";
  js += "  lines.push('','ALL CAPTION HOOKS:');\n";
  js += "  m.hooks.forEach(function(h,i){lines.push((i+1)+'. \"'+h+'\"');});\n";
  js += "  lines.push('','Return ONLY raw JSON (no markdown, no backticks):');\n";
  js += "  lines.push('{\"hookAnalysis\":[{\"rank\":1,\"hook\":\"text\",\"type\":\"mistake_based\",\"label\":\"Mistake-Based\",\"strength\":8,\"why\":\"one sentence\"}],\"patterns\":[{\"name\":\"n\",\"freq\":4,\"pct\":40,\"signature\":\"one sentence\",\"examples\":[\"a\",\"b\"]}],\"themes\":[{\"name\":\"n\",\"pct\":35,\"desc\":\"one sentence\",\"keywords\":[\"a\",\"b\"]}],\"frameworks\":[{\"name\":\"n\",\"usage\":\"~40%\",\"structure\":\"1) step 2) step 3) step\",\"example\":\"example\"}],\"generatedHooks\":[{\"hook\":\"text\",\"type\":\"mistake_based\",\"angle\":\"Hair loss\",\"note\":\"one sentence\"}],\"flags\":[{\"flag\":\"n\",\"severity\":\"high\",\"implication\":\"one sentence\"}],\"verdict\":{\"score\":7.5,\"strengths\":[\"a\"],\"concerns\":[\"a\"],\"bestUse\":\"sentence\",\"formats\":[\"Reel\"]}}');\n";
  js += "  lines.push('Counts: hookAnalysis=5,patterns=3-4,themes=3-5,frameworks=2-3,generatedHooks=10,flags=2-5. Types: curiosity_gap|contrarian|mistake_based|number_led|identity_trigger|pain_first|bold_promise|social_proof|transformation|question');\n";
  js += "  return lines.join('\\n');\n";
  js += "}\n";

  // ── SINGLE FLOW ───────────────────────────────────────────────────────────────
  js += "async function runSingle(username,apifyKey){\n";
  js += "  setBatchProgress([{username:username,status:'running',elapsed:0}]);\n";
  js += "  var sr=await fetch('/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username,apifyKey:apifyKey})});\n";
  js += "  var sb=await sr.json();\n";
  js += "  if(!sr.ok)throw new Error(sb.error||'Start failed');\n";
  js += "  var runId=sb.runId,datasetId=sb.datasetId;\n";
  js += "  var status='RUNNING',elapsed=0;\n";
  js += "  while(['STARTING','READY','RUNNING','ABORTING'].indexOf(status)!==-1){\n";
  js += "    await sleep(5000);elapsed+=5;\n";
  js += "    document.getElementById('load-msg').textContent='Scraping @'+username+'... ('+elapsed+'s)';\n";
  js += "    setBatchProgress([{username:username,status:'running',elapsed:elapsed}]);\n";
  js += "    var pr=await fetch('/status/'+runId+'?apifyKey='+encodeURIComponent(apifyKey));\n";
  js += "    var pb=await pr.json();status=pb.status||'UNKNOWN';\n";
  js += "    if(['FAILED','ABORTED','TIMED-OUT'].indexOf(status)!==-1)throw new Error('[status] Apify run: '+status+'. Check console.apify.com.');\n";
  js += "    if(elapsed>180)throw new Error('[status] Scrape timed out.');\n";
  js += "  }\n";
  js += "  setBatchProgress([{username:username,status:'done',elapsed:elapsed}]);\n";
  js += "  document.getElementById('load-msg').textContent='Fetching data...';\n";
  js += "  var dr=await fetch('/dataset/'+datasetId+'?apifyKey='+encodeURIComponent(apifyKey));\n";
  js += "  var db=await dr.json();\n";
  js += "  if(!dr.ok)throw new Error(db.error||'Dataset failed');\n";
  js += "  if(!Array.isArray(db.data)||!db.data.length)throw new Error('[dataset] No posts. Account may be private.');\n";
  js += "  document.getElementById('load-msg').textContent='Calculating metrics...';\n";
  js += "  var d=buildMetrics(db.data);\n";
  js += "  document.getElementById('load-msg').textContent='Running AI analysis...';\n";
  js += "  var ar=await fetch('/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:buildPrompt(d)})});\n";
  js += "  var ab=await ar.json();\n";
  js += "  if(!ar.ok)throw new Error(ab.error||'AI failed');\n";
  js += "  return{d:d,ai:ab.result};\n";
  js += "}\n";

  // ── BATCH FLOW ────────────────────────────────────────────────────────────────
  js += "async function runBatch(usernames,apifyKey){\n";
  // Start all runs
  js += "  document.getElementById('load-msg').textContent='Starting '+usernames.length+' Apify runs (staggered)...';\n";
  js += "  var startRes=await fetch('/start-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({usernames:usernames,apifyKey:apifyKey})});\n";
  js += "  var startBody=await startRes.json();\n";
  js += "  if(!startRes.ok)throw new Error(startBody.error||'Batch start failed');\n";
  js += "  var runs=startBody.runs;\n"; // [{username, runId, datasetId} or {username, error}]
  // Track progress state
  js += "  var progressState=runs.map(function(r){return{username:r.username,status:r.error?'error':'running',elapsed:0,error:r.error||null};});\n";
  js += "  setBatchProgress(progressState);\n";
  // Poll all runs in parallel
  js += "  var pending=runs.filter(function(r){return r.runId;});\n";
  js += "  var elapsed=0;\n";
  js += "  while(pending.length>0){\n";
  js += "    await sleep(5000);elapsed+=5;\n";
  js += "    document.getElementById('load-msg').textContent='Scraping... ('+elapsed+'s) \u2014 '+pending.length+' still running';\n";
  js += "    var stillPending=[];\n";
  js += "    for(var i=0;i<pending.length;i++){\n";
  js += "      var run=pending[i];\n";
  js += "      var pr=await fetch('/status/'+run.runId+'?apifyKey='+encodeURIComponent(apifyKey));\n";
  js += "      var pb=await pr.json();\n";
  js += "      var s=pb.status||'UNKNOWN';\n";
  js += "      var psi=progressState.findIndex(function(p){return p.username===run.username;});\n";
  js += "      if(psi!==-1)progressState[psi].elapsed=elapsed;\n";
  js += "      if(['FAILED','ABORTED','TIMED-OUT'].indexOf(s)!==-1){\n";
  js += "        if(psi!==-1){progressState[psi].status='error';progressState[psi].error=s;}\n";
  js += "      } else if(['RUNNING','READY','STARTING','ABORTING'].indexOf(s)!==-1){\n";
  js += "        stillPending.push(run);\n";
  js += "      } else {\n"; // SUCCEEDED
  js += "        if(psi!==-1)progressState[psi].status='done';\n";
  js += "      }\n";
  js += "    }\n";
  js += "    pending=stillPending;\n";
  js += "    setBatchProgress(progressState);\n";
  js += "    if(elapsed>180)break;\n";
  js += "  }\n";
  // Fetch datasets for all succeeded runs
  js += "  document.getElementById('load-msg').textContent='Fetching scraped data...';\n";
  js += "  var metricsArray=[];\n";
  js += "  for(var i=0;i<runs.length;i++){\n";
  js += "    var run=runs[i];\n";
  js += "    if(!run.datasetId)continue;\n";
  js += "    var psi=progressState.findIndex(function(p){return p.username===run.username;});\n";
  js += "    if(psi!==-1&&progressState[psi].status==='error')continue;\n";
  js += "    try{\n";
  js += "      var dr=await fetch('/dataset/'+run.datasetId+'?apifyKey='+encodeURIComponent(apifyKey));\n";
  js += "      var db=await dr.json();\n";
  js += "      if(dr.ok&&Array.isArray(db.data)&&db.data.length){metricsArray.push(buildMetrics(db.data));}\n";
  js += "      else if(psi!==-1){progressState[psi].status='error';progressState[psi].error='No data returned';}\n";
  js += "    }catch(e){\n";
  js += "      if(psi!==-1){progressState[psi].status='error';progressState[psi].error=e.message;}\n";
  js += "    }\n";
  js += "  }\n";
  js += "  if(!metricsArray.length)throw new Error('No valid data returned for any creator. Check handles and account privacy.');\n";
  // AI batch analysis
  js += "  document.getElementById('load-msg').textContent='Running AI comparative analysis...';\n";
  js += "  var ar=await fetch('/analyze-batch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({metricsArray:metricsArray})});\n";
  js += "  var ab=await ar.json();\n";
  js += "  if(!ar.ok)throw new Error(ab.error||'AI batch analysis failed');\n";
  js += "  return{metricsArray:metricsArray,batchResult:ab.result};\n";
  js += "}\n";

  // ── Progress display ──────────────────────────────────────────────────────────
  js += "function setBatchProgress(progressState){\n";
  js += "  var container=document.getElementById('batch-progress');\n";
  js += "  var h='';\n";
  js += "  for(var i=0;i<progressState.length;i++){\n";
  js += "    var p=progressState[i];\n";
  js += "    var col=p.status==='done'?'#5EE87A':p.status==='error'?'#EF4444':'#F59E0B';\n";
  js += "    var label=p.status==='done'?'Done':p.status==='error'?(p.error||'Error'):'Scraping ('+p.elapsed+'s)';\n";
  js += "    h+='<div class=\"prog-row\"><div class=\"prog-dot\" style=\"background:'+col+'\"></div>';\n";
  js += "    h+='<span style=\"font-size:13px;color:var(--text-l);font-weight:600;flex:1\">@'+esc(p.username)+'</span>';\n";
  js += "    h+='<span style=\"font-size:11px;color:var(--muted-l)\">'+label+'</span></div>';\n";
  js += "  }\n";
  js += "  container.innerHTML=h;\n";
  js += "}\n";

  // ── Main entry point ──────────────────────────────────────────────────────────
  js += "async function startAnalysis(){\n";
  js += "  var errEl=document.getElementById('setup-err'),errMsg=document.getElementById('setup-err-msg');\n";
  js += "  errEl.style.display='none';\n";
  js += "  var showErr=function(m){errMsg.textContent=m;errEl.style.display='block';};\n";

  js += "  if(currentMode==='single'){\n";
  js += "    var url=document.getElementById('i-url').value.trim();\n";
  js += "    var apifyKey=document.getElementById('i-apify').value.trim();\n";
  js += "    var username=parseUser(url);\n";
  js += "    if(!username)return showErr('Enter a valid Instagram URL or @handle.');\n";
  js += "    if(!apifyKey)return showErr('Apify API key is required.');\n";
  js += "    showScreen('loading');\n";
  js += "    try{\n";
  js += "      var result=await runSingle(username,apifyKey);\n";
  js += "      document.getElementById('load-msg').textContent='Building report...';\n";
  js += "      await sleep(200);\n";
  js += "      renderSingleReport(result.d,result.ai);\n";
  js += "      showScreen('report');\n";
  js += "    }catch(e){\n";
  js += "      document.getElementById('err-msg').textContent=e.message||String(e);\n";
  js += "      showScreen('error');\n";
  js += "    }\n";
  js += "  } else {\n";
  // Batch mode
  js += "    var apifyKey=document.getElementById('b-apify').value.trim();\n";
  js += "    if(!apifyKey)return showErr('Apify API key is required.');\n";
  js += "    var handleInputs=document.querySelectorAll('.batch-handle');\n";
  js += "    var usernames=[];\n";
  js += "    for(var i=0;i<handleInputs.length;i++){var u=parseUser(handleInputs[i].value);if(u)usernames.push(u);}\n";
  js += "    if(usernames.length<2)return showErr('Enter at least 2 handles for batch mode.');\n";
  js += "    showScreen('loading');\n";
  js += "    try{\n";
  js += "      var result=await runBatch(usernames,apifyKey);\n";
  js += "      document.getElementById('load-msg').textContent='Building comparison report...';\n";
  js += "      await sleep(200);\n";
  js += "      renderBatchReport(result.metricsArray,result.batchResult);\n";
  js += "      showScreen('report');\n";
  js += "    }catch(e){\n";
  js += "      document.getElementById('err-msg').textContent=e.message||String(e);\n";
  js += "      showScreen('error');\n";
  js += "    }\n";
  js += "  }\n";
  js += "}\n";

  // ── Section header helper ─────────────────────────────────────────────────────
  js += "function sh(lbl,dark){\n";
  js += "  var col=dark?'var(--green)':'var(--green-dark)';\n";
  js += "  var tc=dark?'var(--muted-l)':'var(--muted-d)';\n";
  js += "  return '<div style=\"display:flex;align-items:center;gap:8px;margin-bottom:14px\"><div style=\"width:3px;height:16px;background:'+col+';border-radius:2px\"></div><span style=\"font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:'+tc+'\">'+lbl+'</span></div>';\n";
  js += "}\n";

  // ── Stat card helpers (dark and light variants) ───────────────────────────────
  js += "function dkStatCard(l,v,sub,col){\n";
  js += "  col=col||'#5EE87A';\n";
  js += "  return '<div class=\"dk\" style=\"flex:1;min-width:110px\">'\n";
  js += "    +'<div style=\"font-size:10px;font-weight:700;color:var(--muted-l);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px\">'+l+'</div>'\n";
  js += "    +'<div class=\"mono\" style=\"font-size:22px;color:'+col+';font-weight:700;line-height:1.1\">'+v+'</div>'\n";
  js += "    +(sub?'<div style=\"font-size:11px;color:var(--muted-l);margin-top:3px\">'+sub+'</div>':'')\n";
  js += "    +'</div>';\n";
  js += "}\n";

  js += "function ltStatCard(l,v,sub,col){\n";
  js += "  col=col||'var(--text-d)';\n";
  js += "  return '<div class=\"lt\" style=\"flex:1;min-width:110px\">'\n";
  js += "    +'<div style=\"font-size:10px;font-weight:700;color:var(--muted-d);text-transform:uppercase;letter-spacing:.1em;margin-bottom:6px\">'+l+'</div>'\n";
  js += "    +'<div class=\"mono\" style=\"font-size:22px;color:'+col+';font-weight:700;line-height:1.1\">'+v+'</div>'\n";
  js += "    +(sub?'<div style=\"font-size:11px;color:var(--muted-d);margin-top:3px\">'+sub+'</div>':'')\n";
  js += "    +'</div>';\n";
  js += "}\n";

  // ── SVG gauge for brand fit score ─────────────────────────────────────────────
  js += "function gauge(score){\n";
  js += "  var pct=Math.min(Math.max(score/10,0),1);\n";
  js += "  var angle=pct*180;\n";
  js += "  var rad=(180-angle)*Math.PI/180;\n";
  js += "  var cx=80,cy=80,r=60;\n";
  js += "  var ex=cx+r*Math.cos(rad),ey=cy-r*Math.sin(rad);\n";
  js += "  var col=score>=7?'#5EE87A':score>=5?'#F59E0B':'#EF4444';\n";
  js += "  return '<svg width=\"160\" height=\"100\" viewBox=\"0 0 160 100\">'\n";
  js += "    +'<path d=\"M20,80 A60,60 0 0,1 140,80\" stroke=\"rgba(255,255,255,0.1)\" stroke-width=\"10\" fill=\"none\" stroke-linecap=\"round\"/>'\n";
  js += "    +'<path d=\"M20,80 A60,60 0 0,1 '+ex.toFixed(1)+','+ey.toFixed(1)+'\" stroke=\"'+col+'\" stroke-width=\"10\" fill=\"none\" stroke-linecap=\"round\"/>'\n";
  js += "    +'<circle cx=\"'+ex.toFixed(1)+'\" cy=\"'+ey.toFixed(1)+'\" r=\"5\" fill=\"'+col+'\"/>'\n";
  js += "    +'<text x=\"80\" y=\"75\" text-anchor=\"middle\" font-size=\"28\" font-weight=\"800\" fill=\"'+col+'\" font-family=\"Space Mono,monospace\">'+score+'</text>'\n";
  js += "    +'<text x=\"80\" y=\"92\" text-anchor=\"middle\" font-size=\"10\" fill=\"rgba(255,255,255,0.4)\" font-family=\"DM Sans,sans-serif\">BRAND FIT /10</text>'\n";
  js += "    +'</svg>';\n";
  js += "}\n";

  // ── Horizontal bar (dark card version) ───────────────────────────────────────
  js += "function dkBar(lbl,pct,col,right){\n";
  js += "  return '<div style=\"margin-bottom:14px\">'\n";
  js += "    +'<div style=\"display:flex;justify-content:space-between;margin-bottom:5px\"><span style=\"font-size:12px;color:var(--text-l)\">'+lbl+'</span><span class=\"mono\" style=\"font-size:11px;color:var(--muted-l)\">'+right+'</span></div>'\n";
  js += "    +'<div class=\"bar-track\"><div class=\"bar-fill\" style=\"width:'+Math.min(pct,100)+'%;background:'+col+'\"></div></div>'\n";
  js += "    +'<div style=\"font-size:10px;color:var(--muted-l);margin-top:2px\">'+pct+'% of content</div></div>';\n";
  js += "}\n";


  // ── SHARED CREATOR BODY ───────────────────────────────────────────────────────
  // Returns HTML for ALL sections of one creator. Used by both single + batch.
  // ai may be null or partially empty — every block guards defensively.
  js += "function renderCreatorBody(d,ai){\n";
  js += "  var h='';\n";
  js += "  var sc=(ai&&ai.verdict&&ai.verdict.score)||0;\n";
  js += "  var aiOk=!!(ai&&(ai.hookAnalysis||ai.patterns||ai.themes||ai.generatedHooks));\n";

  // Warning banner if AI data is missing
  js += "  if(!aiOk){\n";
  js += "    h+='<div style=\"background:#F59E0B18;border:1px solid #F59E0B44;border-radius:10px;padding:12px 16px;margin-bottom:14px;font-size:12px;color:#F59E0B\">&#9888; AI analysis returned no sections. Check GEMINI_API_KEY in Railway Variables and retry.</div>';\n";
  js += "  }\n";

  // Stats + gauge row
  js += "  h+='<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px\">';\n";
  js += "  h+='<div style=\"display:flex;flex-wrap:wrap;gap:10px\">';\n";
  js += "  h+=dkStatCard('Followers',fmt(d.followers));\n";
  js += "  h+=dkStatCard('Avg ER',d.avgER+'%',d.avgER>=3?'Strong':d.avgER>=1.5?'Average':'Weak',d.avgER>=3?'#5EE87A':d.avgER>=1.5?'#F59E0B':'#EF4444');\n";
  js += "  h+=dkStatCard('Reel Views',fmt(d.avgViews));\n";
  js += "  h+=dkStatCard('VFR',d.vfr+'%',d.vfr>=30?'Excellent':d.vfr>=10?'Good':'Weak',d.vfr>=30?'#5EE87A':d.vfr>=10?'#F59E0B':'#EF4444');\n";
  js += "  h+=dkStatCard('Cadence',d.cadence,d.total+' posts');\n";
  js += "  h+='</div>';\n";
  js += "  h+='<div class=\"dk\" style=\"display:flex;flex-direction:column;align-items:center;justify-content:center\">';\n";
  js += "  h+=gauge(sc);\n";
  js += "  if(ai&&ai.verdict&&ai.verdict.bestUse)h+='<div style=\"font-size:11px;color:var(--muted-l);text-align:center;margin-top:8px;line-height:1.5;max-width:160px\">'+esc(ai.verdict.bestUse)+'</div>';\n";
  js += "  h+='</div>';\n";
  js += "  h+='</div>';\n";

  // Format performance
  js += "  h+='<div class=\"dk\" style=\"margin-bottom:12px\">';\n";
  js += "  h+=sh('Format Performance',true);\n";
  js += "  h+=dkBar('Reels',d.fmt.reel.pct,'#5EE87A',fmt(d.fmt.reel.avgViews)+' avg views &middot; '+d.fmt.reel.avgER+'% ER');\n";
  js += "  h+=dkBar('Carousels',d.fmt.carousel.pct,'#9B8BF4',d.fmt.carousel.avgER+'% avg ER');\n";
  js += "  h+=dkBar('Static',d.fmt.static.pct,'rgba(255,255,255,0.2)',d.fmt.static.avgER+'% avg ER');\n";
  js += "  h+='</div>';\n";

  // Top 5 posts
  js += "  h+='<div style=\"margin-bottom:12px\">';\n";
  js += "  h+=sh('Top 5 Posts by Performance',false);\n";
  js += "  if(d.top5&&d.top5.length){\n";
  js += "    d.top5.forEach(function(p,i){\n";
  js += "      var hi=ai&&ai.hookAnalysis?ai.hookAnalysis.find(function(x){return x.rank===i+1;}):null;\n";
  js += "      var tc=p._type==='reel'?'#22C55E':p._type==='carousel'?'#9B8BF4':'#94A3B8';\n";
  js += "      h+='<div class=\"lt\" style=\"display:flex;gap:12px;margin-bottom:8px\">';\n";
  js += "      h+='<div style=\"font-size:'+(i===0?'24':'18')+'px;font-weight:800;color:'+(i===0?'#22C55E':'var(--muted-d)')+';flex-shrink:0;width:28px;line-height:1.2;padding-top:2px\">'+(i+1)+'</div>';\n";
  js += "      h+='<div style=\"flex:1;min-width:0\">';\n";
  js += "      h+='<div style=\"display:flex;flex-wrap:wrap;gap:5px;margin-bottom:7px\">';\n";
  js += "      h+=tag(tc,p._type);\n";
  js += "      if(hi){h+=tag(HOOK_COL[hi.type]||'#F59E0B',hi.label);h+=tag('#14B8A6',hi.strength+'/10 hook');}\n";
  js += "      h+=tag('#22C55E',p._er.toFixed(2)+'% ER');\n";
  js += "      if(p._v>0)h+=tag('#9B8BF4',fmt(p._v)+' views');\n";
  js += "      h+='</div>';\n";
  js += "      h+='<p style=\"margin:0 0 5px;font-size:13px;line-height:1.6;color:var(--text-d)\"><b style=\"color:var(--green-dark)\">Hook: </b>'+esc(p._hook||'(no caption)')+'</p>';\n";
  js += "      if(hi&&hi.why)h+='<p style=\"margin:0 0 5px;font-size:11px;color:var(--muted-d);font-style:italic\">'+esc(hi.why)+'</p>';\n";
  js += "      h+='<div style=\"display:flex;gap:12px\"><span style=\"font-size:11px;color:var(--muted-d)\">&hearts; '+fmt(p.likesCount)+'</span><span style=\"font-size:11px;color:var(--muted-d)\">&#128172; '+fmt(p.commentsCount)+'</span>';\n";
  js += "      if(p._url&&p._url!=='#')h+='<a href=\"'+p._url+'\" target=\"_blank\" style=\"font-size:11px;color:#9B8BF4;text-decoration:none\">View &#8599;</a>';\n";
  js += "      h+='</div></div></div>';\n";
  js += "    });\n";
  js += "  } else {\n";
  js += "    h+='<p style=\"color:var(--muted-d);font-size:13px\">No post data available.</p>';\n";
  js += "  }\n";
  js += "  h+='</div>';\n";

  // Hook pattern clusters
  js += "  if(ai&&ai.patterns&&ai.patterns.length){\n";
  js += "    h+='<div class=\"dk\" style=\"margin-bottom:12px\">';\n";
  js += "    h+=sh('Top Hook Patterns',true);\n";
  js += "    h+='<div class=\"grid\" style=\"grid-template-columns:repeat(auto-fill,minmax(200px,1fr))\">';\n";
  js += "    ai.patterns.forEach(function(p){\n";
  js += "      h+='<div style=\"background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:14px\">';\n";
  js += "      h+='<div style=\"display:flex;justify-content:space-between;margin-bottom:8px\"><b style=\"font-size:13px;color:var(--text-l)\">'+esc(p.name)+'</b><span class=\"mono\" style=\"font-size:20px;color:var(--green);font-weight:700\">'+p.pct+'%</span></div>';\n";
  js += "      h+='<div class=\"bar-track\" style=\"margin-bottom:8px\"><div class=\"bar-fill\" style=\"width:'+Math.min(p.pct,100)+'%;background:var(--green)\"></div></div>';\n";
  js += "      h+='<p style=\"font-size:11px;color:var(--muted-l);line-height:1.5;margin-bottom:8px\">'+esc(p.signature)+'</p>';\n";
  js += "      (p.examples||[]).slice(0,2).forEach(function(e){h+='<div style=\"font-size:10px;color:rgba(255,255,255,0.35);font-style:italic;margin-bottom:3px;padding-left:7px;border-left:2px solid rgba(255,255,255,0.1);line-height:1.5\">&quot;'+esc(e)+'&quot;</div>';});\n";
  js += "      h+='</div>';\n";
  js += "    });\n";
  js += "    h+='</div></div>';\n";
  js += "  }\n";

  // Content themes
  js += "  if(ai&&ai.themes&&ai.themes.length){\n";
  js += "    h+='<div style=\"margin-bottom:12px\">';\n";
  js += "    h+=sh('Content Themes',false);\n";
  js += "    h+='<div class=\"grid\" style=\"grid-template-columns:repeat(auto-fill,minmax(190px,1fr))\">';\n";
  js += "    ai.themes.forEach(function(t,i){\n";
  js += "      var c=TCOLS[i%TCOLS.length];\n";
  js += "      h+='<div class=\"lt\" style=\"border-top:3px solid '+c+'\">';\n";
  js += "      h+='<div style=\"display:flex;justify-content:space-between;margin-bottom:5px\"><b style=\"font-size:13px;color:var(--text-d)\">'+esc(t.name)+'</b><span class=\"mono\" style=\"color:'+c+';font-size:13px\">'+t.pct+'%</span></div>';\n";
  js += "      h+='<p style=\"font-size:11px;color:var(--muted-d);line-height:1.5;margin-bottom:8px\">'+esc(t.desc)+'</p>';\n";
  js += "      h+='<div style=\"display:flex;flex-wrap:wrap;gap:4px\">';\n";
  js += "      (t.keywords||[]).forEach(function(k){h+='<span style=\"background:'+c+'18;color:'+c+';border-radius:4px;padding:2px 6px;font-size:10px;font-weight:700\">'+esc(k)+'</span>';});\n";
  js += "      h+='</div></div>';\n";
  js += "    });\n";
  js += "    h+='</div></div>';\n";
  js += "  }\n";

  // Repeatable frameworks (insights)
  js += "  if(ai&&ai.frameworks&&ai.frameworks.length){\n";
  js += "    h+='<div class=\"lt\" style=\"margin-bottom:12px\">';\n";
  js += "    h+=sh('Repeatable Frameworks',false);\n";
  js += "    ai.frameworks.forEach(function(fw){\n";
  js += "      var steps=(fw.structure||'').split(/[0-9]\\)/).filter(function(s){return s.trim();});\n";
  js += "      h+='<div style=\"border:1.5px solid var(--border-l);border-radius:12px;padding:14px;margin-bottom:10px\">';\n";
  js += "      h+='<div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px\"><b style=\"font-size:14px;color:var(--text-d)\">'+esc(fw.name)+'</b>'+tag('#9B8BF4',fw.usage)+'</div>';\n";
  js += "      h+='<div style=\"display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px\">';\n";
  js += "      steps.forEach(function(s,j){h+='<div style=\"background:var(--bg);border:1px solid var(--border-l);border-radius:6px;padding:4px 10px;font-size:11px;color:var(--muted-d)\"><span style=\"color:#9B8BF4;font-weight:700\">'+(j+1)+'</span> '+esc(s.trim())+'</div>';});\n";
  js += "      h+='</div>';\n";
  js += "      if(fw.example)h+='<div style=\"font-size:11px;color:var(--muted-d);font-style:italic;border-left:2px solid #9B8BF4;padding-left:8px\">&quot;'+esc(fw.example)+'&quot;</div>';\n";
  js += "      h+='</div>';\n";
  js += "    });\n";
  js += "    h+='</div>';\n";
  js += "  }\n";

  // Generated hooks (recommended content)
  js += "  if(ai&&ai.generatedHooks&&ai.generatedHooks.length){\n";
  js += "    h+='<div style=\"margin-bottom:12px\">';\n";
  js += "    h+=sh('10 Recommended Hook Ideas for Man Matters',false);\n";
  js += "    h+='<div class=\"grid\" style=\"grid-template-columns:repeat(auto-fill,minmax(300px,1fr))\">';\n";
  js += "    ai.generatedHooks.forEach(function(hk,i){\n";
  js += "      var c=HOOK_COL[hk.type]||'#22C55E';\n";
  js += "      h+='<div class=\"lt\" style=\"border-left:3px solid '+c+'\">';\n";
  js += "      h+='<div style=\"display:flex;flex-wrap:wrap;gap:6px;margin-bottom:7px;align-items:center\">';\n";
  js += "      h+='<span class=\"mono\" style=\"color:var(--muted-d);font-size:10px;font-weight:700\">#'+(i<9?'0':'')+(i+1)+'</span>';\n";
  js += "      h+=tag(c,(hk.type||'').replace(/_/g,' '));\n";
  js += "      if(hk.angle)h+='<span style=\"font-size:11px;color:var(--muted-d)\">'+esc(hk.angle)+'</span>';\n";
  js += "      h+='</div>';\n";
  js += "      h+='<p style=\"margin:0 0 6px;font-weight:700;font-size:13px;color:var(--text-d);line-height:1.6\">&quot;'+esc(hk.hook)+'&quot;</p>';\n";
  js += "      if(hk.note)h+='<p style=\"margin:0;font-size:11px;color:var(--muted-d);font-style:italic\">'+esc(hk.note)+'</p>';\n";
  js += "      h+='</div>';\n";
  js += "    });\n";
  js += "    h+='</div></div>';\n";
  js += "  }\n";

  // Brand fit: flags + verdict
  js += "  if((ai&&ai.flags&&ai.flags.length)||(ai&&ai.verdict)){\n";
  js += "    h+='<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px\">';\n";
  js += "    h+='<div class=\"dk\">';\n";
  js += "    h+=sh('Vetting Flags',true);\n";
  js += "    (ai.flags||[]).forEach(function(f){\n";
  js += "      var c=SEV_COL[f.severity]||'#94A3B8';\n";
  js += "      h+='<div style=\"border-left:3px solid '+c+';padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:0 8px 8px 0;margin-bottom:8px\">';\n";
  js += "      h+='<div style=\"display:flex;gap:6px;margin-bottom:4px;align-items:center\">'+tag(c,f.severity)+'<b style=\"font-size:12px;color:var(--text-l)\">'+esc(f.flag)+'</b></div>';\n";
  js += "      h+='<p style=\"margin:0;font-size:11px;color:var(--muted-l);line-height:1.5\">'+esc(f.implication)+'</p></div>';\n";
  js += "    });\n";
  js += "    h+='</div>';\n";
  js += "    if(ai&&ai.verdict){\n";
  js += "      h+='<div class=\"lt\">';\n";
  js += "      h+=sh('Verdict',false);\n";
  js += "      h+='<div style=\"font-size:11px;color:var(--green-dark);font-weight:700;margin-bottom:5px\">&#10003; Strengths</div>';\n";
  js += "      (ai.verdict.strengths||[]).forEach(function(s){h+='<div style=\"font-size:12px;color:var(--muted-d);margin-bottom:3px;line-height:1.5\">&middot; '+esc(s)+'</div>';});\n";
  js += "      h+='<div style=\"font-size:11px;color:var(--red);font-weight:700;margin:10px 0 5px\">&#10007; Concerns</div>';\n";
  js += "      (ai.verdict.concerns||[]).forEach(function(c){h+='<div style=\"font-size:12px;color:var(--muted-d);margin-bottom:3px;line-height:1.5\">&middot; '+esc(c)+'</div>';});\n";
  js += "      h+='<div style=\"margin:12px 0 0;padding:10px 12px;background:var(--bg);border-radius:10px\">';\n";
  js += "      h+='<div style=\"font-size:10px;color:var(--muted-d);margin-bottom:3px;text-transform:uppercase;letter-spacing:.08em\">Best Use Case</div>';\n";
  js += "      h+='<div style=\"font-size:13px;color:var(--green-dark);font-weight:600;line-height:1.5\">'+esc(ai.verdict.bestUse||'')+'</div></div>';\n";
  js += "      h+='<div style=\"display:flex;flex-wrap:wrap;gap:5px;margin-top:10px\">';\n";
  js += "      (ai.verdict.formats||[]).forEach(function(f){h+=tag('#9B8BF4',f);});\n";
  js += "      h+='</div></div>';\n";
  js += "    }\n";
  js += "    h+='</div>';\n";
  js += "  }\n";

  js += "  return h;\n";
  js += "}\n";

  // ── SINGLE REPORT RENDERER ────────────────────────────────────────────────────
  js += "function renderSingleReport(d,ai){\n";
  js += "  document.getElementById('nav-h').textContent='@'+d.handle;\n";
  js += "  var h='';\n";
  // Creator identity header
  js += "  h+='<div style=\"display:flex;gap:14px;align-items:center;margin-bottom:24px;flex-wrap:wrap\">';\n";
  js += "  if(d.pic)h+='<img src=\"'+d.pic+'\" onerror=\"this.style.display=\\'none\\'\" style=\"width:56px;height:56px;border-radius:50%;border:2px solid var(--green);object-fit:cover;flex-shrink:0\"/>';\n";
  js += "  h+='<div style=\"flex:1;min-width:0\"><h1 style=\"font-size:22px;font-weight:800;margin-bottom:3px;color:var(--text-d)\">'+esc(d.name||'@'+d.handle)+'</h1>';\n";
  js += "  h+='<div style=\"font-size:12px;color:var(--muted-d);line-height:1.6\">'+esc((d.bio||'').slice(0,120))+((d.bio||'').length>120?'&hellip;':'')+'</div></div>';\n";
  js += "  h+='</div>';\n";
  // All sections via shared function
  js += "  h+=renderCreatorBody(d,ai);\n";
  // Footer
  js += "  h+='<div style=\"border-top:1px solid var(--border-l);padding-top:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px\">';\n";
  js += "  h+='<span style=\"font-size:11px;color:var(--muted-d)\">CreatorLens &middot; Apify + Gemini &middot; '+d.total+' posts analyzed</span>';\n";
  js += "  h+='<button class=\"btn-sm\" onclick=\"showScreen(\\'setup\\')\">Analyze Another &#8594;</button></div>';\n";
  js += "  document.getElementById('report').innerHTML=h;\n";
  js += "}\n";

  // ── BATCH REPORT RENDERER ─────────────────────────────────────────────────────
  js += "function renderBatchReport(metricsArray,batchResult){\n";
  js += "  var ranking=(batchResult&&batchResult.ranking)||[];\n";
  js += "  var analyses=(batchResult&&batchResult.analyses)||{};\n";
  js += "  var sorted=ranking.map(function(r){return{rank:r,m:metricsArray.find(function(m){return m.handle===r.handle;})};}).filter(function(x){return x.m;});\n";
  js += "  document.getElementById('nav-h').textContent='Batch \u2014 '+metricsArray.length+' creators';\n";
  js += "  var h='';\n";

  // Title
  js += "  h+='<div style=\"margin-bottom:24px\">';\n";
  js += "  h+='<h1 style=\"font-size:26px;font-weight:800;color:var(--text-d);margin-bottom:6px\">Creator Comparison</h1>';\n";
  js += "  h+='<p style=\"font-size:13px;color:var(--muted-d)\">'+metricsArray.length+' creators analyzed &middot; ranked by brand fit score</p>';\n";
  js += "  h+='</div>';\n";

  // Ranking table
  js += "  h+='<div class=\"dk\" style=\"margin-bottom:16px\">';\n";
  js += "  h+=sh('Ranking by Brand Fit Score',true);\n";
  js += "  sorted.forEach(function(item,idx){\n";
  js += "    var r=item.rank,m=item.m;\n";
  js += "    var sc=r.score||0;\n";
  js += "    var fc=sc>=7?'#5EE87A':sc>=5?'#F59E0B':'#EF4444';\n";
  js += "    var rankBg=idx===0?'#5EE87A':idx===1?'rgba(255,255,255,0.15)':'rgba(255,255,255,0.06)';\n";
  js += "    var rankFg=idx===0?'#0D0D1C':'var(--text-l)';\n";
  js += "    h+='<div style=\"padding:14px 0;border-bottom:1px solid rgba(255,255,255,0.06)\">';\n";
  js += "    h+='<div style=\"display:flex;align-items:center;gap:12px\">';\n";
  js += "    h+='<div class=\"rank-badge\" style=\"background:'+rankBg+';color:'+rankFg+'\">'+r.rank+'</div>';\n";
  js += "    if(m.pic)h+='<img src=\"'+m.pic+'\" onerror=\"this.style.display=\\'none\\'\" style=\"width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0\"/>';\n";
  js += "    h+='<div style=\"flex:1;min-width:0\"><div style=\"font-size:14px;font-weight:700;color:var(--text-l)\">@'+esc(m.handle)+'</div>';\n";
  js += "    h+='<div style=\"font-size:11px;color:var(--muted-l);margin-top:2px\">'+esc(r.oneliner||'')+'</div></div>';\n";
  js += "    h+='<div style=\"display:flex;gap:16px;flex-wrap:wrap\">';\n";
  js += "    h+='<div style=\"text-align:right\"><div style=\"font-size:10px;color:var(--muted-l);text-transform:uppercase\">Followers</div><div class=\"mono\" style=\"font-size:14px;color:var(--text-l);font-weight:700\">'+fmt(m.followers)+'</div></div>';\n";
  js += "    h+='<div style=\"text-align:right\"><div style=\"font-size:10px;color:var(--muted-l);text-transform:uppercase\">Avg ER</div><div class=\"mono\" style=\"font-size:14px;color:var(--text-l);font-weight:700\">'+m.avgER+'%</div></div>';\n";
  js += "    h+='<div style=\"text-align:right\"><div style=\"font-size:10px;color:var(--muted-l);text-transform:uppercase\">Brand Fit</div><div class=\"mono\" style=\"font-size:18px;color:'+fc+';font-weight:800\">'+sc+'/10</div></div>';\n";
  js += "    h+='</div></div>';\n";
  js += "    h+='<div style=\"padding:6px 0 0 44px;display:flex;gap:12px;flex-wrap:wrap\">';\n";
  js += "    if(r.topStrength)h+='<span style=\"font-size:11px;color:#5EE87A\">&#10003; '+esc(r.topStrength)+'</span>';\n";
  js += "    if(r.topFlag)h+='<span style=\"font-size:11px;color:#EF4444\">&#9888; '+esc(r.topFlag)+'</span>';\n";
  js += "    h+='</div></div>';\n";
  js += "  });\n";
  js += "  h+='</div>';\n";

  // Individual full reports (expandable) — use renderCreatorBody for full sections
  js += "  h+='<div style=\"font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:var(--muted-d);margin-bottom:12px\">Individual Full Reports</div>';\n";
  js += "  sorted.forEach(function(item,idx){\n";
  js += "    var r=item.rank,m=item.m;\n";
  js += "    var ai=analyses[m.handle]||null;\n";
  js += "    var sc=r.score||0;\n";
  js += "    var fc=sc>=7?'#22C55E':sc>=5?'#F59E0B':'#EF4444';\n";
  js += "    var divId='cr-'+idx;\n";
  js += "    h+='<div class=\"lt\" style=\"margin-bottom:10px\">';\n";
  // Collapsible header
  js += "    h+='<div style=\"display:flex;align-items:center;gap:12px;cursor:pointer;user-select:none\" onclick=\"toggleCreator('+idx+')\">';\n";
  js += "    h+='<div class=\"rank-badge\" style=\"background:var(--bg);color:var(--text-d);font-size:13px\">'+r.rank+'</div>';\n";
  js += "    if(m.pic)h+='<img src=\"'+m.pic+'\" onerror=\"this.style.display=\\'none\\'\" style=\"width:32px;height:32px;border-radius:50%;object-fit:cover\"/>';\n";
  js += "    h+='<div style=\"flex:1\"><span style=\"font-size:15px;font-weight:700;color:var(--text-d)\">@'+esc(m.handle)+'</span>';\n";
  js += "    if(m.name)h+='<span style=\"font-size:12px;color:var(--muted-d);margin-left:8px\">'+esc(m.name)+'</span>';\n";
  js += "    h+='</div>';\n";
  js += "    h+='<div class=\"mono\" style=\"font-size:22px;font-weight:800;color:'+fc+'\">'+sc+'<span style=\"font-size:12px;color:var(--muted-d)\">/10</span></div>';\n";
  js += "    h+='<span id=\"arr-'+idx+'\" style=\"color:var(--muted-d);font-size:18px;transition:transform .2s\">&#9660;</span>';\n";
  js += "    h+='</div>';\n";
  // Collapsible content — FULL report via renderCreatorBody
  js += "    h+='<div id=\"'+divId+'\" class=\"collapsible\" style=\"margin-top:16px;padding-top:16px;border-top:1px solid var(--border-l)\">';\n";
  js += "    h+=renderCreatorBody(m,ai);\n";
  js += "    h+='</div>';\n";
  js += "    h+='</div>';\n";
  js += "  });\n";

  // Footer
  js += "  h+='<div style=\"border-top:1px solid var(--border-l);padding-top:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px\">';\n";
  js += "  h+='<span style=\"font-size:11px;color:var(--muted-d)\">CreatorLens Batch &middot; Apify + Gemini &middot; '+metricsArray.length+' creators</span>';\n";
  js += "  h+='<button class=\"btn-sm\" onclick=\"showScreen(\\'setup\\')\">New Analysis &#8594;</button></div>';\n";
  js += "  document.getElementById('report').innerHTML=h;\n";
  js += "}\n";

  // ── Toggle individual creator in batch report ─────────────────────────────────
  js += "function toggleCreator(idx){\n";
  js += "  var el=document.getElementById('cr-'+idx);\n";
  js += "  var arr=document.getElementById('arr-'+idx);\n";
  js += "  if(el.classList.contains('open')){el.classList.remove('open');arr.style.transform='';}\n";
  js += "  else{el.classList.add('open');arr.style.transform='rotate(180deg)';}\n";
  js += "}\n";

  js += "showScreen('setup');\n";
  return js;
}
