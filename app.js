'use strict';

/* ------------------------------------------------------------------
   Bathroom Singer — sing the melody, reveal the picture.

   How the reveal works
   --------------------
   The image is downsampled to an R x R grid and turned into spatial
   frequency coefficients with a 2-D FFT (rows, then columns, for each
   colour channel).  Coefficients are sorted from the centre of the
   spectrum outwards: small radius = broad shapes and colour, large
   radius = edges and fine detail.

   Those coefficients are split into NB equal bands, coarse -> fine, and
   the song's notes are assigned to the bands in time order.  While the
   player sings, each band is blended:

       coefficient = true * q  +  noise * (1 - q)

   where q is how well the notes for that band were sung (0..1).  The
   noise is generated with the same energy as the band it replaces, so a
   missed band looks like static instead of a smooth blur.  The inverse
   FFT turns the mixed coefficients back into pixels.
   ------------------------------------------------------------------ */

const $ = id => document.getElementById(id);

// ---------------------------------------------------------------- settings
const S = 256;            // on-screen canvas (px)
const R = 64;             // FFT grid (set to 128 for a sharper, slower reveal)
const LEAD = 2;           // seconds of count-in before the melody
const BIN = 0.05;         // scoring resolution (seconds)
const SLACK = 0.20;       // readings this far outside a note still count
const KEY_WINDOW = 8;     // seconds used by "Forgive my key"
const EMPTY = 9999;       // "no pitch" marker in a score bin
const MAX_BANDS = 128;    // never need more bands than this
const LEVELS = { easy: { tol: 100 }, normal: { tol: 50 }, hard: { tol: 30 } };

const SONG = { bpm: 96, buf: null };
const N = [];             // melody notes

// ------------------------------------------------------- built-in melody
// Twinkle Twinkle (public domain). midi:beats, "|" ends a phrase.
const MEL = "60:1 60:1 67:1 67:1 69:1 69:1 67:2|65:1 65:1 64:1 64:1 62:1 62:1 60:2|" +
            "67:1 67:1 65:1 65:1 64:1 64:1 62:2|67:1 67:1 65:1 65:1 64:1 64:1 62:2|" +
            "60:1 60:1 67:1 67:1 69:1 69:1 67:2|65:1 65:1 64:1 64:1 62:1 62:1 60:2";
const CH = "C C F C F C G C C F C G C F C G C C F C F C G C";
const CHORD = { C: [48, 52, 55], F: [53, 57, 60], G: [55, 59, 62] };
{
  const b = 60 / SONG.bpm;
  let t = LEAD;
  MEL.split("|").forEach((phrase, i) => phrase.split(" ").forEach(x => {
    const [m, d] = x.split(":").map(Number);
    N.push({ start: t, end: t + d * b * .9, midi: m, phrase: i, score: 0, revealScore: 0, bins: null });
    t += d * b;
  }));
}

// -------------------------------------------------------------- utilities
const hz = m => 440 * 2 ** ((m - 69) / 12);
const cents = (f, m) => 1200 * Math.log2(f / hz(m));
const fold = c => ((c + 600) % 1200 + 1200) % 1200 - 600;   // fold to ±600, i.e. forgive octaves
const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const name = m => NAMES[m % 12] + (Math.floor(m / 12) - 1);
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const gauss = () => Math.sqrt(-2 * Math.log(Math.random() || 1e-9)) * Math.cos(2 * Math.PI * Math.random());

// Notes are sorted by start time.  Binary search for the note at time t;
// at most two notes can be within the slack window.
function findNote(t, slack) {
  if (!N.length) return null;
  let lo = 0, hi = N.length - 1, last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (N[mid].start <= t) { last = mid; lo = mid + 1; } else hi = mid - 1;
  }
  let best = null, bd = 1e9;
  for (let j = Math.max(0, last); j <= Math.min(N.length - 1, last + 1); j++) {
    const n = N[j];
    const d = t < n.start ? n.start - t : t > n.end ? t - n.end : 0;
    if (d <= slack && d < bd) { best = n; bd = d; }
  }
  return best;
}
function nextNote(t) {
  let lo = 0, hi = N.length - 1, k = N.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (N[mid].start > t) { k = mid; hi = mid - 1; } else lo = mid + 1;
  }
  return k < N.length ? N[k] : null;
}

