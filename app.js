// Reps: camera → MediaPipe pose → rep engine → voice, on-screen stats and an on-phone log.
import { Tracker, NAMES, EXERCISES } from './engine.js';
import { PoseLandmarker } from './vendor/mediapipe/vision_bundle.mjs';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SRC = params.get('src'); // testing: play a video file instead of the camera
const DEBUG = params.has('debug');

const video = $('video');
const canvas = $('overlay');
const ctx = canvas.getContext('2d');

// ---------- storage: best effort, so private mode or a full disk never stops the counting ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
};
const LOG_KEY = 'reps.log.v1';
let log = (() => {
  const v = store.get(LOG_KEY, []);
  return Array.isArray(v) ? v.filter((s) => s && NAMES[s.ex] && Number.isFinite(s.start)) : [];
})();

function saveSet(set) {
  const now = performance.now(), wall = Date.now();
  const at = (ts) => Math.round(wall - (now - ts)); // tracker time → wall clock
  log.push({
    ex: set.ex, reps: set.reps, partials: set.partials, holdMs: Math.round(set.holdMs),
    paceMs: set.paceMs, start: at(set.t0), end: at(set.t1),
  });
  if (!store.set(LOG_KEY, log)) toast("Couldn't save to this phone's storage");
}

// ---------- formatting ----------
const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const spokenTime = (ms) => {
  const s = Math.round(ms / 1000), m = Math.floor(s / 60), r = s % 60;
  return m ? `${m} minute${m > 1 ? 's' : ''}${r ? ` ${r} seconds` : ''}` : `${s} seconds`;
};
const dayKey = (ms) => new Date(ms).toDateString();
const value = (ex, n) => (ex === 'plank' ? clock(n) : String(n));
function totals(sets) {
  const t = {};
  for (const s of sets) t[s.ex] = (t[s.ex] ?? 0) + (s.ex === 'plank' ? s.holdMs : s.reps);
  return t;
}

// ---------- voice ----------
const voice = {
  synth: 'speechSynthesis' in window ? window.speechSynthesis : null,
  muted: store.get('reps.muted', false) === true,
  v: null,
  pick() {
    const all = this.synth?.getVoices() ?? [];
    const en = all.filter((v) => /^en/i.test(v.lang));
    this.v = en.find((v) => v.localService && /samantha|daniel|karen|moira|aaron|google us/i.test(v.name))
      ?? en.find((v) => v.localService) ?? en[0] ?? null;
  },
  unlock() { // iOS only lets a page speak after it has spoken inside a tap
    if (!this.synth) return;
    this.pick();
    this.synth.addEventListener?.('voiceschanged', () => this.pick());
    const u = new SpeechSynthesisUtterance(this.muted ? ' ' : "Let's go");
    u.volume = this.muted ? 0 : 1;
    this.synth.speak(u);
  },
  say(text, urgent = false) {
    if (this.muted || !this.synth) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.15;
    u.lang = this.v?.lang ?? 'en-US';
    if (this.v) u.voice = this.v;
    if (urgent && (this.synth.speaking || this.synth.pending)) {
      this.synth.cancel(); // a new rep number beats a stale one
      setTimeout(() => this.synth.speak(u), 40); // Chrome drops a speak() issued in the same tick as cancel()
    } else this.synth.speak(u);
  },
};

// ---------- pose model ----------
const FILES = {
  model: 'models/pose_landmarker_full.task',
  loader: 'vendor/mediapipe/wasm/vision_wasm_internal.js',
  wasm: 'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
};
const EXPECTED_BYTES = 9398198 + 14603354;

async function fetchBytes(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  if (!res.body) {
    const all = new Uint8Array(await res.arrayBuffer());
    onBytes(all.length);
    return all;
  }
  const reader = res.body.getReader(), chunks = [];
  let n = 0;
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
    n += chunk.length;
    onBytes(chunk.length);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

let landmarker = null, delegate = 'GPU', fileset = null, modelBytes = null;
async function createLandmarker(which) {
  const lm = await PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: new Uint8Array(modelBytes), delegate: which },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  delegate = which;
  return lm;
}

