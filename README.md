# Leen Kurdish Studio

Turns your own Kurdish Sorani voice into vertical lesson videos for Arabic and
English speakers.

You record yourself, or upload a video, a dialogue or a story you read aloud.
The AI writes down what you said, line by line, and finds each line in your
recording. You can add a note on what to focus on, then it translates every line
into Arabic and English (Persian and Turkish are ready to switch on). You
proofread everything, and the app makes an MP4 for each language in your own
voice.

It is the sister app of Reels Creator, built the same way. The difference is
where the voice comes from. AI voices mispronounce Kurdish, so the Kurdish in
these videos is always you. The only AI voice in the app is the optional
Arabic or English voice on the title and closing cards.

## Four kinds of project

Each has its own tab and remembers the project you last had open.

| Tab | You give it | You get |
| --- | --- | --- |
| **Lesson** | A recording of the lesson's sentences | A listen-and-repeat video: each line plays once to three times, with a "your turn" pause sized to the line |
| **Video** | A video of yourself speaking | The same video with the Kurdish, its pronunciation and the translation burned in as subtitles, fitted to 9:16 |
| **Dialogue** | A recording of two people talking (or you voicing both) | A chat-thread video, each line on its speaker's side; you choose which lines belong to speaker 1 or 2 and name them |
| **Story** | A longer text (pasted, or a .txt/.docx file) and a recording of you reading it | A reading video, paragraph by paragraph, the sentence being read highlighted with its translation underneath |

## The four steps

| Step | What happens |
| --- | --- |
| **1 · Source** | Record in the browser (pause/resume, level meter) or upload audio; for a video project, upload the video; for a story, paste the text and read it aloud. Optionally say what it is about, so names get spelled right. |
| **2 · Transcript** | Gemini listens and writes one line per sentence in correct Sorani spelling (ڕ ڵ ۆ ێ ە). A story's known text is aligned to your reading instead of being guessed. Each line is shown on a waveform: click to hear it, drag its edges, split, merge or add lines, mark the speaker (dialogue) or the paragraph breaks (story). **Re-record any single line** without touching the rest. **Clean up the audio** and **cut out** useless gaps, coughs or false starts. Then write an optional **note** for the translation. |
| **3 · Translate & review** | Every line gets a Latin pronunciation and an Arabic and English translation, plus a title and a ready-to-post caption in each language. Everything is editable; a single line can be re-translated with an instruction ("more casual"). Nothing reaches a video until you **approve**. |
| **4 · Video** | Pick the look per language (dark green for Arabic, dark purple for English, green-into-purple when both share a video, or any other theme), the title and closing cards, how often each line plays; preview with sound; make one MP4 per language or one with both. |

Everything is saved on your computer as you go (IndexedDB in the browser): the
recordings, takes, lines, translations and videos. The **Library** tab reopens
any project. Nothing expires — a recording of your voice cannot be
regenerated — so it stays until you delete it.

## Your voice, cleaned up

- **Presets** remove background noise and shape the tone (ffmpeg's FFT
  denoiser, a rumble filter, gentle EQ and compression). An optional touch of
  **room ambience** keeps a dry laptop recording from sounding boxed in. None
  of it changes timing, so the line positions stay exact.
- **Shorten long pauses** inside a line to a limit you choose, and **cut**
  stretches you never want heard. Both are non-destructive: the original
  recording is kept and the cuts can be restored.
- **Re-record one line** when you stumble: the new take replaces just that
  line's audio and keeps its text and translations.
- What you hear when you press play on a line is exactly what the video gets.

## Title and closing cards

On, off, or in between: each card can be read by an **AI voice** in Arabic or
English, carry **your own clip** (recorded or uploaded), or stay **silent**.
Its words can be typed, or written by the AI and written again. An AI clip
whose words changed is left out of the video until you make it again.

Cards work for every kind. On a video project they are off by default (your
video usually has its own opening); switch them on and they are joined in
front of and after the subtitled video, at the same size.

## Stories

Paste the text, or open a `.txt` or `.docx` file. Blank lines become
paragraphs. Then read it aloud: the text sits beside the recorder as a large
teleprompter (it can also fill the screen), and clicking a sentence, or ↑ ↓ in
full screen, keeps your place. Because the words are already known, the
AI only has to find where each sentence starts and ends in your reading
(**Find each sentence in my reading**), so the spelling in the video is
exactly the spelling you wrote. You can still move a paragraph break on the
transcript step, and choose whether the translation shows per sentence or per
paragraph.

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

