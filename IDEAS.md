# What to build next

Ordered by how much each would help, not by size.

### 1. Re-record a single line

A line you mispronounced currently means editing around it or recording the
whole lesson again. A record button on each line should swap in a fresh take
for that line only and keep everything else. The data model needs a per-line
"clip" source next to the slice of the main recording.

### 2. Word-by-word glossary

The translation pass could also return each Kurdish word with its meaning. Shown
under the line, or as an extra card after it, that makes a reel teach vocabulary
as well as phrases. This is the most-requested shape of language content.

### 3. Background music bed

A quiet loop under the voice, ducked whenever you speak. The mixdown already
knows exactly when speech happens. Silence during the "your turn" pause can
read as a dead video on a feed.

### 4. Square and 4:5 crops

Feed posts and Facebook want 1:1 and 4:5. The renderer is resolution-independent.
This needs new entries in the size table and a pass over the safe areas.

### 5. Send a lesson to Reels Creator

Export the approved lines and your recorded clips in the format Reels Creator's
"your own voice per line" feature expects. You could then reuse its Dialogue and
Stories layouts for the same material.

### 6. Persian and Turkish audiences

Both are already written up in `src/config/languages.ts` and can be switched on
in Settings. What they still need is a native speaker to check the on-video
words ("Listen", "Your turn", …) before the first video goes out.

### 7. Teach another language from your voice

The taught language is a config entry, like the audiences. Kurmanji, or Persian
for Kurdish speakers, would be a new entry with its own spelling rules. The
prompts already read everything from there.