// ------------------------------------------------------------- the picture
const src = document.createElement("canvas");
src.width = src.height = S;

function builtInArtwork() {
  const g = src.getContext("2d");
  const sky = g.createLinearGradient(0, 0, 0, S);
  sky.addColorStop(0, "#101a2c");
  sky.addColorStop(.55, "#2b3a58");
  sky.addColorStop(1, "#c96c4a");
  g.fillStyle = sky;
  g.fillRect(0, 0, S, S);

  g.fillStyle = "#ffe6a8";                       // moon
  g.beginPath(); g.arc(178, 62, 26, 0, 7); g.fill();
  g.globalAlpha = .25;
  g.beginPath(); g.arc(178, 62, 38, 0, 7); g.fill();
  g.globalAlpha = 1;

  for (let i = 0; i < 40; i++) {                 // stars
    const x = (i * 73) % S, y = (i * 41) % 110;
    g.fillStyle = i % 3 ? "rgba(255,255,255,.75)" : "#9fd0ff";
    g.fillRect(x, y, i % 4 ? 1 : 2, i % 4 ? 1 : 2);
  }

  g.fillStyle = "#1b2436";                       // mountains
  g.beginPath();
  g.moveTo(-10, 210); g.lineTo(60, 96); g.lineTo(120, 205);
  g.lineTo(176, 120); g.lineTo(266, 210); g.lineTo(266, 256); g.lineTo(-10, 256);
  g.closePath(); g.fill();

  g.fillStyle = "#11161f";                       // foreground hill
  g.beginPath(); g.moveTo(-10, 232); g.quadraticCurveTo(128, 190, 266, 238);
  g.lineTo(266, 256); g.lineTo(-10, 256); g.closePath(); g.fill();

  g.fillStyle = "#ffb454";                       // title
  g.font = "bold 13px ui-sans-serif, system-ui, sans-serif";
  g.textAlign = "center";
  g.fillText("BATHROOM SINGER", S / 2, 248);
}

builtInArtwork();
$("empty").style.display = "none";
$("fileName").textContent = "Built-in artwork — or choose your own";

$("pic").onchange = e => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const im = new Image();
  im.onload = () => {
    const k = Math.min(im.width, im.height);
    const g = src.getContext("2d");
    g.clearRect(0, 0, S, S);
    g.drawImage(im, (im.width - k) / 2, (im.height - k) / 2, k, k, 0, 0, S, S);
    URL.revokeObjectURL(url);
    $("empty").style.display = "none";
    $("fileName").textContent = f.name;
    prep();
    drawFreq(running ? ctx.currentTime - T0 - LL : -1);
  };
  im.onerror = () => {
    URL.revokeObjectURL(url);
    $("fileName").textContent = "Could not read that image — try a JPG or PNG.";
  };
  im.src = url;
};

// ------------------------------------------------- 2-D Fourier transform
// In-place radix-2 complex FFT (iterative). inv=true runs the inverse.
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inv ? 2 : -2) * Math.PI / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(a * k), wi = Math.sin(a * k);
        const u = i + k, v = u + len / 2;
        const xr = re[v] * wr - im[v] * wi;
        const xi = re[v] * wi + im[v] * wr;
        re[v] = re[u] - xr; im[v] = im[u] - xi;
        re[u] += xr; im[u] += xi;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// 2-D transform: FFT every row, then every column.
function fft2(re, im, inv) {
  const a = new Float64Array(R), b = new Float64Array(R);
  for (let y = 0; y < R; y++) fft(re.subarray(y * R, y * R + R), im.subarray(y * R, y * R + R), inv);
  for (let x = 0; x < R; x++) {
    for (let y = 0; y < R; y++) { a[y] = re[y * R + x]; b[y] = im[y * R + x]; }
    fft(a, b, inv);
    for (let y = 0; y < R; y++) { re[y * R + x] = a[y]; im[y * R + x] = b[y]; }
  }
}

