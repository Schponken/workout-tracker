// Rep-counting engine: MediaPipe pose landmarks in, workout events out.
// Pure (no DOM) so the same code runs on the phone and in Node tests.
// Thresholds were tuned on real footage (front, side and 3/4 views): see test/clips.test.js.

export const NAMES = {
  pushup: 'Pushups', squat: 'Squats', lunge: 'Lunges', situp: 'Sit-ups',
  crunch: 'Crunches', jack: 'Jumping jacks', plank: 'Plank',
};
export const EXERCISES = Object.keys(NAMES);

// ---------- geometry ----------
const DEG = 180 / Math.PI;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const len = (u) => Math.hypot(u[0], u[1], u[2]);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

/** Angle at b (degrees) between b→a and b→c. */
export function angle(a, b, c) {
  const u = sub(a, b), v = sub(c, b), d = len(u) * len(v);
  return d ? Math.acos(clamp(dot(u, v) / d, -1, 1)) * DEG : NaN;
}

function angle2d(a, b, c, aspect) {
  const ux = (a.x - b.x) * aspect, uy = a.y - b.y, vx = (c.x - b.x) * aspect, vy = c.y - b.y;
  const d = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  return d ? Math.acos(clamp((ux * vx + uy * vy) / d, -1, 1)) * DEG : NaN;
}

// Visibility-weighted blend of a left/right measurement; the hidden side of a side-on body is a guess.
function blend(l, r, vl, vr) {
  const wl = vl * vl, wr = vr * vr;
  return wl + wr ? (l * wl + r * wr) / (wl + wr) : (l + r) / 2;
}

/**
 * Per-frame body features. `world` = MediaPipe worldLandmarks (metres, y down),
 * `image` = normalized landmarks (visibility, in-frame checks, 2D angles), aspect = frame width / height.
 */
export function features(world, image, aspect = 1) {
  const w = (i) => world[i];
  const vis = (i) => {
    const p = image[i];
    const inFrame = p.x > -0.05 && p.x < 1.05 && p.y > -0.05 && p.y < 1.05;
    return (p.visibility ?? 1) * (inFrame ? 1 : 0.25);
  };
  const side = (sh, el, wr, hip, kn, an) => ({
    // From the front, depth squashes the 3D elbow estimate; the 2D bend is the better read there.
    elbow: Math.min(angle(w(sh), w(el), w(wr)), angle2d(image[sh], image[el], image[wr], aspect)),
    knee: angle(w(hip), w(kn), w(an)),
    raise: angle(w(hip), w(sh), w(el)),
    arm: Math.min(vis(sh), vis(el), vis(wr)),
    leg: Math.min(vis(hip), vis(kn), vis(an)),
    legLen: len(sub(w(hip), w(kn))) + len(sub(w(kn), w(an))),
  });
  const L = side(11, 13, 15, 23, 25, 27), R = side(12, 14, 16, 24, 26, 28);

  const shM = mid(w(11), w(12)), hipM = mid(w(23), w(24)), knM = mid(w(25), w(26));
  const anM = mid(w(27), w(28)), wrM = mid(w(15), w(16)), elM = mid(w(13), w(14)), earM = mid(w(7), w(8));
  const torso = sub(shM, hipM), torsoLen = len(torso) || 1;
  const legLen = (L.legLen + R.legLen) / 2 || 1;

  // Feet split front/back (lunge) vs side by side (squat): ankle gap across the hip axis, on the floor plane.
  const ha = [w(23).x - w(24).x, w(23).z - w(24).z], hl = Math.hypot(ha[0], ha[1]) || 1;
  const ag = [w(27).x - w(28).x, w(27).z - w(28).z], gap = Math.hypot(ag[0], ag[1]);
  const along = (ag[0] * ha[0] + ag[1] * ha[1]) / hl;

  // Hip bend off the shoulder–ankle line: + sagging toward the floor, − piked up.
  const sa = sub(anM, shM), s = dot(sub(hipM, shM), sa) / (dot(sa, sa) || 1);
  const sag = Math.sign(hipM.y - (shM.y + s * sa[1])) * (180 - angle(shM, hipM, anM));

  return {
    elbow: blend(L.elbow, R.elbow, L.arm, R.arm),
    knee: blend(L.knee, R.knee, L.leg, R.leg),
    kneeMin: Math.min(L.knee, R.knee),
    raise: blend(L.raise, R.raise, L.arm, R.arm),
    armV: Math.max(L.arm, R.arm),
    armsV: Math.min(L.arm, R.arm),
    legV: Math.max(L.leg, R.leg),
    torsoV: Math.min(Math.max(vis(11), vis(12)), Math.max(vis(23), vis(24))),
    incl: Math.acos(clamp(-torso[1] / torsoLen, -1, 1)) * DEG, // 0 upright, 90 lying, ~180 head down
    hipH: (Math.max(w(27).y, w(28).y) - hipM.y) / legLen, // ~1 standing, ~0.45 deep squat, ~0 lying
    kneeUp: (hipM.y - knM.y) / legLen,
    wristDrop: (wrM.y - shM.y) / torsoLen,
    elbowDrop: (elM.y - shM.y) / torsoLen,
    earLift: (hipM.y - earM.y) / torsoLen, // ~0 lying flat, ~0.3 crunch, ~1.4 sitting up
    split: Math.sqrt(Math.max(0, gap * gap - along * along)) / legLen,
    gap: gap / legLen,
    sag: Number.isFinite(sag) ? sag : 0,
  };
}

