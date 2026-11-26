const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ================= FIREBASE & DEFAULT CONFIG =================
const FIREBASE_DB_URL = "https://fir-5b615-default-rtdb.firebaseio.com";
const FIREBASE_NODE = "tg_autopost"; // Firebase-এর ভেতরে এই নোডে ডেটা থাকবে

const DEFAULT_CONFIG = {
  port: process.env.PORT || 3000,
  approvedDomain: "https://your-approved-domain.com",
  websiteBaseUrl: "https://your-approved-domain.com",
  apiBaseUrl: "https://pornapi.sbs/wp-json/video-library/v1",
  apiKey: "vlk_4e2598857ae8d604806e036c4aee2efeb95c8997",
  botToken: "YOUR_TELEGRAM_BOT_TOKEN",
  channelId: "@your_channel_username",
  intervalMinutes: 30,
  queueSize: 5,
  buttonText: "▶️ Watch Video",
  tags: ""
};

let state = {
  config: { ...DEFAULT_CONFIG },
  queue: [],
  postedIds: [],
  history: [],
  autoPost: true,
  lastRun: null
};

// ================= FIREBASE PERSISTENCE =================
function getFirebaseUrl(subPath = "") {
  const cleanBase = FIREBASE_DB_URL.replace(/\/+$/, "");
  const suffix = subPath ? `/${subPath.replace(/^\/+/, "")}` : "";
  return `${cleanBase}/${FIREBASE_NODE}${suffix}.json`;
}

async function loadStateFromFirebase() {
  try {
    const res = await fetch(getFirebaseUrl());
    if (!res.ok) throw new Error(`Firebase read failed (${res.status})`);
    const saved = await res.json();

    if (saved && typeof saved === "object") {
      state = {
        ...state,
        ...saved,
        config: { ...DEFAULT_CONFIG, ...(saved.config || {}) },
        queue: Array.isArray(saved.queue) ? saved.queue : [],
        postedIds: Array.isArray(saved.postedIds) ? saved.postedIds : [],
        history: Array.isArray(saved.history) ? saved.history : [],
        autoPost: typeof saved.autoPost === "boolean" ? saved.autoPost : true,
        lastRun: saved.lastRun || null
      };
    } else {
      await saveStateToFirebase();
    }
  } catch (err) {
    console.error("Firebase load error:", err.message);
  }
}

async function saveStateToFirebase() {
  try {
    const payload = {
      config: state.config,
      queue: state.queue,
      postedIds: state.postedIds.slice(-1000),
      history: state.history.slice(0, 20),
      autoPost: state.autoPost,
      lastRun: state.lastRun
    };

    const res = await fetch(getFirebaseUrl(), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`Firebase save failed (${res.status})`);
    }
  } catch (err) {
    console.error("Firebase save error:", err.message);
  }
}

function cleanUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

function formatDuration(v) {
  return (
    v.duration_formatted ||
    (v.duration_seconds
      ? `${Math.floor(v.duration_seconds / 60)}:${String(v.duration_seconds % 60).padStart(2, "0")}`
      : "")
  );
}

function normalizeVideo(v) {
  const webBase = cleanUrl(state.config.websiteBaseUrl);
  const id = v.id;
  return {
    id,
    title: v.title || "Untitled Video",
    thumbnail: v.poster?.local_url || "",
    duration: formatDuration(v),
    videoUrl: `${webBase}/#/video/${id}`
  };
}

function getApiHeaders() {
  const domain = cleanUrl(state.config.approvedDomain) || "https://example.com";
  return {
    "Authorization": `Bearer ${state.config.apiKey}`,
    "Referer": `${domain}/`,
    "Origin": domain,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
  };
}

function getTagList() {
  return String(state.config.tags || "")
    .split(",")
    .map(t => t.trim())
    .filter(Boolean);
}

