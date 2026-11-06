// Real-footage regression: rep counts on stock workout clips (traces from test/extract.mjs).
// The clips and traces are not in the repo (stock-video licence); these tests skip when traces are absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadTrace, runTrace } from './inspect.mjs';

// Hand-counted from contact sheets. [min, max] where the footage is ambiguous (rep cut off by the clip edge).
export const TRUTH = {
  24277: { pushup: 9 },            // front view
  24383: { pushup: 3 },            // front view, low camera
  731: { pushup: 6 },              // front view, far
  50763: { pushup: [4, 5] },       // front view, close; first rep starts before rest is seen
  24434: { pushup: [0, 8] },       // shaky close-up with a weight vest: only check nothing else fires
  24308: { pushup: [0, 12] },      // face-only close-up
  21273: { squat: 1 },             // 3/4 view, moving camera, first squat starts mid-rep
  752: { squat: 2 },               // wall-ball squats: ball overhead must not count as jumping jacks
  52116: { squat: 1 },
  48677: { squat: [0, 1] },        // rear view hip hinge
  52112: { lunge: 3 },             // walking lunges, side view
  45960: { lunge: 1 },
  52101: { lunge: [0, 2] },        // held lunge, then a floor mobility drill
  4591: { situp: 2 },
  36015: { crunch: 9 },            // close-up, legs out of frame
};
const ALL = ['pushup', 'squat', 'lunge', 'situp', 'crunch', 'jack'];

export async function countClip(id) {
  const events = runTrace(await loadTrace(id));
  const counts = Object.fromEntries(ALL.map((ex) => [ex, 0]));
  for (const e of events) if (e.type === 'rep') counts[e.ex]++;
  const plankMs = events.filter((e) => e.type === 'set' && e.set.ex === 'plank').reduce((s, e) => s + e.set.holdMs, 0);
  return { counts, plankMs, events };
}

for (const [id, want] of Object.entries(TRUTH)) {
  const have = existsSync(new URL(`./traces/${id}.json`, import.meta.url));
  test(`clip ${id}`, { skip: !have && 'no trace (run test/extract.mjs)' }, async () => {
    const { counts, plankMs } = await countClip(id);
    for (const ex of ALL) {
      const [lo, hi] = [].concat(want[ex] ?? 0, want[ex] ?? 0);
      assert.ok(counts[ex] >= lo && counts[ex] <= (Array.isArray(want[ex]) ? want[ex][1] : hi),
        `${ex}: counted ${counts[ex]}, expected ${JSON.stringify(want[ex] ?? 0)}`);
    }
    assert.equal(plankMs, 0, 'no plank in these clips');
  });
}
