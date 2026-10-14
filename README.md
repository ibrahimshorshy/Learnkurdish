# Leen Kurdish Studio

Turns your own Kurdish Sorani voice into vertical lesson videos for Arabic and
English speakers.

You record yourself saying the sentences of a lesson. The AI writes down what
you said, line by line, and finds each line in your recording. You can add a note
on what to focus on, then it translates every line into Arabic and English
(Persian and Turkish are ready to switch on). You proofread everything, and the
app makes an MP4 for each language: your voice, the Kurdish on screen, how to
pronounce it, what it means, and a pause after each line for the viewer to repeat
it.

It is the sister app of Reels Creator, built the same way. The difference is
where the voice comes from. AI voices mispronounce Kurdish, so nothing in these
videos is synthesized. The audio is always you.

## The four steps

| Step | What happens |
| --- | --- |
| **1 · Record** | Record in the browser (with pause/resume and a level meter) or upload an audio file. Optionally say what the recording is about, so names get spelled right. |
| **2 · Transcript** | Gemini listens and writes one line per sentence in correct Sorani spelling (ڕ ڵ ۆ ێ ە). Each line is placed in your recording and shown on a waveform: click to hear it, drag its edges to fix it, split, merge or add lines. Then write an optional **note** for the translation, e.g. "keep the English very simple", or leave it empty. |
| **3 · Translate & review** | Every line gets a Latin pronunciation, an Arabic and an English translation, plus a lesson title and a ready-to-post caption in each language. Everything is editable. Re-translate a single line with an instruction ("more casual"). Lines whose Kurdish changed since translating are flagged. Nothing reaches a video until you **approve**. |
| **4 · Video** | Pick a look, how many times each line plays, and how long the viewer gets to repeat. Preview it with sound, then make one MP4 per language, or one with Arabic and English together. |

Everything is saved on your computer as you go (IndexedDB in the browser): the
recording, the lines, the translations and the videos. The **Library** tab
reopens any lesson. Nothing expires. A recording of your voice cannot be
regenerated, so it stays until you delete it.

## Running it

You need [Node.js](https://nodejs.org) 20 or newer, and Chrome.

**On Windows, double-click `Kurdish-Studio.bat`.** To get a desktop icon,
right-click `Create-Desktop-Shortcut.ps1` once and choose *Run with PowerShell*.

Everywhere else:

```bash
npm run go
```

Either way it checks your setup, installs everything, offers to install `ffmpeg`,
asks for your Gemini API key the first time, starts the server and opens
**http://localhost:3100**. That is port 3100, not 3000, so it can run alongside
Reels Creator. Re-run it any time; it skips whatever is already done.

Get a free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
It is written to `.env`, which is gitignored. You can also paste a key into
**Settings** in the app.

**`ffmpeg` is required for the MP4.** Setup offers to install it on Windows
(winget) and macOS (brew). On Linux: `sudo apt install ffmpeg`.

<details>
<summary>Other commands</summary>

```bash
npm run dev                  # start without the setup checks
PORT=3101 npm run dev        # on another port
npm run build && npm start   # production build
npm run lint                 # typecheck
npm test                     # unit tests
GEMINI_API_KEY=... node list_models.js   # which models your key can reach
```
</details>

## Recording tips

- **Pause about a second between sentences.** That pause is how each line's start
  and end are found in your recording. The AI's own timestamps are only a hint.
  Each cut is moved into the real silence nearest to where the AI put it.
- One lesson is 5–20 sentences. Anything up to about seven minutes is sent to
  the AI in one go; longer recordings go through Gemini's file upload.
- If you stumble, just say the sentence again. The transcriber is told to keep
  only your final, complete attempt.
- In a noisy room keep **Reduce background noise** on (Settings). In a quiet room,
  switching it off sounds more natural.

## How the pieces fit

| Path | What lives there |
| --- | --- |
| `server.ts` | Express API: `/api/transcribe`, `/api/translate`, and the `/api/render/*` endpoints that hand frames to ffmpeg |
| `src/config/languages.ts` | The taught language (Kurdish Sorani) and the audience languages, with their spelling rules, translation briefs and every word burned into the video. **Adding a language is an entry here.** |
| `src/config/prompts.ts` | The transcription and translation prompts |
| `src/config/models.ts` | Gemini models, fallback order and prices |
| `src/audio/segmentation.ts` | Moves line boundaries into the pauses in your voice |
| `src/audio/audioTools.ts` | Decoding, 16kHz WAV for the AI, levelling, per-line clips with fades |
| `src/render/renderLesson.ts` | Draws the lesson video and produces the MP4 |
| `src/render/timeline.ts` | Listen → your turn → listen again, line by line |
| `src/render/themes.ts` | Six looks, including **Kurdistan Sun** |
| `src/lessonActions.ts` | Transcribe, translate, split/merge, cut clips |
| `src/utils/projectStore.ts` | Projects in IndexedDB |
| `tests/` | Unit tests for segmentation, timeline, transcript parsing and prompts (`npm test`) |

Several modules come straight from Reels Creator: the safe-area text stacker,
cached text layout, the word aligner, the frame-encoder worker pool and the
offline audio mixdown. So both apps keep text out from under the Instagram and
TikTok interface, and both draw frames offline as fast as the machine allows,
so the tab can sit in the background while a video is made.

## Cost

Transcription sends audio, which Gemini bills at 32 tokens a second. A
one-minute recording is about 2,000 audio tokens, a fraction of a cent on
Flash. Translation is text and costs even less. The running total for each
lesson is shown at the top of the Studio. Prices in `src/config/models.ts` only
drive that estimate. Check [ai.google.dev/pricing](https://ai.google.dev/pricing)
before trusting it for billing.

## Branding

`public/logo.png` is drawn at the top of every video, and `public/logo.svg` is
used in the app header. Replace them to rebrand, or upload a logo in Settings
(that override applies to this browser only).