const ready = (async () => {
  let got = 0;
  const tick = (n) => { got += n; progress(Math.min(0.99, got / EXPECTED_BYTES)); };
  const [model, wasm] = await Promise.all([fetchBytes(FILES.model, tick), fetchBytes(FILES.wasm, tick)]);
  modelBytes = model;
  fileset = {
    wasmLoaderPath: new URL(FILES.loader, location.href).href,
    wasmBinaryPath: URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })), // reuse the bytes we already have
  };
  try {
    landmarker = await createLandmarker('GPU');
  } catch (e) {
    console.warn('GPU pose tracking unavailable, using CPU', e);
    landmarker = await createLandmarker('CPU');
  }
  progress(1);
})();
ready.catch((e) => {
  console.error(e);
  setStatus("Couldn't load the body tracker. Check your connection and reload.", true);
});

// ---------- camera ----------
let facing = store.get('reps.facing', 'user') === 'environment' ? 'environment' : 'user';
let stream = null;

async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('no camera API'), { name: 'NoApi' });
  stream?.getTracks().forEach((t) => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  });
  video.srcObject = stream;
  await video.play();
  const mirror = facing === 'user';
  video.classList.toggle('mirror', mirror);
  canvas.classList.toggle('mirror', mirror);
}

async function openFile(src) {
  video.srcObject = null;
  video.src = src;
  video.loop = !params.has('once');
  await video.play();
}

function cameraError(e) {
  switch (e.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera access is blocked. Allow the camera for this site (iPhone: Settings → Apps → Safari → Camera), then reload.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found on this device.';
    case 'NotReadableError':
      return 'The camera is busy in another app. Close it and try again.';
    case 'NoApi':
      return "This browser can't use the camera here. Open the link in Safari or Chrome.";
    default:
      return `Couldn't start the camera (${e.name || e.message}).`;
  }
}

// ---------- main loop ----------
let tracker = new Tracker({ aspect: 16 / 9 });
let lock = null;
let running = false, lastTs = 0, fails = 0;
const lastSet = { ex: null, text: '' }; // shown dimmed while resting

// One callback per new camera frame where supported; otherwise animation frames capped near 30 fps.
const perFrame = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
const schedule = () => (perFrame ? video.requestVideoFrameCallback(frame) : requestAnimationFrame(frame));

function frame() {
  if (!running) return;
  schedule();
  if (video.readyState < 2 || (!perFrame && performance.now() - lastTs < 30)) return;
  const ts = Math.max(lastTs + 1, performance.now()); // MediaPipe needs strictly increasing timestamps
  lastTs = ts;
  let res;
  const t0 = performance.now();
  try {
    res = landmarker.detectForVideo(video, ts);
    fails = 0;
  } catch (e) {
    if (++fails === 5) fallBack(e);
    return;
  }
  const inferMs = performance.now() - t0;
  if (video.videoWidth) tracker.aspect = video.videoWidth / video.videoHeight;
  const image = res.landmarks?.[0] ?? null;
  const world = res.worldLandmarks?.[0] ?? null;
  handle(tracker.update(ts, world, image));
  const v = tracker.view(ts);
  draw(image, v.ex);
  render(v, ts);
  if (DEBUG) debug(inferMs);
}

async function fallBack(err) {
  console.warn(`Pose tracking failed on ${delegate}`, err);
  if (delegate === 'CPU') return setFatal('The body tracker stopped on this device. Reload to try again.');
  running = false;
  try {
    landmarker.close();
    landmarker = await createLandmarker('CPU');
    fails = 0;
    running = true;
    schedule();
  } catch (e) {
    setFatal('The body tracker stopped on this device. Reload to try again.');
  }
}

// ---------- engine events → voice, log, HUD ----------
window.__reps = { events: [], get tracker() { return tracker; } }; // read by the end-to-end test

