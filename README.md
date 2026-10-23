# Bathroom Singer — fixed build

A browser singing game: follow the melody and the hidden picture comes back as
you hit the notes. The image is reconstructed with a **2-D FFT**; each note owns
a slice of the frequency spectrum.

This folder is a fixed copy of `bathroom-singer-integrated-final`. The original
project was left untouched.

---

## Run it

The microphone needs a secure context: `localhost` or HTTPS.

```bash
# from this folder (the one containing index.html)
python3 -m http.server 8001
```

Open <http://localhost:8001>, allow the microphone, and use headphones.

`Test run` does not need a microphone. It sings the target notes with an
internal oscillator so you can check the scoring/reveal pipeline. You should
see it climb towards 100%.

---

## What was wrong

| Problem | Effect |
| --- | --- |
| Unrevealed FFT coefficients were left at `0` | The canvas was flat grey before/while a band had not been sung — no hidden image, no sense of something underneath. |
| Bands were mapped with `sqrt(rank / 4096)` | Wildly uneven bands: some notes owned **5** coefficients, others **188**. Singing some notes changed almost nothing. |
| Scores were divided by an `ease` factor (0.5–1.0) | Partial credit was inflated. Being a whole semitone off in Normal still scored **82%**. |
| `recompute()` scanned every stored reading against every note | 82 ms stall for a 600-note song / 40k readings, and it got worse the longer you sang. |
| Test run fed an oscillator to an analyser with no output | Some browsers never pull that graph, so Test run could score 0 even though the code worked. |
| `localStorage["latency_ms"]` was read but no UI existed | Bluetooth/headphone delay could not be corrected. |
| No image on first load | The app did nothing useful until you uploaded a picture. |
| Melody extraction decimated without a low-pass | Harmonics aliased back as false notes. |
| Various smaller bugs | Object URLs never revoked, canvas reallocated every frame, guide tone died away during the note, Stop left the target note highlighted. |

---

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

## Verification

The numbers below are from a headless-Chrome harness driving the real
functions/canvas (not a mock of the maths):

```
BEFORE-START noise (std 38.4)                  hidden image instead of grey
FULL-REVEAL mean|err| = 0.00                   reconstruction is pixel-exact
BANDS 42 bands, 97..98 coefficients each       every note has equal weight
perfect singer, Normal                         100%
+1 semitone, key forgiveness off, Normal         0%
+1 semitone, key forgiveness on                100%
±1 octave                                      100%
100 ms late start                               95%
silence                                          0%
every other note                                50%
600 notes / 40k readings: recompute            0.35 ms (was 82 ms)
drawFreq                                       4.0 ms
YIN 82, 110, 146.8, 220, 440, 784 Hz            exact (±0.1 Hz)
4-note WAV extraction                          60, 64, 67, 72 — correct
image upload / custom build / mic-denied path  all OK
```

The live microphone loop cannot be exercised in headless Chrome because its
audio clock does not advance; the pitch detector, capture, scoring, reveal,
extraction, upload and error paths are all tested directly.

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
- `LICENSE-NOTES.txt` — notes from the original project
