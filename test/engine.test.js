// Engine logic on synthetic bodies: every exercise, false positives, sets, cues, locks and bad input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracker, angle, OneEuro } from '../engine.js';
import * as S from './synth.js';

const T = (opts) => new Tracker({ aspect: 1, ...opts });
const pushups = (u) => S.pushup({ elbow: 170 - 90 * u });
const squats = (u) => S.stand({ knee: 175 - 95 * u, front: 80 * u }); // arms forward for balance
const kinds = (ev) => ev.filter((e) => e.type === 'rep').map((e) => e.ex);

test('angle', () => {
  const o = { x: 0, y: 0, z: 0 };
  assert.equal(Math.round(angle({ x: 1, y: 0, z: 0 }, o, { x: 0, y: 1, z: 0 })), 90);
  assert.equal(Math.round(angle({ x: 1, y: 0, z: 0 }, o, { x: -1, y: 0, z: 0 })), 180);
  assert.ok(Number.isNaN(angle(o, o, o)));
});

test('one euro filter follows a step and settles', () => {
  const f = new OneEuro();
  let y;
  for (let t = 0; t < 2500; t += 33) y = f.filter(t < 1000 ? 0 : 1, t);
  assert.ok(Math.abs(y - 1) < 0.01, `settled at ${y}`);
});

test('side-view pushups: 10 reps in one set', () => {
  const ev = S.run(T(), S.clip(pushups, { reps: 10 }));
  assert.deepEqual(new Set(kinds(ev)), new Set(['pushup']));
  assert.deepEqual(S.setsOf(ev).map((s) => [s.ex, s.reps, s.partials]), [['pushup', 10, 0]]);
});

test('pushups survive 15 fps and dropped frames', () => {
  assert.equal(S.repsOf(S.run(T(), S.clip(pushups, { reps: 10, fps: 15 })), 'pushup'), 10);
  assert.equal(S.repsOf(S.run(T(), S.clip(pushups, { reps: 10, drop: 0.2, seed: 3 })), 'pushup'), 10);
});

test('squats from the side and the front', () => {
  for (const view of ['side', 'front']) {
    const ev = S.run(T(), S.clip(squats, { reps: 8, period: 2, view }));
    assert.deepEqual(kinds(ev), Array(8).fill('squat'), view);
  }
});

test('lunges are not squats', () => {
  const ev = S.run(T(), S.clip((u) => S.lunge({ u }), { reps: 6, period: 2 }));
  assert.deepEqual(kinds(ev), Array(6).fill('lunge'));
});

test('sit-ups vs crunches by how high the head gets', () => {
  assert.deepEqual(kinds(S.run(T(), S.clip((u) => S.situp({ elev: 75 * u }), { reps: 6, period: 2.5 }))), Array(6).fill('situp'));
  assert.deepEqual(kinds(S.run(T(), S.clip((u) => S.situp({ elev: 22 * u }), { reps: 8, period: 1.8 }))), Array(8).fill('crunch'));
});

test('jumping jacks need the feet to jump out, not just the arms', () => {
  const jacks = S.clip((u) => S.stand({ side: 15 + 150 * u, spread: 0.6 * u }), { reps: 15, period: 0.9, view: 'front' });
  assert.deepEqual(kinds(S.run(T(), jacks)), Array(15).fill('jack'));
  const armsOnly = S.clip((u) => S.stand({ side: 15 + 150 * u }), { reps: 6, period: 1.2, view: 'front' });
  assert.equal(kinds(S.run(T(), armsOnly)).length, 0);
});