function handle(events) {
  for (const e of events) {
    const rec = window.__reps.events;
    rec.push(e);
    if (rec.length > 500) rec.shift();
    switch (e.type) {
      case 'rep':
        voice.say(e.first ? `${NAMES[e.ex]}, ${e.n}` : String(e.n), true);
        navigator.vibrate?.(30);
        bump();
        break;
      case 'start':
        if (e.ex === 'plank') voice.say('Plank', true);
        break;
      case 'hold':
        voice.say(`${Math.round(e.ms / 1000)} seconds`, true);
        break;
      case 'partial':
        toast('Half rep');
        break;
      case 'cue':
        toast(e.text);
        voice.say(e.text);
        break;
      case 'set':
        saveSet(e.set);
        lastSet.ex = e.set.ex;
        lastSet.text = value(e.set.ex, e.set.ex === 'plank' ? e.set.holdMs : e.set.reps);
        voice.say(e.set.ex === 'plank'
          ? `Plank done, ${spokenTime(e.set.holdMs)}`
          : `Set done, ${e.set.reps} ${NAMES[e.set.ex].toLowerCase()}`);
        break;
    }
  }
}

// ---------- rendering ----------
const ui = {
  exBtn: $('exercise'), exName: $('exName'), count: $('count'), detail: $('detail'),
  meter: $('meter'), fill: $('meter').firstElementChild, hint: $('hint'), today: $('today'),
};
const put = (el, text) => { if (el.textContent !== text) el.textContent = text; };
let hintText = '', hintSince = 0;

function render(v, ts) {
  const active = v.reps > 0 || v.holdMs > 0;
  const resting = !active && v.restMs !== null && lastSet.ex;
  put(ui.exName, v.ex ? NAMES[v.ex] : resting ? NAMES[lastSet.ex] : 'Auto-detect');
  ui.exBtn.classList.toggle('locked', !!lock);

  let count = '0', detail;
  if (active) {
    count = value(v.ex, v.ex === 'plank' ? v.holdMs : v.reps);
    const bits = v.ex === 'plank' ? ['Hold it'] : [`Set ${setsToday(v.ex) + 1}`];
    if (v.ex !== 'plank' && v.reps > 1 && v.paceMs) bits.push(`${(v.paceMs / 1000).toFixed(1)} s/rep`);
    if (v.partials) bits.push(`${v.partials} half`);
    detail = bits.join(' · ');
  } else if (resting) {
    count = lastSet.text;
    detail = `Rest ${clock(v.restMs)}`;
  } else {
    detail = lock ? `Counting ${NAMES[lock].toLowerCase()} only` : "Start moving, I'll pick it up";
  }
  put(ui.count, count);
  ui.count.classList.toggle('dim', !active);
  put(ui.detail, detail);

  const meter = v.depth !== null && v.ex !== 'plank' && (active || v.depth > 0.35);
  ui.meter.hidden = !meter;
  if (meter) {
    ui.fill.style.height = `${Math.min(1, v.depth / 1.25) * 100}%`;
    ui.meter.classList.toggle('deep', v.depth >= 1);
  }

  // Only nag about framing once it has lasted, so a single bad frame doesn't flash a message.
  const want = v.lost ? 'Step into the frame' : v.framing && !active ? 'Move back so your whole body fits' : '';
  if (want !== hintText) { hintText = want; hintSince = ts; }
  const show = !!hintText && ts - hintSince > 1500;
  if (show) put(ui.hint, hintText);
  ui.hint.classList.toggle('show', show);

  renderToday(v);
}

function setsToday(ex) {
  const today = dayKey(Date.now());
  return log.filter((s) => s.ex === ex && dayKey(s.start) === today).length;
}

function renderToday(v) {
  const today = dayKey(Date.now());
  const t = totals(log.filter((s) => dayKey(s.start) === today));
  if (v?.ex && (v.reps || v.holdMs)) t[v.ex] = (t[v.ex] ?? 0) + (v.ex === 'plank' ? v.holdMs : v.reps);
  const html = EXERCISES.filter((ex) => t[ex]).map((ex) => `<li>${NAMES[ex]} <b>${value(ex, t[ex])}</b></li>`).join('');
  if (ui.today.dataset.html !== html) { ui.today.dataset.html = html; ui.today.innerHTML = html; }
}

function bump() {
  ui.count.classList.remove('bump');
  void ui.count.offsetWidth; // restart the animation
  ui.count.classList.add('bump');
}

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