// ---------------------------------------- frequency bands + hidden image
const SIZE = R * R;
const band = new Uint16Array(SIZE);       // coefficient -> band index
const mirror = new Uint16Array(SIZE);     // conjugate partner of a coefficient
const rank = new Uint16Array(SIZE);       // position when sorted by radius
const radius = new Float64Array(SIZE);
const order = new Array(SIZE);

for (let y = 0; y < R; y++) {
  for (let x = 0; x < R; x++) {
    const i = y * R + x;
    radius[i] = Math.hypot(Math.min(y, R - y), Math.min(x, R - x));
    mirror[i] = ((R - y) % R) * R + ((R - x) % R);
    order[i] = i;
  }
}
order.sort((p, q) => radius[p] - radius[q]);
order.forEach((i, r) => { rank[i] = r; });

let NB = 0;                 // number of bands
let bandNotes = [];         // band index -> notes in that band
let co = null;              // forward FFT of each colour channel
let nz = null;              // matched noise spectrum of each channel

const ic = $("reveal").getContext("2d");
const fc = document.createElement("canvas");
fc.width = fc.height = R;
const fg = fc.getContext("2d");
const fi = fg.createImageData(R, R);

// Split the sorted coefficients into equal bands (so every note moves a
// comparable slice of the image) and map notes to bands in time order.
function layout() {
  const count = N.length || 1;
  NB = Math.max(1, Math.min(count, MAX_BANDS, SIZE));
  for (let i = 0; i < SIZE; i++) band[i] = Math.min(NB - 1, Math.floor(rank[i] * NB / SIZE));
  bandNotes = Array.from({ length: NB }, () => []);
  for (let i = 0; i < count; i++) bandNotes[Math.min(NB - 1, Math.floor(i * NB / count))].push(N[i]);
  prep();
}

// Forward transform of the (downsampled) picture + energy-matched noise.
function prep() {
  const c = document.createElement("canvas");
  c.width = c.height = R;
  const g = c.getContext("2d");
  g.imageSmoothingEnabled = true;
  g.drawImage(src, 0, 0, R, R);
  const d = g.getImageData(0, 0, R, R).data;

  co = [0, 1, 2].map(ch => {
    const re = new Float64Array(SIZE), im = new Float64Array(SIZE);
    for (let i = 0; i < SIZE; i++) re[i] = d[i * 4 + ch] - 128;
    fft2(re, im, false);
    return { re, im };
  });
  nz = co.map(makeNoise);
}

// Random coefficients with the same energy as each band, built with
// Hermitian symmetry so the inverse transform is a real image.
function makeNoise(F) {
  const energy = new Float64Array(NB), count = new Float64Array(NB);
  for (let i = 0; i < SIZE; i++) {
    const b = band[i];
    energy[b] += F.re[i] * F.re[i] + F.im[i] * F.im[i];
    count[b]++;
  }
  const re = new Float64Array(SIZE), im = new Float64Array(SIZE);
  const amp = b => Math.sqrt((energy[b] / (count[b] || 1)) / 2);
  for (let i = 0; i < SIZE; i++) {
    const m = mirror[i];
    if (i > m) continue;                       // the partner writes both
    const s = amp(band[i]);
    if (i === m) { re[i] = s * gauss(); im[i] = 0; }   // real, self-conjugate
    else {
      const a = s * gauss(), b = s * gauss();
      re[i] = a; im[i] = b;
      re[m] = a; im[m] = -b;
    }
  }
  return { re, im };
}

