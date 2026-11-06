// Prints a feature timeline (and engine events) for a trace, for tuning against the contact sheets.
// Usage: node test/inspect.mjs <id> [stepFrames]
import { readFile } from 'node:fs/promises';
import { features, Tracker } from '../engine.js';

export const unpack = (a) => a.map(([x, y, z, visibility]) => ({ x, y, z, visibility }));

export async function loadTrace(id) {
  const trace = JSON.parse(await readFile(new URL(`./traces/${id}.json`, import.meta.url)));
  const frames = trace.frames.map((f) => ({ t: f.t, w: f.w && unpack(f.w), i: f.i && unpack(f.i) }));
  return Object.assign(frames, { aspect: trace.w / trace.h });
}

/** Runs a trace through a fresh Tracker; returns every event. */
export function runTrace(frames, opts) {
  const tr = new Tracker({ aspect: frames.aspect, ...opts });
  const events = [];
  for (const f of frames) for (const e of tr.update(f.t, f.w, f.i)) events.push({ t: f.t, ...e });
  const end = frames.at(-1)?.t ?? 0;
  for (const e of tr.finish(end)) events.push({ t: end, ...e });
  return events;
}

if (process.argv[1]?.endsWith('inspect.mjs')) {
  const [id, step = '4'] = process.argv.slice(2);
  const frames = await loadTrace(id);
  const n = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '-').padStart(5);
  console.log('    t  incl elbow  knee kneeM raise  elev  hipH kneUp wrDrp  face split  armV  legV torsV front  e2d sdrop');
  const a2 = (p, q, r) => { const A = frames.aspect; const u = [(p.x - q.x) * A, p.y - q.y], v = [(r.x - q.x) * A, r.y - q.y]; return Math.acos(Math.max(-1, Math.min(1, (u[0]*v[0]+u[1]*v[1]) / Math.hypot(...u) / Math.hypot(...v)))) * 57.3; };
  frames.forEach((fr, k) => {
    if (k % Number(step)) return;
    if (!fr.w) return console.log(`${n(fr.t / 1000, 2)}  (no pose)`);
    const f = features(fr.w, fr.i, frames.aspect);
    console.log([fr.t / 1000, f.incl, f.elbow, f.knee, f.kneeMin, f.raise, f.elev].map((x, j) => n(x, j ? 0 : 2)).join(' ')
      + ' ' + [f.hipH, f.kneeUp, f.wristDrop, f.face, f.split, f.armV, f.legV, f.torsoV].map((x) => n(x, 2)).join(' ')
      + ' ' + n(Math.abs(fr.w[11].x - fr.w[12].x) / Math.hypot(fr.w[11].x - fr.w[12].x, fr.w[11].z - fr.w[12].z), 2)
      + ' ' + n((a2(fr.i[11], fr.i[13], fr.i[15]) + a2(fr.i[12], fr.i[14], fr.i[16])) / 2)
      + ' ' + n(((fr.i[15].y + fr.i[16].y - fr.i[11].y - fr.i[12].y) / 2) / (Math.abs(fr.i[11].x - fr.i[12].x) * frames.aspect || 1), 2));
  });
  for (const e of runTrace(frames)) console.log(JSON.stringify(e));
}
