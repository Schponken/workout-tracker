// Synthetic workout footage: a simple kinematic body rendered as MediaPipe-style landmarks
// (world: metres, y down, hip-centred; image: normalized, with visibility). Used where no real clip exists.

const S = { torso: 0.52, neck: 0.18, upper: 0.3, fore: 0.27, thigh: 0.45, shin: 0.43, shW: 0.19, hipW: 0.13 };
const rad = (d) => (d * Math.PI) / 180;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const add = (p, d, l = 1) => [p[0] + d[0] * l, p[1] + d[1] * l];
const dir = (deg) => [Math.sin(rad(deg)), Math.cos(rad(deg))]; // 0 = straight up, 90 = forward

// 2-link IK in the sagittal plane (X forward, Y up): joint between end `a` and root `b`, bending toward +X if bend > 0.
function ik(a, b, l1, l2, bend = 1) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const d = Math.min(Math.hypot(dx, dy), l1 + l2 - 1e-6);
  const A = Math.acos(clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  const t = Math.atan2(dy, dx) - bend * A;
  return [a[0] + l1 * Math.cos(t), a[1] + l1 * Math.sin(t)];
}

/** Standing / squatting. knee: knee angle, front/side: arm raise in degrees, spread: extra ankle gap (m). */
export function stand({ knee = 175, front = 0, side = 0, spread = 0 } = {}) {
  const bend = 180 - knee;
  const ankle = [0, 0.08];
  const kn = add(ankle, dir(0.35 * bend), S.shin);
  const hip = add(kn, dir(-0.65 * bend), S.thigh);
  const sh = add(hip, dir(0.45 * 0.65 * bend), S.torso);
  const ear = add(sh, dir(0.45 * 0.65 * bend), S.neck);
  const nose = add(ear, [0.09, -0.02]);
  const lat = (Z) => (p) => [...p, Z];
  const arm = (zs) => {
    const elbow = [sh[0] + S.upper * Math.sin(rad(front)) * Math.cos(rad(side)), sh[1] - S.upper * Math.cos(rad(front)) * Math.cos(rad(side))];
    const wrist = [sh[0] + (S.upper + S.fore) * Math.sin(rad(front)) * Math.cos(rad(side)), sh[1] - (S.upper + S.fore) * Math.cos(rad(front)) * Math.cos(rad(side))];
    const out = Math.sin(rad(side));
    return { el: [...elbow, zs * (S.shW + S.upper * out)], wr: [...wrist, zs * (S.shW + (S.upper + S.fore) * out)] };
  };
  const aL = arm(1), aR = arm(-1);
  const legZ = S.hipW + spread / 2, kneeZ = S.hipW + spread / 4; // straight legs swing out from the hip
  return {
    nose: lat(0)(nose), earL: lat(0.075)(ear), earR: lat(-0.075)(ear),
    shL: lat(S.shW)(sh), shR: lat(-S.shW)(sh), elL: aL.el, elR: aR.el, wrL: aL.wr, wrR: aR.wr,
    hipL: lat(S.hipW)(hip), hipR: lat(-S.hipW)(hip),
    knL: lat(kneeZ)(kn), knR: lat(-kneeZ)(kn), anL: lat(legZ)(ankle), anR: lat(-legZ)(ankle),
  };
}

/** Lunge: u = 0 standing in a split stance, 1 at the bottom. */
export function lunge({ u = 0 } = {}) {
  const front = [0.42, 0.08], back = [-0.48, 0.12];
  const hip = [0, 0.86 - 0.36 * u];
  const knF = ik(front, hip, S.shin, S.thigh, 1), knB = ik(back, hip, S.shin, S.thigh, 1);
  const sh = add(hip, dir(2), S.torso), ear = add(sh, dir(2), S.neck);
  const el = add(sh, dir(180), S.upper), wr = add(el, dir(180), S.fore);
  return {
    nose: [...add(ear, [0.09, -0.02]), 0], earL: [...ear, 0.075], earR: [...ear, -0.075],
    shL: [...sh, S.shW], shR: [...sh, -S.shW], elL: [...el, 0.22], elR: [...el, -0.22], wrL: [...wr, 0.22], wrR: [...wr, -0.22],
    hipL: [...hip, S.hipW], hipR: [...hip, -S.hipW], knL: [...knF, S.hipW], knR: [...knB, -S.hipW], anL: [...front, S.hipW], anR: [...back, -S.hipW],
  };
}

/** Pushup / high plank: elbow angle, sag = hips dropped (m, negative = piked). */
export function pushup({ elbow = 170, sag = 0 } = {}) {
  const wrist = [0, 0.03];
  const d = Math.sqrt(S.upper ** 2 + S.fore ** 2 - 2 * S.upper * S.fore * Math.cos(rad(elbow)));
  const sh = [0, wrist[1] + d];
  const el = ik(wrist, sh, S.fore, S.upper, 1); // elbows point back toward the feet
  const body = S.torso + S.thigh + S.shin;
  const ankle = [-Math.sqrt(body ** 2 - (sh[1] - 0.08) ** 2), 0.08];
  const along = [(ankle[0] - sh[0]) / body, (ankle[1] - sh[1]) / body];
  const hip = [sh[0] + along[0] * S.torso, sh[1] + along[1] * S.torso - sag];
  const kn = [hip[0] + (ankle[0] - hip[0]) * (S.thigh / (S.thigh + S.shin)), hip[1] + (ankle[1] - hip[1]) * (S.thigh / (S.thigh + S.shin))];
  const ear = add(sh, along, -S.neck);
  const nose = add(ear, [0.03, -0.08]); // face down
  return {
    nose: [...nose, 0], earL: [...ear, 0.075], earR: [...ear, -0.075],
    shL: [...sh, S.shW], shR: [...sh, -S.shW], elL: [...el, S.shW + 0.03], elR: [...el, -S.shW - 0.03], wrL: [...wrist, S.shW], wrR: [...wrist, -S.shW],
    hipL: [...hip, S.hipW], hipR: [...hip, -S.hipW], knL: [...kn, S.hipW], knR: [...kn, -S.hipW], anL: [...ankle, S.hipW], anR: [...ankle, -S.hipW],
  };
}