test('plank is timed, and sagging hips get a cue', () => {
  const ev = S.run(T(), S.clip(() => S.pushup({ elbow: 168 }), { reps: 0, lead: 20, tail: 0 }));
  const sets = S.setsOf(ev);
  assert.equal(sets.length, 1);
  assert.equal(sets[0].ex, 'plank');
  assert.ok(Math.abs(sets[0].holdMs - 20000) < 1000, `held ${sets[0].holdMs}`);
  assert.ok(ev.some((e) => e.type === 'hold' && e.ms >= 10000), '10 s announcement');
  const sag = S.run(T(), S.clip(() => S.pushup({ elbow: 168, sag: 0.15 }), { reps: 0, lead: 10, tail: 0 }));
  assert.ok(sag.some((e) => e.type === 'cue' && e.text === 'Hips up'));
});

test('a pause at the top of pushups is not a plank', () => {
  const ev = S.run(T(), [
    ...S.clip(pushups, { reps: 5, lead: 1.5, tail: 4 }),
    ...S.clip(pushups, { reps: 5, t0: 15000, lead: 0, tail: 1.5, seed: 9 }),
  ]);
  assert.deepEqual(S.setsOf(ev).map((s) => [s.ex, s.reps]), [['pushup', 10]]);
});

test('standing around counts nothing', () => {
  const ev = S.run(T(), S.clip(() => S.stand(), { reps: 0, lead: 20, tail: 0, noise: 0.012 }));
  assert.equal(ev.filter((e) => e.type === 'rep' || e.type === 'set').length, 0);
});

test('switching exercise starts a new set; one stray rep is dropped', () => {
  const ev = S.run(T(), [
    ...S.clip(squats, { reps: 6, period: 2 }),
    ...S.clip(pushups, { reps: 6, t0: 18000 }),
  ]);
  assert.deepEqual(S.setsOf(ev).map((s) => [s.ex, s.reps]), [['squat', 6], ['pushup', 6]]);
  const stray = S.run(T(), S.clip(squats, { reps: 1, period: 2, tail: 12 }));
  assert.equal(S.setsOf(stray).length, 0);
  assert.ok(stray.some((e) => e.type === 'discard'));
});

test('half reps are tallied separately with a cue', () => {
  const pose = (u, k) => S.stand({ knee: 175 - (k < 5 ? 95 : 50) * u, front: 80 * u });
  const ev = S.run(T(), S.clip(pose, { reps: 9, period: 2 }));
  assert.deepEqual(S.setsOf(ev).map((s) => [s.ex, s.reps, s.partials]), [['squat', 5, 4]]);
  assert.ok(ev.some((e) => e.type === 'cue' && e.text === 'Go lower'));
});

test('locking an exercise counts only that one', () => {
  const locked = T({ lock: 'squat' });
  assert.equal(S.repsOf(S.run(locked, S.clip(squats, { reps: 4, period: 2 })), 'squat'), 4);
  assert.equal(S.run(T({ lock: 'squat' }), S.clip(pushups, { reps: 4 })).filter((e) => e.type === 'rep').length, 0);
  assert.deepEqual(kinds(S.run(T({ lock: 'crunch' }), S.clip((u) => S.situp({ elev: 75 * u }), { reps: 3, period: 2.5 }))), Array(3).fill('crunch'));
});

test('nobody in view, then garbage input, never throws or counts', () => {
  const tr = T();
  for (let t = 0; t < 3000; t += 33) assert.deepEqual(tr.update(t, null, null), []);
  assert.equal(tr.view(3000).lost, true);
  const junk = Array.from({ length: 33 }, () => ({ x: NaN, y: NaN, z: NaN, visibility: 0 }));
  for (let t = 3000; t < 5000; t += 33) tr.update(t, junk, junk);
  assert.equal(tr.finish(5000).length, 0);
});

test('view() reports the live set for the UI', () => {
  const tr = T();
  const frames = S.clip(pushups, { reps: 3 });
  for (const f of frames) tr.update(f.t, f.w, f.i);
  const v = tr.view(frames.at(-1).t);
  assert.equal(v.ex, 'pushup');
  assert.equal(v.reps, 3);
  assert.ok(Math.abs(v.paceMs - 1600) < 250, `pace ${v.paceMs} for a 1.6 s rep cycle`);
});