// Mix true coefficients with noise according to the note scores and
// inverse-transform the result.  t is song time (or Infinity for the end).
function drawFreq(t) {
  const w = new Float64Array(NB);
  for (let b = 0; b < NB; b++) {
    const list = bandNotes[b];
    let s = 0;
    for (const n of list) if (t >= n.start) s += Math.max(n.score || 0, n.revealScore || 0);
    w[b] = s / Math.max(1, list.length);
  }

  const out = [0, 1, 2].map(ch => {
    const F = co[ch], Z = nz[ch];
    const re = new Float64Array(SIZE), im = new Float64Array(SIZE);
  for (let i = 0; i < SIZE; i++) {
      // Average the pair so the two halves of a conjugate pair always get
      // the same weight; otherwise the inverse transform is not exactly real.
      const q = clamp((w[band[i]] + w[band[mirror[i]]]) / 2, 0, 1);
      re[i] = F.re[i] * q + Z.re[i] * (1 - q);
      im[i] = F.im[i] * q + Z.im[i] * (1 - q);
    }
    re[0] = F.re[0]; im[0] = 0;                 // keep the average colour stable
    fft2(re, im, true);
    return re;
  });

  const d = fi.data;
  for (let i = 0; i < SIZE; i++) {
    d[i * 4] = out[0][i] + 128;
    d[i * 4 + 1] = out[1][i] + 128;
    d[i * 4 + 2] = out[2][i] + 128;
    d[i * 4 + 3] = 255;
  }
  fg.putImageData(fi, 0, 0);
  ic.imageSmoothingEnabled = true;
  ic.drawImage(fc, 0, 0, R, R, 0, 0, S, S);
}

// --------------------------------------------------- pitch detection (YIN)
function detect(buf, sr) {
  let e = 0;
  for (let i = 0; i < buf.length; i++) e += buf[i] * buf[i];
  const rms = Math.sqrt(e / buf.length);
  if (rms < .01) return null;                  // too quiet: breath or noise

  const max = Math.floor(sr / 80);             // lowest detectable pitch: 80 Hz
  const W = buf.length - max;
  if (W < 32) return null;
  const d = new Float32Array(max);
  let sum = 0;
  for (let tau = 1; tau < max; tau++) {
    let s = 0;
    for (let j = 0; j < W; j += 2) {
      const x = buf[j] - buf[j + tau];
      s += x * x;
    }
    sum += s;
    d[tau] = s * tau / sum;
  }
  let tau = Math.floor(sr / 1000);
  while (tau < max - 1 && d[tau] >= .15) tau++;
  if (tau >= max - 1) return null;
  while (tau < max - 1 && d[tau + 1] < d[tau]) tau++;
  let tt = tau;
  if (tau > 1) {
    const a = d[tau - 1], b = d[tau], c = d[tau + 1];
    const q = a - 2 * b + c;
    if (q > 0) tt = tau + (a - c) / (2 * q);
  }
  return { hz: sr / tt, clarity: 1 - d[tau], rms };
}

// ------------------------------------- your own song: find the melody
async function extract(buf) {
  const input = buf.getChannelData(0);
  const other = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const f = 4, n = Math.floor(input.length / f), sr = buf.sampleRate / f;
  const y = new Float32Array(n);

  // Mix to mono, low-pass, then decimate.  The low-pass matters: without
  // it, harmonics above the new Nyquist frequency fold back as false notes.
  const a = 1 - Math.exp(-2 * Math.PI * 3500 / buf.sampleRate);
  let lp1 = 0, lp2 = 0, mx = 0;
  for (let i = 0; i < n; i++) {
    const p = i * f;
    let s = 0;
    for (let k = 0; k < f; k++) {
      const v = (input[p + k] + (other ? other[p + k] : input[p + k])) / 2;
      lp1 += a * (v - lp1);
      lp2 += a * (lp1 - lp2);
      s += lp2;
    }
    y[i] = s / f;
    const av = Math.abs(y[i]);
    if (av > mx) mx = av;
  }
  if (mx > 0) for (let i = 0; i < n; i++) y[i] *= .5 / mx;

  const W = 1024, hop = Math.round(sr * .012), notes = [];
  let cur = [], peak = 0, phrase = 0;
  const median = a => {
    const m = a.map(v => v.m).sort((p, q) => p - q);
    return m[m.length >> 1];
  };
  const close = () => {
    if (cur.length && cur[cur.length - 1].t - cur[0].t >= .1) {
      const s = cur[0].t, e = cur[cur.length - 1].t + .012;
      if (notes.length && s - notes[notes.length - 1].end >= .4) phrase++;
      notes.push({ start: s, end: e, midi: Math.round(median(cur)), phrase });
    }
    cur = [];
  };

  for (let p = 0, c = 0; p + W <= n; p += hop, c++) {
    const q = detect(y.subarray(p, p + W), sr);
    const t = (p + W / 2) / sr;
    let e = 0;
    for (let k = W / 2 - 64; k < W / 2 + 64; k++) e += y[p + k] * y[p + k];
    e = Math.sqrt(e / 128);
    peak = cur.length ? Math.max(e, peak * .99) : e;
    const m = q ? 69 + 12 * Math.log2(q.hz / 440) : 0;
    if (q && q.clarity > .85 && m >= 46 && m <= 81) {
      if (cur.length && (Math.abs(m - median(cur)) > .7 || e < .4 * peak)) { close(); peak = e; }
      cur.push({ t, m });
    } else close();
    if (c % 300 === 0) {
      $("bmsg").textContent = "Listening for notes… " + Math.round(100 * p / n) + "%";
      await new Promise(r => setTimeout(r));
    }
  }
  close();

  // Join fragments of the same pitch and drop very short blips.
  const merged = [];
  for (const n of notes) {
    const prev = merged[merged.length - 1];
    if (prev && prev.midi === n.midi && n.start - prev.end < .16) prev.end = Math.max(prev.end, n.end);
    else merged.push({ ...n });
  }
  return merged.filter(n => n.end - n.start >= .1);
}