/** Sit-up / crunch: elev = torso angle above the floor. Knees bent, arms crossed on the chest. */
export function situp({ elev = 0 } = {}) {
  const hip = [0, 0.1], ankle = [0.5, 0.08];
  const kn = ik(ankle, hip, S.shin, S.thigh, 1); // knees up
  const td = [-Math.cos(rad(elev)), Math.sin(rad(elev))];
  const sh = add(hip, td, S.torso), ear = add(sh, td, S.neck);
  const face = [td[1], -td[0]]; // perpendicular to the torso, away from the floor
  const nose = add(ear, face, 0.09);
  const el = add(sh, face, 0.12), wr = add(sh, [-td[0], -td[1]], 0.1);
  return {
    nose: [...nose, 0], earL: [...ear, 0.075], earR: [...ear, -0.075],
    shL: [...sh, S.shW], shR: [...sh, -S.shW], elL: [...el, 0.1], elR: [...el, -0.1], wrL: [...add(wr, face, 0.05), -0.12], wrR: [...add(wr, face, 0.05), 0.12],
    hipL: [...hip, S.hipW], hipR: [...hip, -S.hipW], knL: [...kn, S.hipW], knR: [...kn, -S.hipW], anL: [...ankle, S.hipW], anR: [...ankle, -S.hipW],
  };
}

const INDEX = { nose: [0, 1, 2, 3, 4, 5, 6, 9, 10], earL: [7], earR: [8], shL: [11], shR: [12], elL: [13], elR: [14],
  wrL: [15, 17, 19, 21], wrR: [16, 18, 20, 22], hipL: [23], hipR: [24], knL: [25], knR: [26], anL: [27, 29, 31], anR: [28, 30, 32] };

// Deterministic PRNG so failures reproduce.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

/** Joints (X forward, Y up, Z = body's left) → { w, i } landmark arrays for a side or front camera. */
export function render(J, { view = 'side', noise = 0.006, rand = Math.random } = {}) {
  const gauss = () => (rand() + rand() + rand() - 1.5) * 1.15;
  const w = new Array(33), i = new Array(33);
  const hipX = (J.hipL[0] + J.hipR[0]) / 2, hipY = (J.hipL[1] + J.hipR[1]) / 2, hipZ = (J.hipL[2] + J.hipR[2]) / 2;
  for (const [name, idx] of Object.entries(INDEX)) {
    const [X, Y, Z] = J[name];
    const left = name.endsWith('L');
    // side: camera on the body's left, forward = image right. front: body faces the camera, its left = image right.
    const [ix, depth] = view === 'side' ? [X - hipX, -(Z - hipZ)] : [Z - hipZ, -(X - hipX)];
    const vis = view === 'side' && !left && name !== 'nose' && !name.startsWith('ear') ? 0.55 : 0.95;
    for (const k of idx) {
      w[k] = { x: ix + noise * gauss(), y: -(Y - hipY) + noise * gauss(), z: depth + noise * gauss(), visibility: vis };
      i[k] = { x: 0.5 + 0.33 * ix + 0.4 * noise * gauss(), y: 0.9 - 0.33 * Y + 0.4 * noise * gauss(), z: 0, visibility: vis };
    }
  }
  return { w, i };
}

/**
 * Frames of `reps` repetitions. pose(u, k) gives joints for progress u (0 rest → 1 bottom → 0) of rep k.
 * Holds the rest pose for `lead`/`tail` seconds around the reps.
 */
export function clip(pose, { reps = 5, period = 1.6, fps = 30, lead = 1.5, tail = 1.5, view = 'side', noise = 0.006, seed = 7, t0 = 0, drop = 0 } = {}) {
  const rand = rng(seed);
  const total = lead + reps * period + tail;
  const frames = [];
  for (let k = 0; k * (1 / fps) < total; k++) {
    const s = k / fps;
    const inside = s >= lead && s < lead + reps * period;
    const p = inside ? ((s - lead) % period) / period : 0;
    const u = (1 - Math.cos(2 * Math.PI * p)) / 2;
    if (drop && rand() < drop) continue;
    frames.push({ t: Math.round(t0 + s * 1000), ...render(pose(u, Math.floor((s - lead) / period)), { view, noise, rand }) });
  }
  return frames;
}

/** Runs frames through a tracker and returns its events, finishing open sets at the end. */
export function run(tracker, frames) {
  const events = [];
  for (const f of frames) for (const e of tracker.update(f.t, f.w, f.i)) events.push({ t: f.t, ...e });
  const end = frames.at(-1)?.t ?? 0;
  for (const e of tracker.finish(end + 1)) events.push({ t: end, ...e });
  return events;
}

export const repsOf = (events, ex) => events.filter((e) => e.type === 'rep' && e.ex === ex).length;
export const setsOf = (events) => events.filter((e) => e.type === 'set').map((e) => e.set);
