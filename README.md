# Bathroom Singer 

A browser singing game: follow the melody and the hidden picture comes back as
you hit the notes. The image is constructed with a **2-D FFT**; each note owns
a slice of the frequency spectrum.

## What this build does

### Reveal (the important part)

- The artwork is downsampled to 64 × 64 and transformed with a 2-D FFT, per RGB
  channel (rows, then columns).
- Coefficients are sorted by distance from the centre (low → high frequency)
  and split into **equal bands**. With the built-in 42-note song that is
  97–98 coefficients per band, so every note visibly changes the picture.
- A band's weight is the average score of the notes assigned to it. The render
  is `true × weight + noise × (1 − weight)`.
- The noise is generated with the **same energy** as the band it replaces and
  with Hermitian symmetry, so the inverse transform is a real image. Missed
  notes look like static, not a smooth blur.
- The DC coefficient (average colour) is kept real, so the picture does not
  flash to a random colour. Everything else starts hidden.
- The reveal uses the **best score achieved per note**, so the picture never
  gets blurrier when you miss a later note.

### Scoring

- Pitch is detected with YIN (80 Hz – ~1 kHz), 2048-sample window.
- Readings are assigned to the nearest note within a 200 ms timing window and
  stored in **50 ms bins** as the best (smallest) pitch error for that bin.
- Score = fraction of bins within tolerance, with linear falloff to zero at
  twice the tolerance. Silence in a bin counts as zero. Octave errors fold to
  zero (octave forgiveness) and the first 50 ms of longer notes is ignored
  (voice onset / analyser smear).
- Difficulty only changes pitch tolerance: **Easy ±100, Normal ±50, Hard ±30
  cents**. There is no score inflation.
- `Forgive my key` measures the median offset over the first ~8 s and applies
  it to the whole performance.
- `Mic delay` (0–400 ms, saved in `localStorage`) shifts readings in time.

### Songs

- Built-in Twinkle Twinkle with guide tones, count-in, and a soft backing.
- Upload your own song. For the cleanest result, also upload a **vocals-only**
  track; the extractor finds the melody there and plays the full song as
  backing. Without a vocal track, drums/chords can confuse the extractor.
- Extraction low-passes before decimating, merges same-pitch fragments, and
  drops blips shorter than 100 ms.
- The page ships with built-in artwork, so the game is playable immediately;
  upload a JPG/PNG/WebP to replace it.

---


## Notes and limits

- Always use `localhost` or HTTPS for `getUserMedia`.
- Wired headphones have less delay than Bluetooth. If the score feels early or
  late, change **Mic delay**; 50 ms is the default.
- Melody extraction is a heuristic. A clean, monophonic vocal track works best.
- The reveal is 64 × 64 by design (soft/painterly and fast on phones). For a
  sharper, slower reveal, change `R = 64` to `R = 128` at the top of `app.js`.
- Changing difficulty or key forgiveness during a run re-scores the bins
  already collected.
- "Image clarity" is the best overall accuracy reached so far; the final score
  is the current accuracy at the end of the song.

## Files

- `app.js` — game, FFT reveal, scoring, pitch detection, extraction
- `index.html` — UI (adds the `Mic delay` control)
- `style.css` — styling
