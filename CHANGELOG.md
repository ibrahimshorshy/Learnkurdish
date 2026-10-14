# Changelog

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