function shuffleArray(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// ================= API FETCHERS =================
async function fetchVideosFromApi({ page = 1, perPage = 24, tag = "", q = "" } = {}) {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(perPage),
    orderby: "release_date",
    order: "desc",
    view: "summary"
  });
  if (tag) params.set("tag", tag);
  if (q) params.set("q", q);

  const url = `${state.config.apiBaseUrl}/videos?${params.toString()}`;
  const res = await fetch(url, { method: "GET", headers: getApiHeaders() });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API Error (${res.status}): ${errText.slice(0, 120)}`);
  }

  const data = await res.json();
  return data.items || [];
}

async function fetchSingleVideoById(videoId) {
  const url = `${state.config.apiBaseUrl}/videos/${encodeURIComponent(videoId)}`;
  const res = await fetch(url, { method: "GET", headers: getApiHeaders() });
  if (!res.ok) throw new Error("Video not found in API");
  const json = await res.json();
  const v = json.data || json;
  if (!v || !v.id) throw new Error("Invalid video data");
  return normalizeVideo(v);
}

// ================= QUEUE MANAGEMENT =================
async function refillQueue() {
  const targetSize = state.config.queueSize || 5;
  if (state.queue.length >= targetSize) return;

  try {
    const tagList = getTagList();
    let pool = [];

    if (tagList.length > 0) {
      const perTag = Math.max(6, Math.ceil(24 / tagList.length));
      const results = await Promise.all(
        tagList.map(async (tag) => {
          try {
            const p = Math.floor(Math.random() * 3) + 1;
            let items = await fetchVideosFromApi({ page: p, perPage: perTag, tag });
            if (!items.length && p !== 1) {
              items = await fetchVideosFromApi({ page: 1, perPage: perTag, tag });
            }
            return items;
          } catch {
            return [];
          }
        })
      );
      pool = shuffleArray(results.flat());
    } else {
      const randomPage = Math.floor(Math.random() * 5) + 1;
      pool = await fetchVideosFromApi({ page: randomPage, perPage: 24 });
      if (!pool.length && randomPage !== 1) {
        pool = await fetchVideosFromApi({ page: 1, perPage: 24 });
      }
    }

    const queuedIds = new Set(state.queue.map(v => String(v.id)));
    const postedSet = new Set(state.postedIds.map(String));
    let added = false;

    for (const raw of pool) {
      if (state.queue.length >= targetSize) break;
      if (!raw || !raw.id) continue;
      const idStr = String(raw.id);
      if (queuedIds.has(idStr) || postedSet.has(idStr)) continue;

      state.queue.push(normalizeVideo(raw));
      queuedIds.add(idStr);
      added = true;
    }

    if (added) {
      await saveStateToFirebase();
    }
  } catch (err) {
    console.error("Queue refill error:", err.message);
  }
}

// ================= TELEGRAM SENDER =================
async function postVideoToTelegram(video) {
  if (!video) throw new Error("No video to post");
  const token = String(state.config.botToken || "").trim();
  const chatId = String(state.config.channelId || "").trim();

  if (!token || token === "YOUR_TELEGRAM_BOT_TOKEN") {
    throw new Error("Telegram Bot Token set korun");
  }
  if (!chatId) {
    throw new Error("Telegram Channel Username set korun");
  }

  const webBase = cleanUrl(state.config.websiteBaseUrl);
  const finalUrl = `${webBase}/#/video/${video.id}`;
  const caption = `🎬 <b>${escapeHtml(video.title)}</b>${video.duration ? `\n⏱ Duration: <code>${escapeHtml(video.duration)}</code>` : ""}`;

  const tgUrl = `https://api.telegram.org/bot${token}/sendPhoto`;
  const res = await fetch(tgUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      photo: video.thumbnail,
      caption,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[{ text: state.config.buttonText || "▶️ Watch Video", url: finalUrl }]]
      }
    })
  });

  const result = await res.json();
  if (!res.ok || !result.ok) {
    throw new Error(result.description || "Telegram sendPhoto failed");
  }
  return result;
}