// Leg-derived features are guesses when the legs are hidden; checks on them pass in that case.
const legsSeen = (f) => f.legV >= 0.5;
const prone = (f) => f.incl > 50 && f.wristDrop > 0.3; // weight on the hands

// ---------- smoothing ----------
/** One Euro filter: smooth when still, low lag when moving fast. Times in ms. */
export class OneEuro {
  constructor(minCutoff = 1.2, beta = 1.5, dCutoff = 1) {
    Object.assign(this, { minCutoff, beta, dCutoff });
    this.reset();
  }
  reset() { this.t = null; }
  filter(x, t) {
    if (this.t === null) { this.t = t; this.x = x; this.dx = 0; return x; }
    const dt = Math.max(1e-3, (t - this.t) / 1000);
    this.t = t;
    const alpha = (fc) => { const r = 2 * Math.PI * fc * dt; return r / (r + 1); };
    this.dx += alpha(this.dCutoff) * ((x - this.x) / dt - this.dx);
    this.x += alpha(this.minCutoff + this.beta * Math.abs(this.dx)) * (x - this.x);
    return this.x;
  }
}

// ---------- detectors ----------
// measure(f) → depth: 0 at the resting pose, 1 at full depth. A rep leaves rest (depth >= start) and comes back
// (depth <= back, or 75% of the way back up from a deep bottom). Peak >= 1 is a full rep; peak >= partial is a half rep. Posture gates are judged
// over the deep part of the rep, so the steps of a walking lunge don't spoil it.
const median = (xs) => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[v.length >> 1] : NaN;
};

const DEFS = {
  pushup: {
    measure: (f) => (150 - f.elbow) / 50, conf: (f) => f.armV, minConf: 0.2,
    gate: (f) => prone(f) && (!legsSeen(f) || f.kneeUp < 0.15),
    extra: (f) => (f.torsoV >= 0.6 && legsSeen(f) ? f.sag : NaN),
    finish: (r, deep) => ({ sag: median(deep.map((x) => x[2])) }),
    minMs: 450, maxMs: 6000, cue: 'Go lower',
  },
  legs: { // squats and lunges; the stance at the bottom says which
    measure: (f) => 0.5 * (165 - f.knee) / 60 + 0.5 * (0.95 - f.hipH) / 0.23, conf: (f) => f.legV,
    gate: (f) => f.incl < 60 && f.hipH > 0.25,
    extra: (f) => f.split,
    finish: (r, deep) => ({ ex: median(deep.map((x) => x[2])) >= 0.35 ? 'lunge' : 'squat' }),
    partial: 0.4, minMs: 600, maxMs: 9000, cue: 'Go lower',
  },
  situp: { // sit-ups and crunches; how high the head gets says which
    measure: (f) => f.earLift / 0.22, conf: (f) => f.torsoV, minConf: 0.5, // hips must really be seen
    gate: (f) => !prone(f) && (!legsSeen(f) || f.hipH < 0.45),
    rest: (f) => f.incl > 55,
    extra: (f) => f.earLift,
    finish: (r, deep, all) => ({ ex: Math.max(...all.map((x) => x[2])) >= 0.9 ? 'situp' : 'crunch' }),
    back: 0.65, backMax: 0.65, start: 0.85, partial: 1, minMs: 600, maxMs: 8000, cue: 'All the way up',
  },
  jack: {
    measure: (f) => (f.raise - 30) / 110, conf: (f) => f.armsV, minConf: 0.3,
    gate: (f) => f.incl < 30 && f.hipH > 0.75,
    extra: (f) => f.gap,
    finish: (r, deep, all) => {
      const g = all.map((x) => x[2]);
      return Math.max(...g) - Math.min(...g) >= 0.25 ? {} : null; // feet must jump out, not just arms
    },
    minMs: 300, maxMs: 3000, cue: 'Arms all the way up',
  },
};