let building = false;
$("build").onclick = async () => {
  if (running || building) return;
  const sf = $("songf").files[0], vf = $("vocf").files[0] || sf, m = $("bmsg");
  if (!sf) { m.textContent = "Choose a song file first."; return; }
  building = true;
  try {
    m.textContent = "Reading the audio…";
    const dec = file => file.arrayBuffer().then(b => new OfflineAudioContext(1, 1, 44100).decodeAudioData(b));
    const vbuf = await dec(vf);
    const notes = await extract(vbuf);
    if (notes.length < 3) {
      m.textContent = "Only found " + notes.length + " notes. Try a vocals-only file.";
      return;
    }
    notes.forEach(n => { n.start += LEAD; n.end += LEAD; n.score = 0; n.revealScore = 0; n.bins = null; });
    SONG.buf = vf === sf ? vbuf : await dec(sf);
    N.length = 0;
    N.push(...notes);
    resetPerformance();
    layout();
    resetDisplay();
    drawFreq(-1);
    $("songTitle").textContent = sf.name;
    $("songMeta").textContent = notes.length + " notes · your song";
    m.textContent = "Found " + notes.length + " notes. " +
      (vf === sf && vbuf.duration > 20
        ? "No vocals-only file was added, so these notes may follow the backing too. Check them with the guide tone."
        : "Press Start singing.");
  } catch (err) {
    m.textContent = "Couldn’t read that file: " + err.message;
  } finally {
    building = false;
  }
};

$("songf").onchange = () => {
  const f = $("songf").files[0];
  $("songName").textContent = f ? f.name : "Built-in tune";
};
$("vocf").onchange = () => {
  const f = $("vocf").files[0];
  $("vocName").textContent = f ? f.name : "Optional, finds the tune better";
};

// --------------------------------------------------------------- audio
let ctx = null, an = null, mic = null, stream = null, abuf = null;
let T0 = 0, LL = 0, running = false, last = 0, tick = 0;
let total = 0, bestTotal = 0;
let keyOff = 0;
const keySamples = [];
let fbuf = null;

// User-adjustable mic delay (Bluetooth headphones can be 150–300 ms).
let L = .05;
try {
  const v = parseFloat(localStorage.getItem("latency_ms"));
  if (isFinite(v)) L = clamp(v, 0, 400) / 1000;
} catch (e) { /* storage may be unavailable */ }
$("lat").value = Math.round(L * 1000);
$("lat").oninput = () => {
  const v = parseFloat($("lat").value);
  if (!isFinite(v)) return;
  L = clamp(v, 0, 400) / 1000;
  try { localStorage.setItem("latency_ms", String(Math.round(clamp(v, 0, 400)))); } catch (e) {}
};

function tone(m, t, d, v, type = "triangle", sustain = false) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.value = hz(m);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(v, t + .02);
  if (sustain) {
    g.gain.setValueAtTime(v, Math.max(t + .021, t + d - .06));
    g.gain.linearRampToValueAtTime(0, t + d);
  } else {
    g.gain.exponentialRampToValueAtTime(.001, t + d);
  }
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + d + .05);
}

