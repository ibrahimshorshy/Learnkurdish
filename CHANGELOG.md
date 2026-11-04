# Changelog

## 2.0.0

### Four kinds of project

- **Lesson** — as before: record sentences, get a listen-and-repeat video.
- **Video** — upload a video of yourself; get it back with the Kurdish, its
  pronunciation and the translation burned in as subtitles, fitted to 9:16.
- **Dialogue** — a two-speaker recording; mark which lines belong to speaker 1
  or 2, name them, and get a chat-thread video.
- **Story** — paste or upload a longer text, read it aloud, and get a reading
  video paragraph by paragraph. The known text is aligned to your reading
  rather than transcribed from scratch.

Each kind has its own tab and remembers its own open project. Lessons from
1.0 open as they were.

### Your voice

- **Re-record a single line**: a fresh take replaces only that line's audio.
- **Audio clean-up presets** (noise removal and tone) and an optional touch of
  room ambience, none of which moves the timing.
- **Cut** stretches of a recording and **shorten long pauses** inside lines.
  Both are non-destructive.
- Playing a line in the editor plays exactly what the video will get.

### Title and closing cards

AI-written and AI-voiced in Arabic or English, your own recorded or uploaded
clip, or silent — and written or voiced again on demand. They work on every
kind, including video projects, where they are joined around the subtitled
video.

### Look

- Backgrounds are chosen per video: **Emerald** (dark green) is the default
  for Arabic, **Amethyst** (dark purple) for English, and **Twilight** (green
  into purple) when both share a video.
- In a two-language video, each language's "listen / your turn" cue has its
  own line, so Arabic and English no longer scramble each other.

### Safety and reliability

An independent review of this release found about thirty bugs; each was
confirmed by a second reviewer, fixed, and checked again.

- **The app answers only on this computer.** It used to listen on the whole
  network. `HOST=0.0.0.0` in `.env` opts back in, with a warning. Requests from
  other websites, or under another host name, are refused.
- **Uploads are only what they claim to be.** ffmpeg could be made to read
  other media files on the disk through a crafted playlist or manifest; uploads
  are now saved under names the server chooses and read only as the formats
  the app sends. Each kind of upload has a size limit, and audio clean-up takes
  up to four hours of the app's own WAV.
- **Cancel means stop.** Cancelling (or leaving a step) stops the server's
  ffmpeg work and removes its files, on Windows too. A cancel at the wrong
  moment during a subtitled render could crash the server; it no longer can.
- **Work lands where it started.** A transcription, translation, render, card
  voice or cleaned-up audio that finishes after you switch project is saved
  into the project it was started for, never the one open at that moment.
- **Nothing is thrown away by a stray click.** Switching tab, opening the
  Library, starting a new project or closing the page asks first while a
  recording, a render or an upload is in progress.
- **Takes survive split and merge.** Splitting a line with a re-recorded take
  splits the take at its nearest pause; merging asks before dropping takes.
- **Cutting an "um" out of a pause shortens the line**, rather than leaving
  two untrimmed halves of the pause.
- **Stories keep your text exactly**: quotes, dashes and list numbers, and the
  order of the sentences. Speech the AI left out between sentences (a false
  start, "sorry, again") stays out of the clips. Latin names and numbers
  inside Kurdish text read in the right order.
- **Video colour and sync.** Every MP4 is BT.709; title cards no longer shift
  the colours of the video they are joined to; iPhone HDR is tone-mapped; a
  video's own sound stays in step after a card even when its sound track
  starts late; browser-recorded WebM videos render at full length.
- **Memory.** The Emerald and Amethyst backgrounds no longer keep a new
  full-size image for every voice level (gigabytes over a few renders).
- Lessons from 1.0 keep their pauses as they were.

### Under the hood

- The server is split into modules, one route file per feature.
- The renderer is split into a shared frame kit, one renderer per kind,
  title/closing cards as a wrapper around any of them, and shared preview and
  export.

## 1.0.0

First version.

- **Record** in the browser (pause/resume, level meter) or upload an audio file.
- **Transcribe** with Gemini: Kurdish Sorani, verbatim, one line per sentence,
  with Sorani spelling rules spelled out in the prompt. The model's timestamps
  are moved into the real pauses in your voice. If the model gives no usable
  times, lines are laid over the speech by length.
- **Waveform editor**: hear any line, drag its edges, split, merge, add, delete.
- **Note box** for the translation, plus a choice of audience languages.
- **Translate** into Arabic and English (Persian and Turkish ready to switch
  on), with Latin pronunciation, lesson titles and post captions. Re-translate
  a single line with an instruction. Edited lines are flagged until
  re-translated or confirmed.
- **Approve**, then make one MP4 per language, or Arabic and English together:
  your voice, played once to three times, with a "your turn" pause after each
  play that matches the line's length. Six themes, live preview with sound,
  720p to 1440p.
- **Library**: every lesson is kept on this computer until you delete it.
- Model fallback, key fallback (the app's key, then `.env`), and a running cost
  estimate per lesson.