const LOST_MS = 1500, GATED = 0.7;

export class RepDetector {
  constructor(id, def = DEFS[id]) {
    Object.assign(this, { back: 0.2, backMax: 0.33, start: 0.35, partial: 0.5, minConf: 0.1 }, def, { id });
    this.filt = new OneEuro();
    this.reset();
  }
  reset() {
    this.state = 'idle';
    this.rep = null;
    this.depth = 0;
    this.restT = 0;
    this.gateOk = false;
    this.seenT = -Infinity;
    this.filt.reset();
  }
  /** Feed one frame (f = features or null). Returns a rep/partial event or null. */
  update(t, f, relaxed = false) {
    const raw = f && this.conf(f) >= this.minConf ? this.measure(f) : NaN;
    if (!Number.isFinite(raw)) {
      if (t - this.seenT > LOST_MS) this.reset();
      return null;
    }
    if (t - this.seenT > LOST_MS) this.reset();
    this.seenT = t;
    const d = this.filt.filter(raw, t);
    const ok = relaxed || this.gate(f);
    this.depth = d;
    this.gateOk = ok;

    if (this.state === 'idle') {
      if (d <= this.back && ok && (relaxed || !this.rest || this.rest(f))) { this.state = 'rest'; this.restT = t; }
      return null;
    }
    if (this.state === 'rest') {
      if (d <= this.back) { this.restT = t; return null; }
      if (d < this.start) return null;
      this.state = 'move';
      this.rep = { t0: this.restT, peak: d, tPeak: t, frames: [] };
    }
    const r = this.rep;
    r.frames.push([d, ok ? 1 : 0, this.extra ? this.extra(f) : 0]);
    if (d > r.peak) { r.peak = d; r.tPeak = t; }
    if (t - r.t0 > this.maxMs) { this.state = 'idle'; this.rep = null; return null; }
    if (d > Math.min(this.backMax, Math.max(this.back, 0.25 * r.peak))) return null;

    this.state = 'rest';
    this.restT = t;
    this.rep = null;
    const dur = t - r.t0;
    const cut = Math.max(this.start, 0.6 * r.peak);
    const deep = r.frames.filter((x) => x[0] >= cut);
    if (dur < this.minMs || deep.reduce((s, x) => s + x[1], 0) < deep.length * GATED) return null;
    const type = r.peak >= 1 ? 'rep' : r.peak >= this.partial ? 'partial' : null;
    const more = type && (this.finish ? this.finish(r, deep, r.frames) : {});
    return more && { type, ex: this.id, t, dur, down: r.tPeak - r.t0, up: t - r.tPeak, peak: r.peak, ...more };
  }
}

// Plank: held still, body straight and roughly horizontal, weight on hands or forearms.
function plankPose(f) {
  if (!(f.incl > 55 && (f.wristDrop > 0.3 || f.elbowDrop > 0.15))) return false;
  if (!legsSeen(f)) return true;
  if (f.kneeMin < 140 || f.kneeUp > 0.1) return false;
  return f.torsoV < 0.6 || (Math.abs(f.sag) < 35 && f.incl < 120); // not a downward dog
}