function backing() {
  const b = 60 / SONG.bpm;
  CH.split(" ").forEach((c, i) => CHORD[c].forEach(m => tone(m, T0 + LEAD + i * 2 * b, 1.8 * b, .1)));
}

// Test run: a synthetic voice that follows the target notes exactly.
function simulate() {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = "sine";
  g.gain.value = 0;
  o.connect(g).connect(an);
  for (const n of N) {
    o.frequency.setValueAtTime(hz(n.midi), T0 + n.start);
    g.gain.setValueAtTime(.3, T0 + n.start);
    g.gain.setValueAtTime(0, T0 + n.end);
  }
  o.start();
}

async function start(virtual) {
  if (running || building) return;
  if (N.length < 1) { $("msg").textContent = "Choose a song first."; return; }

  $("res").innerHTML = "";
  $("msg").textContent = "";

  try {
    ctx = new AudioContext();
    await ctx.resume();
  } catch (e) {
    $("msg").textContent = "Audio could not start: " + e.message;
    ctx = null;
    return;
  }

  an = ctx.createAnalyser();
  an.fftSize = 2048;
  an.smoothingTimeConstant = .7;
  abuf = new Float32Array(an.fftSize);
  fbuf = new Uint8Array(an.frequencyBinCount);

  // A zero-gain sink guarantees the graph is pulled even when nothing is
  // audible (the oscillator-only "Test run" needs this).
  const silent = ctx.createGain();
  silent.gain.value = 0;
  an.connect(silent).connect(ctx.destination);

  if (!virtual) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      });
      mic = ctx.createMediaStreamSource(stream);
      mic.connect(an);
    } catch (e) {
      try { an.disconnect(); } catch (_) {}
      try { ctx.close(); } catch (_) {}
      ctx = null; an = null;
      $("msg").textContent = "Microphone blocked: " + e.message + ". The mic needs localhost or https.";
      return;
    }
  }

  T0 = ctx.currentTime + .4;
  if (virtual) simulate();

  const beat = 60 / SONG.bpm;
  for (let i = 1; i < 4; i++) tone(88, T0 + LEAD - (4 - i) * beat, .1, .22, "sine");

  if (SONG.buf) {
    const s = ctx.createBufferSource();
    s.buffer = SONG.buf;
    s.connect(ctx.destination);
    s.start(T0 + LEAD);
  } else backing();

  if ($("guide").checked) {
    for (const n of N) tone(n.midi, T0 + n.start, Math.max(.1, n.end - n.start), .12, "sine", true);
  }

  resetPerformance();
  LL = virtual ? 0 : L;
  last = 0;
  tick = 0;
  running = true;
  $("go").disabled = $("test").disabled = true;
  $("stop").disabled = false;
  $("status").textContent = "Singing live";
  $("sessionTitle").textContent = virtual ? "Test run" : "You’re on the mic";
  $("sessionText").textContent = virtual
    ? "A synthesized voice is singing the target notes, so the score should climb to 100%."
    : "Follow each target note. Accurate notes bring back more of the image.";
  loop();
}

function halt() {
  running = false;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (mic) { try { mic.disconnect(); } catch (e) {} mic = null; }
  if (an) { try { an.disconnect(); } catch (e) {} an = null; }
  if (ctx) { try { ctx.close(); } catch (e) {} ctx = null; }
  $("go").disabled = $("test").disabled = false;
  $("stop").disabled = true;
  $("tgt").classList.remove("active-note");
}