// ---------- skeleton overlay ----------
const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32]];
const JOINTS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
const LEGS = [23, 24, 25, 26, 27, 28], ARMS = [11, 12, 13, 14, 15, 16], CORE = [0, 7, 8, 11, 12, 23, 24];
const FOCUS = {
  pushup: ARMS, squat: LEGS, lunge: LEGS, situp: CORE, crunch: CORE,
  jack: [...ARMS, ...LEGS], plank: [11, 12, 23, 24, 25, 26, 27, 28],
};

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function draw(pose, ex) {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  if (!pose || !video.videoWidth) return;
  // Landmarks are normalized to the video frame; the video is cover-fitted to the screen.
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(innerWidth / vw, innerHeight / vh);
  const ox = (innerWidth - vw * s) / 2, oy = (innerHeight - vh * s) / 2;
  const x = (p) => ox + p.x * vw * s, y = (p) => oy + p.y * vh * s;
  const focus = new Set(FOCUS[ex] ?? []);
  ctx.lineCap = 'round';
  for (const [a, b] of BONES) {
    const pa = pose[a], pb = pose[b];
    const vis = Math.min(pa.visibility ?? 1, pb.visibility ?? 1);
    if (vis < 0.35) continue;
    const hot = focus.has(a) && focus.has(b);
    ctx.strokeStyle = hot ? `rgba(62, 240, 138, ${0.55 + 0.45 * vis})` : `rgba(255, 255, 255, ${0.3 + 0.4 * vis})`;
    ctx.lineWidth = hot ? 7 : 4;
    ctx.beginPath();
    ctx.moveTo(x(pa), y(pa));
    ctx.lineTo(x(pb), y(pb));
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  for (const i of JOINTS) {
    const p = pose[i];
    if ((p.visibility ?? 1) < 0.35) continue;
    ctx.beginPath();
    ctx.arc(x(p), y(p), i === 0 ? 7 : 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------- debug readout (?debug) ----------
let fpsT = performance.now(), fpsN = 0, fps = 0;
function debug(inferMs) {
  fpsN++;
  const now = performance.now();
  if (now - fpsT >= 1000) { fps = fpsN; fpsN = 0; fpsT = now; }
  const f = tracker.f;
  const el = $('debug');
  el.hidden = false;
  el.textContent = `${fps} fps · ${inferMs.toFixed(0)} ms · ${delegate} · ${video.videoWidth}×${video.videoHeight}`
    + (f ? `\nelbow ${f.elbow.toFixed(0)} knee ${f.knee.toFixed(0)} incl ${f.incl.toFixed(0)} hipH ${f.hipH.toFixed(2)} ear ${f.earLift.toFixed(2)}` : '');
}

// ---------- start screen ----------
function progress(p) {
  $('bar').style.width = `${Math.round(p * 100)}%`;
  if (p < 1) setStatus(`Downloading body tracker… ${Math.round(p * 100)}%`);
  else if (!running) setStatus('Ready when you are.');
}
function setStatus(text, error = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('error', error);
}
function setFatal(text) {
  running = false;
  $('start').hidden = false;
  setStatus(text, true);
}

const go = $('go');
go.disabled = false;
go.textContent = 'Start';
go.addEventListener('click', async () => {
  voice.unlock();
  keepAwake();
  go.disabled = true;
  go.textContent = 'Starting…';
  try {
    await (SRC ? openFile(SRC) : openCamera());
  } catch (e) {
    go.disabled = false;
    go.textContent = 'Try again';
    return setStatus(cameraError(e), true);
  }
  try {
    await ready;
  } catch {
    go.textContent = 'Start';
    return; // status already explains
  }
  $('start').hidden = true;
  navigator.storage?.persist?.().catch(() => {});
  running = true;
  schedule();
});

const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
$('install').hidden = !(iOS && !standalone);

// ---------- controls ----------
$('sound').setAttribute('aria-pressed', String(!voice.muted));
$('sound').addEventListener('click', () => {
  voice.muted = !voice.muted;
  store.set('reps.muted', voice.muted);
  $('sound').setAttribute('aria-pressed', String(!voice.muted));
  if (voice.muted) voice.synth?.cancel();
  else voice.say('Voice on');
});

$('flip').addEventListener('click', async () => {
  if (SRC) return;
  facing = facing === 'user' ? 'environment' : 'user';
  store.set('reps.facing', facing);
  try {
    await openCamera();
  } catch (e) {
    toast(cameraError(e));
  }
});

const CHOICES = [[null, 'Auto-detect', 'Works it out'], ...EXERCISES.map((ex) => [ex, NAMES[ex], ''])];
$('exercise').addEventListener('click', () => {
  const box = $('choices');
  box.replaceChildren();
  for (const [ex, label, sub] of CHOICES) {
    const b = document.createElement('button');
    b.setAttribute('aria-current', String(ex === lock));
    b.textContent = label;
    if (sub) b.append(Object.assign(document.createElement('small'), { textContent: sub }));
    b.addEventListener('click', () => setLock(ex));
    box.append(b);
  }
  $('picker').showModal();
});

function setLock(ex) {
  if (ex === lock) return;
  handle(tracker.finish(performance.now())); // bank the open set first
  lock = ex;
  tracker = new Tracker({ lock, aspect: tracker.aspect });
  lastSet.ex = null;
}

$('logBtn').addEventListener('click', openLog);
$('startLog').addEventListener('click', openLog);
function openLog() {
  const body = $('logBody');
  body.replaceChildren();
  if (!log.length) {
    body.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: 'No sets yet. Finished sets land here.' }));
  }
  const days = new Map();
  for (const s of [...log].reverse()) {
    const k = dayKey(s.start);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(s);
  }
  for (const sets of days.values()) {
    const day = document.createElement('section');
    day.className = 'day';
    const h = document.createElement('h3');
    h.textContent = new Date(sets[0].start).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    const t = totals(sets);
    const p = document.createElement('p');
    p.className = 'totals';
    p.innerHTML = EXERCISES.filter((ex) => t[ex]).map((ex) => `${NAMES[ex]} <b>${value(ex, t[ex])}</b>`).join(' · ');
    const table = document.createElement('table');
    for (const s of sets) {
      const row = table.insertRow();
      const time = new Date(s.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      row.insertCell().textContent = `${time} · ${NAMES[s.ex]}`;
      row.insertCell().textContent = s.ex === 'plank'
        ? clock(s.holdMs)
        : `${s.reps}${s.partials ? ` (+${s.partials} half)` : ''}${s.paceMs ? ` · ${(s.paceMs / 1000).toFixed(1)} s/rep` : ''}`;
    }
    day.append(h, p, table);
    body.append(day);
  }
  $('log').showModal();
}

$('export').addEventListener('click', async () => {
  const rows = [['date', 'time', 'exercise', 'reps', 'half_reps', 'hold_seconds', 'seconds_per_rep']];
  for (const s of log) {
    const d = new Date(s.start);
    const plank = s.ex === 'plank';
    rows.push([
      d.toLocaleDateString('en-CA'), d.toTimeString().slice(0, 5), NAMES[s.ex],
      plank ? '' : s.reps, plank ? '' : s.partials, plank ? Math.round(s.holdMs / 1000) : '',
      s.paceMs && !plank ? (s.paceMs / 1000).toFixed(2) : '',
    ]);
  }
  const name = `reps-${new Date().toLocaleDateString('en-CA')}.csv`;
  const file = new File([rows.map((r) => r.join(',')).join('\n') + '\n'], name, { type: 'text/csv' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Reps log' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

$('clear').addEventListener('click', () => {
  if (!log.length || !confirm('Delete your whole workout history from this phone? This can’t be undone.')) return;
  log = [];
  store.set(LOG_KEY, log);
  openLog();
});

// ---------- keep the screen on; bank the set if the app goes to the background ----------
let wake = null;
async function keepAwake() {
  try {
    wake = await navigator.wakeLock?.request('screen');
  } catch {
    // not supported or not allowed: the phone may dim, counting still works
  }
}
document.addEventListener('visibilitychange', () => {
  if (!running) return;
  if (document.hidden) handle(tracker.finish(performance.now()));
  else {
    keepAwake();
    if (video.paused) video.play().catch(() => {});
  }
});
window.addEventListener('pagehide', () => { if (running) handle(tracker.finish(performance.now())); });

if ('serviceWorker' in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('offline cache unavailable', e));
}
renderToday(null);