// ---------- tracker: arbitration, sets, cues ----------
// Seconds per rep: rep-to-rep cadence across the set (the first rep's own duration stands in until there's a second).
const pace = (s) => (!s?.reps ? 0 : s.reps === 1 ? s.repMs : (s.lastT - s.firstT) / s.reps);
const DETECTOR_OF = { pushup: 'pushup', squat: 'legs', lunge: 'legs', situp: 'situp', crunch: 'situp', jack: 'jack', plank: null };

export class Tracker {
  /**
   * lock: null to auto-detect, or an exercise id to count only that one.
   * restMs: a set ends after this long without a rep. aspect: video width / height.
   */
  constructor({ lock = null, restMs = 10000, aspect = 1 } = {}) {
    this.lock = lock;
    this.restMs = restMs;
    this.aspect = aspect;
    this.dets = Object.fromEntries(Object.keys(DEFS).map((id) => [id, new RepDetector(id)]));
    this.set = null;
    this.pending = null;
    this.hold = null;
    this.lastEnd = null;
    this.seenT = -Infinity;
    this.cueAt = {};
    this.lastCueT = -Infinity;
    this.f = null;
  }

  /** Feed one frame. world/image are one pose's MediaPipe landmark arrays (or null when nobody is in view). */
  update(t, world, image) {
    const out = [];
    const f = world && image ? features(world, image, this.aspect) : null;
    this.f = f;
    if (f) this.seenT = t;
    const only = this.lock && DETECTOR_OF[this.lock];
    for (const [id, det] of Object.entries(this.dets)) {
      if (this.lock && id !== only) continue;
      const ev = det.update(t, f, !!this.lock);
      if (ev) this.#onEvent(t, this.#classify(ev), out);
    }
    if (!this.lock || this.lock === 'plank') this.#updateHold(t, f, out);
    if (this.set && this.set.ex !== 'plank' && t - this.set.lastT > this.restMs) this.#close(t, out);
    return out;
  }

  /** Close any open set (e.g. the user tapped stop). */
  finish(t) {
    const out = [];
    if (this.set) this.#close(t, out);
    this.hold = null;
    return out;
  }

  /** Snapshot for the UI. */
  view(t) {
    const s = this.set;
    const det = this.#meterDet();
    return {
      ex: s?.ex ?? this.lock,
      reps: s?.reps ?? 0,
      partials: s?.partials ?? 0,
      holdMs: s?.ex === 'plank' ? s.holdMs : 0,
      setMs: s ? t - s.t0 : 0,
      paceMs: pace(s),
      depth: det ? clamp(det.depth, 0, 1.25) : null,
      restMs: !s && this.lastEnd !== null ? t - this.lastEnd : null,
      lost: t - this.seenT > 1000,
      framing: !!this.f && (this.f.torsoV < 0.3 || this.f.armV < 0.3),
    };
  }