async function processNextInQueue() {
  if (state.queue.length === 0) await refillQueue();
  if (state.queue.length === 0) throw new Error("Queue is empty");

  const nextVideo = state.queue.shift();
  await postVideoToTelegram(nextVideo);

  state.postedIds.push(String(nextVideo.id));
  if (state.postedIds.length > 1000) state.postedIds = state.postedIds.slice(-1000);

  state.history.unshift({ ...nextVideo, postedAt: new Date().toISOString() });
  state.history = state.history.slice(0, 20);
  state.lastRun = new Date().toISOString();

  await saveStateToFirebase();
  await refillQueue();
  return nextVideo;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ================= DYNAMIC SCHEDULER =================
let timerHandle = null;

function restartScheduler() {
  if (timerHandle) clearInterval(timerHandle);
  const mins = Math.max(1, Number(state.config.intervalMinutes) || 30);
  timerHandle = setInterval(async () => {
    if (!state.autoPost) return;
    try {
      await processNextInQueue();
      console.log("Auto-posted at", new Date().toISOString());
    } catch (err) {
      console.error("Auto-post error:", err.message);
    }
  }, mins * 60 * 1000);
}

// ================= HEALTH & ROUTES =================
app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    autoPost: state.autoPost,
    queueCount: state.queue.length,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get("/api/state", async (req, res) => {
  await refillQueue();
  res.json({
    config: {
      approvedDomain: state.config.approvedDomain,
      websiteBaseUrl: state.config.websiteBaseUrl,
      botToken: state.config.botToken,
      channelId: state.config.channelId,
      intervalMinutes: state.config.intervalMinutes,
      tags: state.config.tags
    },
    queue: state.queue.slice(0, state.config.queueSize || 5),
    history: state.history.slice(0, 10),
    autoPost: state.autoPost,
    lastRun: state.lastRun
  });
});

app.post("/api/settings", async (req, res) => {
  const {
    approvedDomain,
    websiteBaseUrl,
    botToken,
    channelId,
    intervalMinutes,
    tags,
    refillWithTags
  } = req.body || {};

  if (approvedDomain !== undefined) state.config.approvedDomain = String(approvedDomain).trim();
  if (websiteBaseUrl !== undefined) state.config.websiteBaseUrl = String(websiteBaseUrl).trim();
  if (botToken !== undefined) state.config.botToken = String(botToken).trim();
  if (channelId !== undefined) state.config.channelId = String(channelId).trim();
  if (intervalMinutes !== undefined) {
    state.config.intervalMinutes = Math.max(1, Number(intervalMinutes) || 30);
  }
  if (tags !== undefined) state.config.tags = String(tags).trim();

  const webBase = cleanUrl(state.config.websiteBaseUrl);
  state.queue = state.queue.map(v => ({ ...v, videoUrl: `${webBase}/#/video/${v.id}` }));

  if (refillWithTags) {
    state.queue = [];
  }

  await saveStateToFirebase();
  restartScheduler();
  await refillQueue();

  res.json({
    ok: true,
    config: state.config,
    queue: state.queue.slice(0, state.config.queueSize || 5)
  });
});

app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const tagList = getTagList();
    let items = [];

    if (q) {
      items = await fetchVideosFromApi({ page: 1, perPage: 15, q });
    } else if (tagList.length > 0) {
      const perTag = Math.max(5, Math.ceil(15 / tagList.length));
      const all = await Promise.all(
        tagList.map(t => fetchVideosFromApi({ page: 1, perPage: perTag, tag: t }).catch(() => []))
      );
      items = all.flat();
    } else {
      items = await fetchVideosFromApi({ page: 1, perPage: 15 });
    }

    const map = new Map();
    items.forEach(v => { if (v && v.id) map.set(v.id, normalizeVideo(v)); });
    res.json({ ok: true, items: Array.from(map.values()).slice(0, 15) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/queue/pin", async (req, res) => {
  try {
    const rawInput = String(req.body.input || "").trim();
    const match = rawInput.match(/(\d+)/);
    if (!match) return res.status(400).json({ ok: false, error: "Valid Video ID or URL din" });

    const video = await fetchSingleVideoById(match[1]);
    state.queue = state.queue.filter(v => String(v.id) !== String(video.id));
    state.queue.unshift(video);
    await saveStateToFirebase();

    res.json({ ok: true, queue: state.queue.slice(0, state.config.queueSize || 5), pinned: video });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/queue/select", async (req, res) => {
  try {
    const { video } = req.body || {};
    if (!video || !video.id) return res.status(400).json({ ok: false, error: "Video data missing" });

    const webBase = cleanUrl(state.config.websiteBaseUrl);
    const item = {
      id: video.id,
      title: video.title || "Untitled Video",
      thumbnail: video.thumbnail || "",
      duration: video.duration || "",
      videoUrl: `${webBase}/#/video/${video.id}`
    };

    state.queue = state.queue.filter(v => String(v.id) !== String(item.id));
    state.queue.unshift(item);
    await saveStateToFirebase();

    res.json({ ok: true, queue: state.queue.slice(0, state.config.queueSize || 5), selected: item });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/queue/move", async (req, res) => {
  const { id, direction } = req.body || {};
  const idx = state.queue.findIndex(v => String(v.id) === String(id));
  if (idx === -1) return res.status(404).json({ ok: false, error: "Not in queue" });

  const targetIdx = direction === "up" ? idx - 1 : idx + 1;
  if (targetIdx < 0 || targetIdx >= state.queue.length) {
    return res.json({ ok: true, queue: state.queue.slice(0, state.config.queueSize || 5) });
  }

  const temp = state.queue[idx];
  state.queue[idx] = state.queue[targetIdx];
  state.queue[targetIdx] = temp;
  await saveStateToFirebase();

  res.json({ ok: true, queue: state.queue.slice(0, state.config.queueSize || 5) });
});

app.delete("/api/queue/:id", async (req, res) => {
  const targetId = String(req.params.id);
  state.queue = state.queue.filter(v => String(v.id) !== targetId);
  await saveStateToFirebase();
  await refillQueue();
  res.json({ ok: true, queue: state.queue.slice(0, state.config.queueSize || 5) });
});

app.post("/api/queue/refresh", async (req, res) => {
  state.queue = [];
  await saveStateToFirebase();
  await refillQueue();
  res.json({ ok: true, queue: state.queue.slice(0, state.config.queueSize || 5) });
});

app.post("/api/post-now", async (req, res) => {
  try {
    const posted = await processNextInQueue();
    res.json({ ok: true, posted, queue: state.queue.slice(0, state.config.queueSize || 5) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post("/api/toggle-auto", async (req, res) => {
  state.autoPost = !state.autoPost;
  await saveStateToFirebase();
  res.json({ ok: true, autoPost: state.autoPost });
});

app.listen(DEFAULT_CONFIG.port, async () => {
  console.log(`Server running on http://localhost:${DEFAULT_CONFIG.port}`);
  await loadStateFromFirebase();
  restartScheduler();
  await refillQueue();
});