const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const FIREBASE_DB_URL = "https://fir-5b615-default-rtdb.firebaseio.com";
const FIREBASE_NODE = "tg_autopost";

const DEFAULT_CONFIG = {
  approvedDomain: "",
  websiteBaseUrl: "",
  botToken: "",
  channelId: "",
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
  lastRun: null,
  lastError: ""
};

function getFirebaseUrl(subPath = "") {
  const base = FIREBASE_DB_URL.replace(/\/+$/, "");
  const suffix = subPath ? `/${subPath.replace(/^\/+/, "")}` : "";
  return `${base}/${FIREBASE_NODE}${suffix}.json`;
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
        queue: Array.isArray(saved.queue) ? saved.queue.filter(Boolean) : [],
        postedIds: Array.isArray(saved.postedIds) ? saved.postedIds.map(String) : [],
        history: Array.isArray(saved.history) ? saved.history : [],
        autoPost: typeof saved.autoPost === "boolean" ? saved.autoPost : true,
        lastRun: saved.lastRun || null
      };
    }
  } catch (err) {
    state.lastError = err.message;
    console.error("Firebase load error:", err.message);
  }
}

async function saveStateToFirebase() {
  try {
    const payload = {
      config: state.config,
      queue: state.queue.slice(0, state.config.queueSize || 5),
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

    if (!res.ok) throw new Error(`Firebase save failed (${res.status})`);
  } catch (err) {
    state.lastError = err.message;
    console.error("Firebase save error:", err.message);
  }
}

function cleanUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function postVideoToTelegram(video) {
  if (!video) throw new Error("No video in queue");

  const token = String(state.config.botToken || "").trim();
  const chatId = String(state.config.channelId || "").trim();
  if (!token) throw new Error("Telegram Bot Token is not set in Firebase config");
  if (!chatId) throw new Error("Telegram Channel ID/Username is not set in Firebase config");

  const webBase = cleanUrl(state.config.websiteBaseUrl || state.config.approvedDomain);
  const watchUrl = webBase ? `${webBase}/#/video/${video.id}` : video.videoUrl;
  if (!watchUrl) throw new Error("Watch URL missing");

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
        inline_keyboard: [[{ text: state.config.buttonText || "▶️ Watch Video", url: watchUrl }]]
      }
    })
  });

  const result = await res.json();
  if (!res.ok || !result.ok) {
    throw new Error(result.description || "Telegram sendPhoto failed");
  }
  return result;
}

async function processNextFromFirebaseQueue() {
  await loadStateFromFirebase();
  if (!state.queue.length) {
    throw new Error("Queue is empty in Firebase. Open website to refill queue.");
  }

  const nextVideo = state.queue.shift();
  await postVideoToTelegram(nextVideo);

  state.postedIds.push(String(nextVideo.id));
  state.history.unshift({
    ...nextVideo,
    postedAt: new Date().toISOString()
  });
  state.lastRun = new Date().toISOString();
  state.lastError = "";

  await saveStateToFirebase();
  return nextVideo;
}

let timerHandle = null;
let currentIntervalMins = null;

function syncScheduler() {
  const mins = Math.max(1, Number(state.config.intervalMinutes) || 30);
  if (timerHandle && currentIntervalMins === mins) return;

  if (timerHandle) clearInterval(timerHandle);
  currentIntervalMins = mins;

  timerHandle = setInterval(async () => {
    try {
      await loadStateFromFirebase();
      if (!state.autoPost) return;
      syncScheduler();
      await processNextFromFirebaseQueue();
      console.log("Auto-posted to Telegram at", new Date().toISOString());
    } catch (err) {
      state.lastError = err.message;
      console.error("Auto-post error:", err.message);
    }
  }, mins * 60 * 1000);
}

app.get("/", (req, res) => {
  res.json({
    service: "Telegram Video Auto-Poster Worker",
    status: "running",
    health: "/health"
  });
});

app.get("/health", async (req, res) => {
  await loadStateFromFirebase();
  syncScheduler();
  res.status(200).json({
    status: "ok",
    autoPost: state.autoPost,
    queueCount: state.queue.length,
    intervalMinutes: currentIntervalMins || state.config.intervalMinutes,
    lastRun: state.lastRun,
    lastError: state.lastError,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, async () => {
  console.log(`Worker listening on port ${PORT}`);
  await loadStateFromFirebase();
  syncScheduler();
});