  #meterDet() {
    const ex = this.set?.ex ?? this.lock;
    if (ex === 'plank') return null;
    if (ex) return this.dets[DETECTOR_OF[ex]];
    let best = null;
    for (const d of Object.values(this.dets)) {
      if (d.state === 'move' && d.gateOk && (!best || d.depth > best.depth)) best = d;
    }
    return best;
  }

  // Map a detector event onto the exercise being done (sit-up vs crunch, squat vs lunge, locks).
  #classify(ev) {
    const want = this.lock ?? this.set?.ex;
    if (ev.ex === 'situp' || ev.ex === 'crunch') {
      if (want === 'crunch') return { ...ev, ex: 'crunch' };
      if (want === 'situp' && ev.ex === 'crunch') return { ...ev, type: 'partial', ex: 'situp' };
    }
    if (this.lock && DETECTOR_OF[this.lock] === DETECTOR_OF[ev.ex]) return { ...ev, ex: this.lock };
    return ev;
  }

  #onEvent(t, ev, out) {
    const s = this.set;
    if (ev.type === 'partial') {
      if (s?.ex !== ev.ex && this.lock !== ev.ex) return; // half reps only matter mid-set
      const set = s ?? this.#open(t, ev.ex, out);
      set.partials++;
      set.lastT = t;
      out.push({ type: 'partial', ex: ev.ex, n: set.partials });
      this.#cue(t, DEFS[DETECTOR_OF[ev.ex]].cue, out);
      return;
    }
    let carry = null;
    if (s && s.ex !== ev.ex) {
      if (s.ex !== 'plank' && s.reps >= 2) {
        // Leaving an established set needs two reps in a row, so one stray movement can't split it.
        if (this.pending?.ex !== ev.ex || t - this.pending.t > this.restMs) {
          this.pending = { ex: ev.ex, t, ev };
          return;
        }
        carry = this.pending.ev;
      }
      this.#close(t, out);
    }
    const set = this.set ?? this.#open(t, ev.ex, out);
    if (s?.ex === ev.ex) this.pending = null;
    for (const e of carry ? [carry, ev] : [ev]) {
      set.reps++;
      set.repMs += e.dur;
      set.firstT ??= t - e.dur;
      set.lastT = t;
      out.push({ type: 'rep', ex: ev.ex, n: set.reps, dur: e.dur, first: set.reps === 1 || !!carry });
    }
    if (ev.ex === 'pushup' && ev.sag > 18) this.#cue(t, 'Hips up', out);
    else if (ev.ex === 'pushup' && ev.sag < -25) this.#cue(t, 'Hips down', out);
  }

  #updateHold(t, f, out) {
    // Moving (a pushup under way) ends a hold at once; the 1 s grace is only for pose flicker.
    const moving = Object.values(this.dets).some((d) => d.state === 'move');
    if (f && plankPose(f) && !moving) {
      if (this.hold && t - this.hold.lastOk > 1000) { // lost the body for a while: that hold is over
        if (this.set?.ex === 'plank') this.#close(this.hold.lastOk, out);
        this.hold = null;
      }
      if (!this.hold) this.hold = { t0: t, lastOk: t, sagT: null };
      const h = this.hold;
      h.lastOk = t;
      h.sagT = f.torsoV >= 0.6 && legsSeen(f) && Math.abs(f.sag) > 15 ? h.sagT ?? t : null;
    } else if (this.hold && (moving || t - this.hold.lastOk > 1000)) {
      if (this.set?.ex === 'plank') this.#close(this.hold.lastOk, out);
      this.hold = null;
    }
    const h = this.hold;
    if (!h) return;
    const ms = h.lastOk - h.t0;
    if (this.set?.ex !== 'plank') {
      if (ms < (this.set ? 6000 : 3000)) return; // longer when it might be a pause between pushups
      if (this.set) this.#close(t, out);
      this.#open(h.t0, 'plank', out);
    }
    const set = this.set;
    const before = Math.floor(set.holdMs / 10000);
    set.holdMs = ms;
    set.lastT = t;
    if (Math.floor(ms / 10000) > before) out.push({ type: 'hold', ex: 'plank', ms });
    if (h.sagT !== null && t - h.sagT > 1500) this.#cue(t, f.sag > 0 ? 'Hips up' : 'Hips down', out);
  }

  #open(t, ex, out) {
    this.set = { ex, t0: t, reps: 0, partials: 0, repMs: 0, holdMs: 0, lastT: t };
    this.lastEnd = null;
    out.push({ type: 'start', ex });
    return this.set;
  }

  #close(t, out) {
    const s = this.set;
    this.set = null;
    this.pending = null;
    this.lastEnd = t;
    const real = s.ex === 'plank' ? s.holdMs >= 5000 : s.reps >= (this.lock ? 1 : 2);
    out.push(real
      ? { type: 'set', set: { ex: s.ex, reps: s.reps, partials: s.partials, holdMs: s.holdMs, t0: s.t0, t1: s.lastT, paceMs: Math.round(pace(s)) } }
      : { type: 'discard', ex: s.ex, reps: s.reps });
  }

  #cue(t, text, out) {
    if (t - this.lastCueT < 2500 || t - (this.cueAt[text] ?? -Infinity) < 6000) return;
    this.lastCueT = t;
    this.cueAt[text] = t;
    out.push({ type: 'cue', text });
  }
}
