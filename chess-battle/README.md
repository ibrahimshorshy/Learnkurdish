# Chess Battle — arcade 3D combat chess for TikTok / Reels

A self-contained 9:16 (1080×1920) 3D animation of one game, built for ChessTok. Chunky fighter-style
pieces with angry eyes battle on a neon synthwave board: every capture is an attack with hit-stop, screen
shake, debris, shockwaves and arcade words (POW! SMASH!), the HUD is a fighting game (HP bars from material,
clocks from the PGN, scores, combo counter, "FIGHT!", "CHECK!", "K.O."), and chess.com's move-quality marks
(Blunder, Mistake, Great Find …) pop up on the board.

This is a standalone project. It is unrelated to the Kurdish app next to it and to the `chess-animation` repo.

## Use it

Open **`chess-battle.html`** in Chrome or Edge (double-click, no server needed), press **START BATTLE**.

- **Record video** button: records the 1080×1920 canvas *with the generated sound* and downloads it
  (`.mp4` where the browser supports it, otherwise `.webm` — convert with
  `ffmpeg -i chess-battle.webm -c:v libx264 -c:a aac chess-battle.mp4`). Keep the tab in the foreground
  and use a machine with a GPU; it records in real time.
- **Pace**: Full ≈ 75 s · Fast ≈ 65 s (default) · Quick ≈ 55 s · Teaser ≈ 45 s.
- The scrubber jumps anywhere in the game; "Preview 540×960" is lighter, "HD 1080×1920" is what gets recorded.

## The story it tells (from your notes)

| Moment | What happens |
| --- | --- |
| 5.Ng5 | **ALIEN GAMBIT** — a UFO tractor-beams the knight (turns green) and drops it on g5 |
| 6.Nxf7 / 6…Kxf7 | alien attack, then "ALIEN DOWN" when the king eats the knight |
| 8…c5 / 10…Nc6 | **STEP 1** and **STEP 2** to kill the Alien Gambit |
| 11…Ne4 | **THE HORSE GETS ANGRY** — the knight goes red-hot and burns |
| 16.Nxh8 Kxh8 | **STEP 3**: never rescue your rook — let him take it |
| 25…Qh6 | **ABSOLUTE BLUNDER … but he did not see it** |
| 35…Qf3# | slow-mo, queen + bishop lasers, king explodes, **K.O. / CHECKMATE / WINS** |

Every piece attacks in its own style: pawns jab, knights leap and stomp, bishops dash and slash, rooks
charge, queens fire lasers, kings slam.

## Edit it

- `src/data.js` — the PGN, the player names/Elos, hook line, end-card text and the **`CAPTIONS`** (story beats keyed by ply index).
- `src/show.js` — scene, timeline and the per-piece attack animations.
- `src/hud.js` — all on-screen text, bars and banners (drawn into the video).
- `src/pieces.js` — the piece models and team colours. `src/audio.js` — the synthesised SFX and chiptune.

```bash
npm install
npm run build   # bundles three.js + chess.js into chess-battle.html
npm test        # PGN parser / story-beat checks
```

To use another game, replace `PGN` in `src/data.js` (mainline only; `%clk` and chess.com `%c_effect` marks are read if present),
update `CONFIG`, and re-point `CAPTIONS`. The alien/rage/mate set-pieces are bound to ply indices 8, 21 and the final move.

## Notes

- Tested by rendering the whole game in headless Chromium (software GL) and checking frames; real-time playback and
  recording speed on a GPU, and the sound, have not been listened to or watched live by me.
- Only the mainline is played (the engine-analysis variations in the PGN are ignored).