**`ffmpeg` is required** for the MP4s, for audio clean-up and for video
projects. Setup offers to install it on Windows (winget) and macOS (brew). On
Linux: `sudo apt install ffmpeg`. For iPhone HDR videos the usual ffmpeg builds
are fine: the colours are tone-mapped to normal video (this needs ffmpeg's
`zscale` filter, which those builds include).

**The app answers only on this computer.** The server holds your Gemini key and
runs ffmpeg on what it is sent, so it listens on `localhost` only and refuses
requests from other websites. To open it from a phone or another computer on
the same Wi-Fi, add `HOST=0.0.0.0` to `.env` and restart: the window then warns
that network access is on and lists the addresses to open. Anyone on that
network can then use the app, and your key with it, so switch it back off when
you are done.

<details>
<summary>Other commands</summary>

```bash
npm run dev                  # start without the setup checks
PORT=3101 npm run dev        # on another port
HOST=0.0.0.0 npm run dev     # reachable from other devices on your network
npm run build && npm start   # production build
npm run lint                 # typecheck
npm test                     # unit tests
GEMINI_API_KEY=... node list_models.js   # which models your key can reach
```
</details>

## Recording tips

- **Pause about a second between sentences.** That pause is how each line's start
  and end are found in your recording. The AI's own timestamps are only a hint;
  each cut is moved into the real silence nearest to where the AI put it.
- For a dialogue, leave a short pause each time the speaker changes.
- One lesson is 5–20 sentences. Anything up to about seven minutes is sent to
  the AI in one go; longer recordings go through Gemini's file upload.
- If you stumble, say the sentence again — the transcriber keeps only your
  final, complete attempt — or re-record that one line afterwards.
- In a noisy room keep **Reduce background noise** on (Settings) and pick the
  *Noisy room* preset.

## How the pieces fit

| Path | What lives there |
| --- | --- |
| `server.ts`, `server/` | Express app; `server/gemini.ts` (model and key fallback), `server/ffmpeg.ts`, and one route file per feature in `server/routes/` |
| `src/types.ts` | The data model: projects of four kinds, lines with takes, speakers and paragraphs, cuts, audio settings, cards |
| `src/config/languages.ts` | The taught language and the audience languages, their spelling rules, translation briefs and every word burned into the video. **Adding a language is an entry here.** |
| `src/config/prompts.ts`, `src/config/prompts/`, `src/config/transcribeModes.ts` | Transcription (lines, dialogue, aligned) and translation prompts |
| `src/config/models.ts`, `src/config/voices.ts`, `src/config/audioPresets.ts` | Gemini text and voice models, prices, audio presets |
| `src/audio/clipBuilder.ts` | A line's finished audio: take or slice, cuts, pause tightening, levelling |
| `src/audio/segmentation.ts` | Moves line boundaries into the pauses in your voice |
| `src/render/` | `frameKit.ts` (shared frame), `renderLesson.ts`, `renderDialogue.ts`, `renderStory.ts`, `cards.ts`, `subtitles.ts`, `videoOutput.ts` (preview and MP4), `themes.ts` |
| `src/lessonActions.ts` | Transcribe, translate, split/merge, build the video lines |
| `src/utils/projectStore.ts` | Projects in IndexedDB, and the migration from older versions |
| `tests/` | Unit tests (`npm test`) |

Several modules come straight from Reels Creator: the safe-area text stacker,
cached text layout, the word aligner, the frame-encoder worker pool and the
offline audio mixdown. So both apps keep text out from under the Instagram and
TikTok interface, and both draw frames offline as fast as the machine allows,
so the tab can sit in the background while a video is made.

## Cost

Transcription sends audio, which Gemini bills at 32 tokens a second — a
one-minute recording is about 2,000 audio tokens, a fraction of a cent on Flash.
Translation is text and costs even less; card voices are a few cents per
thousand characters. The running total for each project is shown at the top of
the Studio. Prices in `src/config/models.ts` only drive that estimate; check
[ai.google.dev/pricing](https://ai.google.dev/pricing) before trusting it for
billing.

## Branding

`public/logo.png` is drawn at the top of every video, and `public/logo.svg` is
used in the app header. Replace them to rebrand, or upload a logo in Settings
(that override applies to this browser only).
