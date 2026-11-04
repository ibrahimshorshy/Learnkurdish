// Tiny WebAudio synth: arcade SFX + a looping chiptune bed. Everything is generated, no files.
export class Sfx {
  constructor() { this.ctx = null; this.on = true; this._timer = null; }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    this.dest = this.ctx.createMediaStreamDestination();
    this.master.connect(this.ctx.destination);
    this.master.connect(this.dest);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.22;
    this.musicGain.connect(this.master);
    const n = this.ctx.sampleRate * 2;
    this.noiseBuf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  resume() { this.init(); if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  tone({ f = 440, f2 = null, type = 'square', dur = 0.15, vol = 0.3, delay = 0, out = null }) {
    if (!this.ctx || !this.on) return;
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out || this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  noise({ dur = 0.3, vol = 0.4, f = 1800, f2 = 200, delay = 0, type = 'lowpass' }) {
    if (!this.ctx || !this.on) return;
    const c = this.ctx, t = c.currentTime + delay;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf;
    const fl = c.createBiquadFilter(); fl.type = type;
    fl.frequency.setValueAtTime(f, t); fl.frequency.exponentialRampToValueAtTime(Math.max(40, f2), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl).connect(g).connect(this.master);
    s.start(t, Math.random()); s.stop(t + dur + 0.02);
  }

  step() { this.tone({ f: 520, f2: 760, type: 'square', dur: 0.07, vol: 0.12 }); this.noise({ dur: 0.06, vol: 0.12, f: 3000, f2: 900, type: 'highpass' }); }
  hop() { this.tone({ f: 300, f2: 620, type: 'square', dur: 0.12, vol: 0.14 }); }
  whoosh() { this.noise({ dur: 0.32, vol: 0.22, f: 400, f2: 4000, type: 'bandpass' }); }
  charge() { this.tone({ f: 120, f2: 900, type: 'sawtooth', dur: 0.45, vol: 0.12 }); }
  hit(power = 1) {
    this.tone({ f: 160, f2: 38, type: 'sine', dur: 0.4, vol: 0.9 * Math.min(1, power) });
    this.noise({ dur: 0.38, vol: 0.55 * power, f: 5000, f2: 150 });
    this.tone({ f: 880, f2: 220, type: 'square', dur: 0.12, vol: 0.22 });
    this.tone({ f: 1320, f2: 330, type: 'square', dur: 0.1, vol: 0.14, delay: 0.04 });
  }
  boom() {
    this.tone({ f: 90, f2: 24, type: 'sine', dur: 1.1, vol: 1.0 });
    this.noise({ dur: 1.4, vol: 0.9, f: 3500, f2: 60 });
    this.tone({ f: 400, f2: 50, type: 'sawtooth', dur: 0.7, vol: 0.25 });
  }
  check() { for (let i = 0; i < 3; i++) { this.tone({ f: 880, type: 'square', dur: 0.09, vol: 0.2, delay: i * 0.17 }); this.tone({ f: 660, type: 'square', dur: 0.09, vol: 0.2, delay: i * 0.17 + 0.08 }); } }
  stamp() { this.tone({ f: 110, f2: 50, type: 'sine', dur: 0.25, vol: 0.7 }); this.noise({ dur: 0.12, vol: 0.3, f: 2500, f2: 300 }); }
  ding(ok = true) { const n = ok ? [988, 1319] : [330, 247]; n.forEach((f, i) => this.tone({ f, type: 'square', dur: 0.12, vol: 0.2, delay: i * 0.09 })); }
  ufo() { for (let i = 0; i < 12; i++) this.tone({ f: 500 + (i % 2) * 180 + i * 25, type: 'sine', dur: 0.14, vol: 0.12, delay: i * 0.11 }); }
  beam() { this.tone({ f: 200, f2: 1400, type: 'sawtooth', dur: 0.9, vol: 0.12 }); }
  laser() { this.tone({ f: 2400, f2: 300, type: 'sawtooth', dur: 0.5, vol: 0.2 }); }
  fanfare() { [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone({ f, type: 'square', dur: 0.18, vol: 0.2, delay: i * 0.13 })); }
  fight() { this.tone({ f: 196, type: 'sawtooth', dur: 0.35, vol: 0.3 }); this.tone({ f: 392, type: 'square', dur: 0.5, vol: 0.25, delay: 0.2 }); }

  // ---- chiptune bed (A minor, 150 bpm) ----
  startMusic() {
    if (!this.ctx || this._timer) return;
    this._step = 0;
    this._next = this.ctx.currentTime + 0.05;
    const spb = 60 / 150 / 4; // sixteenth
    const bass = [57, 57, 69, 57, 57, 57, 69, 57, 53, 53, 65, 53, 55, 55, 67, 55];
    const arp = [0, 4, 7, 12, 7, 4, 0, 4, 5, 9, 12, 17, 7, 11, 14, 19];
    const root = [57, 57, 53, 55];
    this._timer = setInterval(() => {
      while (this._next < this.ctx.currentTime + 0.25) {
        const s = this._step, bar = Math.floor(s / 16) % 4, i = s % 16;
        const t = this._next - this.ctx.currentTime;
        const mf = (n) => 440 * Math.pow(2, (n - 69) / 12);
        if (this.on) {
          this.tone({ f: mf(bass[i] + (bar === 2 ? -4 : bar === 3 ? -2 : 0) - 12), type: 'triangle', dur: spb * 1.6, vol: 0.5, delay: t, out: this.musicGain });
          if (i % 2 === 0 || bar > 1) this.tone({ f: mf(root[bar] + 12 + arp[i]), type: 'square', dur: spb * 0.9, vol: 0.16, delay: t, out: this.musicGain });
          if (i % 4 === 0) this.tone({ f: 140, f2: 45, type: 'sine', dur: 0.16, vol: 0.9, delay: t, out: this.musicGain });
          if (i % 4 === 2) this.noiseAt(t, 0.05, 0.25);
          if (i % 8 === 4) this.noiseAt(t, 0.12, 0.35, 1800);
        }
        this._next += spb;
        this._step++;
      }
    }, 60);
  }
  noiseAt(delay, dur, vol, f = 7000) {
    const c = this.ctx, t = c.currentTime + delay;
    const s = c.createBufferSource(); s.buffer = this.noiseBuf;
    const fl = c.createBiquadFilter(); fl.type = 'highpass'; fl.frequency.value = f / 2;
    const g = c.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(fl).connect(g).connect(this.musicGain); s.start(t, Math.random()); s.stop(t + dur + 0.02);
  }
  stopMusic() { clearInterval(this._timer); this._timer = null; }
  duck(v) { if (this.musicGain) this.musicGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1); }
}
