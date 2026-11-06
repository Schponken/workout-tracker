# Reps: camera workout counter

Prop your phone up, point the camera at yourself, and work out. It recognises the exercise, counts every rep out loud, flags half reps, and logs each set on the phone.

**Open it:** https://schponken.github.io/workout-tracker/ then Share → **Add to Home Screen** (full screen, works offline, keeps your history).

| Exercise | Counted by | Best camera angle |
|---|---|---|
| Pushups | elbow bend (3D and 2D fused, so front views work) | side or front |
| Squats | knee angle + hip height | side, front or 3/4 |
| Lunges | same as squats, told apart by a split stance at the bottom | side |
| Sit-ups / crunches | how high your head rises above your hips | side |
| Jumping jacks | arms overhead *and* feet jumping out | front |
| Plank | timed while you hold still, body straight | side |

Tap the exercise name to lock one exercise instead of auto-detecting.

## How it works

- `engine.js` is the brains, with no DOM. MediaPipe's 33 body landmarks become joint angles and body heights. A One Euro filter smooths them, and each exercise runs a rep state machine with hysteresis. A rep counts when you leave the rest pose, reach full depth, and come back. Posture checks are judged at the bottom of the rep, so walking lunges and moving cameras don't break them. A new exercise has to show two clean reps before it can take over a running set, so one stray movement can't split it.
- `app.js` handles the camera, pose tracking (MediaPipe Pose Landmarker, GPU with a CPU fallback), the skeleton overlay, voice, the screen wake lock and the on-phone log (localStorage, with CSV export).
- Video never leaves the phone. Tracking runs in the browser.

## Develop

```bash
npm install && npm run vendor   # MediaPipe files into vendor/
npm test                        # engine tests on synthetic bodies (+ real-clip regression if traces exist)
npm run e2e                     # the real page in Chrome, fed workout clips through the camera path
npm run serve                   # http://127.0.0.1:8123 (add ?src=clip.mp4&debug to test without a camera)
```

The real-clip tests use 15 free Mixkit stock clips. They aren't in this repo (licence). Put clips in `test/clips/<id>/clip.mp4` and run `node test/extract.mjs` to build the landmark traces the tests read. When you change files the app shell uses, bump `VERSION` in `sw.js` so installed copies update.

## Credits

Pose tracking: [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) and the Pose Landmarker model, © Google, Apache License 2.0 (`vendor/mediapipe/LICENSE`).