function loop() {
  if (!running || !ctx || !an) return;
  requestAnimationFrame(loop);

  const t = ctx.currentTime - T0;
  const st = t - LL;

  // Detect at ~30 Hz; 60 Hz is unnecessary and expensive on phones.
  let pitch = null;
  if ((tick++ & 1) === 0) {
    an.getFloatTimeDomainData(abuf);
    pitch = detect(abuf, ctx.sampleRate);
    if (pitch && pitch.clarity > .85) capture(st, pitch.hz);
  }

  const cur = findNote(st, 0);
  const upcoming = cur ? null : nextNote(st);
  const shown = cur || (upcoming && upcoming.start - st <= .45 ? upcoming : null);
  $("tgt").textContent = shown ? name(shown.midi) : "–";
  $("tgt").classList.toggle("active-note", !!cur);

  $("livePitch").textContent = "Pitch: " +
    (pitch && pitch.clarity > .85 ? name(Math.round(69 + 12 * Math.log2(pitch.hz / 440))) : "—");

  if (cur && pitch && pitch.clarity > .85) {
    const e = fold(cents(pitch.hz, cur.midi) - keyOff);
    const tol = LEVELS[$("lvl").value].tol;
    $("diff").textContent = Math.abs(e) <= tol ? "In tune"
      : Math.round(Math.abs(e)) + " cents " + (e < 0 ? "flat" : "sharp");
    $("pitchMarker").style.left = (50 + clamp(e / 300, -1, 1) * 45) + "%";
  } else {
    $("diff").textContent = cur ? "Sing the target note"
      : shown ? "Get ready: " + name(shown.midi) : "";
    $("pitchMarker").style.left = "50%";
  }

  drawSpectrum();

  if (t - last > .2) {
    last = t;
    recompute(st);
    drawFreq(st);
  }

  if (N.length && t > N[N.length - 1].end + 1.5) finish();
}

// --------------------------------------------------------------- scoring
function capture(t, f) {
  const n = findNote(t, SLACK);
  if (!n) return;
  const c = fold(cents(f, n.midi));            // octave errors fold to ~0

  if ($("key").checked && t >= N[0].start - .5 && t <= N[0].start + KEY_WINDOW) {
    keySamples.push(c);
    if (keySamples.length > 1500) keySamples.shift();
  }

  const len = Math.max(1, Math.ceil((n.end - n.start) / BIN));
  if (!n.bins) { n.bins = new Float32Array(len); n.bins.fill(EMPTY); }
  const i = clamp(Math.floor((t - n.start) / BIN), 0, n.bins.length - 1);
  if (Math.abs(c) < Math.abs(n.bins[i])) n.bins[i] = c;   // best pitch per 50 ms
}

function recompute(songTime = Infinity) {
  const tol = LEVELS[$("lvl").value].tol;
  keyOff = keyShift();

  let a = 0, b = 0;
  for (const n of N) {
    let sum = 0, counted = 0;
    if (n.bins) {
      // Ignore the first 50 ms bin on notes long enough to have one: a real
      // voice glides in, and the analyser window straddles the note change.
      const skip = n.bins.length >= 4 ? 1 : 0;
      for (let i = skip; i < n.bins.length; i++) {
        counted++;
        const c = n.bins[i];
        if (c === EMPTY) continue;             // silence / skipped note = 0
        const e = Math.abs(fold(c - keyOff));
        sum += e <= tol ? 1 : Math.max(0, 1 - (e - tol) / tol);
      }
      n.score = counted ? sum / counted : 0;
    } else n.score = 0;

    if (n.score > (n.revealScore || 0)) n.revealScore = n.score;
    if (n.start <= songTime) { a += n.score * (n.end - n.start); b += n.end - n.start; }
  }

  total = b ? a / b : 0;
  bestTotal = Math.max(bestTotal, total);
  $("score").textContent = Math.round(total * 100) + "%";
  $("clarity").textContent = Math.round(bestTotal * 100) + "%";
  $("clarityBar").style.width = Math.round(bestTotal * 100) + "%";
}

function keyShift() {
  if (!$("key").checked || keySamples.length < 20) return 0;
  const a = keySamples.slice().sort((x, y) => x - y);
  return fold(a[a.length >> 1]);
}

function resetPerformance() {
  keySamples.length = 0;
  keyOff = 0;
  total = 0;
  bestTotal = 0;
  for (const n of N) { n.score = 0; n.revealScore = 0; n.bins = null; }
}

// --------------------------------------------------- microphone spectrum
const spectrum = $("spectrum"), sx = spectrum.getContext("2d");
function drawSpectrum() {
  if (!an) return;
  const w = Math.max(1, Math.round(spectrum.clientWidth * devicePixelRatio));
  const h = Math.max(1, Math.round(spectrum.clientHeight * devicePixelRatio));
  if (spectrum.width !== w || spectrum.height !== h) { spectrum.width = w; spectrum.height = h; }

  an.getByteFrequencyData(fbuf);
  const W = spectrum.width, H = spectrum.height;
  sx.fillStyle = "#10151c";
  sx.fillRect(0, 0, W, H);

  const bars = 64, bw = W / bars, nyquist = ctx.sampleRate / 2, lo = 55, hi = 6000, range = hi / lo;
  if (!fbuf.length) return;
  for (let i = 0; i < bars; i++) {
    const f0 = lo * Math.pow(range, i / bars), f1 = lo * Math.pow(range, (i + 1) / bars);
    const b0 = clamp(Math.floor(f0 / nyquist * fbuf.length), 0, fbuf.length - 1);
    const b1 = clamp(Math.ceil(f1 / nyquist * fbuf.length), b0 + 1, fbuf.length);
    let v = 0;
    for (let k = b0; k < b1; k++) if (fbuf[k] > v) v = fbuf[k];
    const bh = (v / 255) * (H - 6);
    sx.fillStyle = i % 6 === 0 ? "#ffb454" : "#6596d6";
    sx.fillRect(i * bw, H - bh, Math.max(1, bw - 2), bh);
  }
}

// --------------------------------------------------------------- results
function finish() {
  halt();
  recompute(Infinity);
  drawFreq(Infinity);
  $("status").textContent = "Song complete";
  $("tgt").textContent = "–";
  $("pitchMarker").style.left = "50%";
  $("diff").textContent = "";

  const groups = new Map();
  for (const n of N) {
    if (!groups.has(n.phrase)) groups.set(n.phrase, []);
    groups.get(n.phrase).push(n.score);
  }
  const rows = [...groups.entries()].map(([k, v]) => [k, v.reduce((x, y) => x + y, 0) / v.length]);
  const weakest = Math.min(...rows.map(r => r[1]));

  $("sessionTitle").textContent = "Performance complete";
  $("sessionText").textContent = "Your final accuracy is " + Math.round(total * 100) +
    "%. Sing it again to bring back more of the image.";

  let h = "";
  for (const [k, v] of rows) {
    h += '<div class="line">Line ' + (k + 1) + (v === weakest ? " (weakest)" : "") + " · " +
      Math.round(v * 100) + '%<div class="bar' + (v === weakest ? " weak" : "") +
      '" style="width:' + Math.max(2, v * 100) + '%"></div></div>';
  }
  $("res").innerHTML = h + '<p class="line">Original picture</p>';
  const o = document.createElement("canvas");
  o.width = o.height = S;
  o.className = "orig";
  o.getContext("2d").drawImage(src, 0, 0);
  $("res").append(o);
}

$("go").onclick = () => start(false);
$("test").onclick = () => start(true);
$("stop").onclick = () => {
  halt();
  $("status").textContent = "Stopped";
  $("diff").textContent = "";
  $("pitchMarker").style.left = "50%";
};

function resetDisplay() {
  $("res").innerHTML = "";
  $("msg").textContent = "";
  $("status").textContent = "Waiting to start";
  $("score").textContent = "—";
  $("clarity").textContent = "0%";
  $("clarityBar").style.width = "0%";
  $("tgt").textContent = "–";
  $("diff").textContent = "Start the song to begin";
  $("pitchMarker").style.left = "50%";
  $("livePitch").textContent = "Pitch: —";
  $("sessionTitle").textContent = "Ready when you are";
  $("sessionText").textContent = "Pick an image (or use the built-in one), then press Start singing. Everything stays in your browser.";
}

$("resetBtn").onclick = () => {
  if (running) halt();
  resetPerformance();
  resetDisplay();
  drawFreq(-1);
};

$("lvl").onchange = () => {
  if (!running) return;
  const st = ctx.currentTime - T0 - LL;
  recompute(st);
  drawFreq(st);
};
$("key").onchange = () => {
  if (!running) return;
  const st = ctx.currentTime - T0 - LL;
  recompute(st);
  drawFreq(st);
};

// --------------------------------------------------------------- start up
layout();
drawFreq(-1);
