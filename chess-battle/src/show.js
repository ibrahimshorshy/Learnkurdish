// The 3D battle: scene, plan (timeline), per-ply animation, effects, camera.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { Chess } from 'chess.js';
import { makePiece, tintPiece, resetTint, setGlow, TEAM } from './pieces.js';
import { PGN, CAPTIONS, CONFIG } from './data.js';
import { parsePgn } from './pgn.js';

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const NAME = { p: 'PAWN', n: 'KNIGHT', b: 'BISHOP', r: 'ROOK', q: 'QUEEN', k: 'KING' };
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeIn = (t) => t * t * t;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIO = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerpAngle = (a, b, t) => { let d = ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; return a + d * t; };
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export const sqPos = (sq) => new THREE.Vector3(sq.charCodeAt(0) - 97 - 3.5, 0.06, 3.5 - (sq.charCodeAt(1) - 49));
const FACE_CAM = Math.PI; // camera sits behind Black (-Z), pieces look at it

export const INTRO = 3.2;
const QUALITY = {
  Brilliant: { sym: '!!', label: 'BRILLIANT', color: '#1fe0c8' },
  GreatFind: { sym: '!', label: 'GREAT FIND', color: '#5ab0ff' },
  Inaccuracy: { sym: '?!', label: 'INACCURACY', color: '#ffd23f' },
  Mistake: { sym: '?', label: 'MISTAKE', color: '#ff9a2e' },
  Blunder: { sym: '??', label: 'BLUNDER', color: '#ff3b5c' },
  Miss: { sym: '✕', label: 'MISS', color: '#ff5a7a' },
};
const POW = ['POW!', 'BAM!', 'SMASH!', 'CRUNCH!', 'WHAM!', 'KAPOW!'];

export class Show {
  constructor(W, H) {
    this.W = W; this.H = H;
    this.pace = 1.15;
    this.glCanvas = document.createElement('canvas');
    this.buildScene();
    this.buildPlan();
    this.reset();
  }

  // ---------------------------------------------------------------- scene
  buildScene() {
    const { W, H } = this;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: this.glCanvas, antialias: true, powerPreference: 'high-performance' }));
    r.setPixelRatio(1);
    r.setSize(W, H, false);
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.05;
    const scene = (this.scene = new THREE.Scene());
    scene.fog = new THREE.FogExp2(0x12062e, 0.018);
    this.camera = new THREE.PerspectiveCamera(66, W / H, 0.1, 400);

    scene.add(new THREE.HemisphereLight(0xb9a8ff, 0x1a0b3a, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(-5, 12, -6);
    scene.add(key);
    const pink = new THREE.PointLight(0xff3d8e, 90, 40); pink.position.set(5, 6, -8); scene.add(pink);
    const cyan = new THREE.PointLight(0x19d9ff, 90, 40); cyan.position.set(-5, 6, 8); scene.add(cyan);
    this.fxLight = new THREE.PointLight(0xffffff, 0, 18, 1.6); scene.add(this.fxLight);

    // sky dome
    const sky = new THREE.Mesh(new THREE.SphereGeometry(180, 32, 16), new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      vertexShader: 'varying vec3 p; void main(){ p=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `varying vec3 p; void main(){ float h=normalize(p).y;
        vec3 lo=vec3(.75,.1,.42), mid=vec3(.22,.04,.5), hi=vec3(.015,.0,.08);
        vec3 c=mix(lo,mid,smoothstep(0.,.18,h)); c=mix(c,hi,smoothstep(.12,.7,h)); gl_FragColor=vec4(c*.6,1.); }`,
    }));
    scene.add(sky);
    // retro sun (far side of the board)
    const sun = new THREE.Mesh(new THREE.CircleGeometry(30, 64), new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      vertexShader: 'varying vec2 u; void main(){ u=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `varying vec2 u; void main(){ vec2 q=u-.5; float d=length(q);
        float band=step(.0, sin((u.y*60.)+0.)) ; float cut=smoothstep(.55,.0,u.y)*.9;
        float stripe=mix(1.,step(.5,fract(u.y*14.)),cut);
        vec3 c=mix(vec3(1.,.8,.2),vec3(1.,.1,.5),1.-u.y)*.8;
        float a=smoothstep(.5,.485,d)*stripe; gl_FragColor=vec4(c,a); }`,
    }));
    sun.position.set(0, 16, 120); sun.rotation.y = Math.PI; scene.add(sun);
    // stars
    const sp = new Float32Array(900 * 3), rn = rng(7);
    for (let i = 0; i < 900; i++) { const a = rn() * 6.283, e = rn() * 1.2 + 0.05, R = 150; sp[i * 3] = Math.cos(a) * Math.cos(e) * R; sp[i * 3 + 1] = Math.sin(e) * R * 0.8 + 6; sp[i * 3 + 2] = Math.sin(a) * Math.cos(e) * R; }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ size: 1.2, color: 0xffffff, fog: false, sizeAttenuation: false })));
    // neon floor grid + mountains
    const grid = new THREE.GridHelper(300, 100, 0xff3d8e, 0x7a3cff);
    grid.position.y = -2.2; grid.material.fog = true; scene.add(grid);
    this.grid = grid;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshBasicMaterial({ color: 0x0b0320 }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -2.25; scene.add(floor);
    const mg = new THREE.Group();
    for (let i = 0; i < 18; i++) {
      const hgt = 6 + rn() * 14, w = 6 + rn() * 8;
      const m = new THREE.Mesh(new THREE.ConeGeometry(w, hgt, 4), new THREE.MeshBasicMaterial({ color: 0x1b0a46, wireframe: false }));
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry), new THREE.LineBasicMaterial({ color: 0xff3d8e }));
      m.add(e);
      m.position.set((i - 9) * 13 + rn() * 5, hgt / 2 - 2.2, 85 + rn() * 14);
      m.rotation.y = rn();
      mg.add(m);
    }
    scene.add(mg);

    // board
    const bg = (this.boardGroup = new THREE.Group());
    const slab = new THREE.Mesh(new THREE.BoxGeometry(8.7, 0.5, 8.7), new THREE.MeshStandardMaterial({ color: 0x120830, metalness: 0.5, roughness: 0.3 }));
    slab.position.y = -0.25; bg.add(slab);
    const edge = new THREE.Mesh(new THREE.BoxGeometry(8.9, 0.1, 8.9), new THREE.MeshBasicMaterial({ color: 0xff3d8e, toneMapped: false }));
    edge.position.y = -0.38; bg.add(edge);
    const edge2 = new THREE.Mesh(new THREE.BoxGeometry(8.76, 0.06, 8.76), new THREE.MeshBasicMaterial({ color: 0x19d9ff, toneMapped: false }));
    edge2.position.y = -0.02; bg.add(edge2);
    this.sqMesh = {};
    this.sqBase = {};
    const sqGeo = new THREE.BoxGeometry(0.97, 0.1, 0.97);
    for (let f = 0; f < 8; f++) for (let rk = 0; rk < 8; rk++) {
      const name = String.fromCharCode(97 + f) + (rk + 1);
      const light = (f + rk) % 2 === 1;
      const base = light ? 0x5a3fd0 : 0x1c1050;
      const m = new THREE.Mesh(sqGeo, new THREE.MeshStandardMaterial({ color: base, metalness: 0.35, roughness: 0.25, emissive: base, emissiveIntensity: 0.25 }));
      const p = sqPos(name); m.position.set(p.x, 0.01, p.z);
      bg.add(m); this.sqMesh[name] = m; this.sqBase[name] = base;
    }
    scene.add(bg);

    // pieces (created once)
    this.pieceObjs = {};
    const board = new Chess().board();
    board.forEach((row, ri) => row.forEach((p, fi) => {
      if (!p) return;
      const sq = String.fromCharCode(97 + fi) + (8 - ri);
      const id = p.color + p.type + sq;
      const g = makePiece(p.type, p.color);
      scene.add(g);
      this.pieceObjs[id] = { id, g, type: p.type, color: p.color, home: sq, sq, phase: Math.random() * 6.28, alive: true };
    }));
    this.kingId = { w: 'wke1', b: 'bke8' };

    // instanced debris + sparks
    const mk = (n, geo, mat) => { const im = new THREE.InstancedMesh(geo, mat, n); im.frustumCulled = false; im.count = n; const d = new THREE.Object3D(); d.scale.setScalar(0); d.updateMatrix(); for (let i = 0; i < n; i++) { im.setMatrixAt(i, d.matrix); im.setColorAt(i, new THREE.Color(1, 1, 1)); } this.scene.add(im); return im; };
    this.debris = { im: mk(700, new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.4, metalness: 0.2 })), n: 700, i: 0, p: [] };
    this.sparks = { im: mk(900, new THREE.OctahedronGeometry(1), new THREE.MeshBasicMaterial({ toneMapped: false })), n: 900, i: 0, p: [] };
    for (const s of [this.debris, this.sparks]) for (let i = 0; i < s.n; i++) s.p.push({ life: 0, max: 1, pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Vector3(), rv: new THREE.Vector3(), size: 0, drag: 0, g: 0, shrink: true, col: new THREE.Color() });

    this.fx = []; // rings, beams, slashes …
    this.ringGeo = new THREE.RingGeometry(0.85, 1, 48);
    this.beamGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);

    // UFO
    const ufo = (this.ufo = new THREE.Group());
    const hull = new THREE.Mesh(new THREE.LatheGeometry([[0.001, -0.18], [0.6, -0.1], [1.5, 0.0], [1.6, 0.1], [0.9, 0.22], [0.001, 0.25]].map(([a, b]) => new THREE.Vector2(a, b)), 32), new THREE.MeshStandardMaterial({ color: 0xb8c4d8, metalness: 0.8, roughness: 0.25, emissive: 0x2a3a60, emissiveIntensity: 0.6 }));
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.62, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7cff4d, transparent: true, opacity: 0.8, toneMapped: false }));
    dome.position.y = 0.2;
    ufo.add(hull, dome);
    this.ufoLights = [];
    for (let k = 0; k < 10; k++) { const a = (k / 10) * 6.283; const l = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshBasicMaterial({ color: k % 2 ? 0xffd23f : 0xff3d8e, toneMapped: false })); l.position.set(Math.cos(a) * 1.3, 0.03, Math.sin(a) * 1.3); ufo.add(l); this.ufoLights.push(l); }
    ufo.visible = false; scene.add(ufo);
    this.tractor = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 1.25, 1, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x7cff4d, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.tractor.visible = false; scene.add(this.tractor);

    // post
    const comp = (this.composer = new EffectComposer(r));
    comp.setSize(W, H);
    comp.addPass(new RenderPass(scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.75, 0.55, 0.9);
    comp.addPass(this.bloom);
    this.post = new ShaderPass({
      uniforms: { tDiffuse: { value: null }, amt: { value: 0 }, flash: { value: 0 }, red: { value: 0 }, time: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform float amt, flash, red, time; varying vec2 vUv;
        void main(){ vec2 d=vUv-.5; float r=length(d); vec2 o=d*amt*(0.6+r);
          vec3 c=vec3(texture2D(tDiffuse,vUv+o).r,texture2D(tDiffuse,vUv).g,texture2D(tDiffuse,vUv-o).b);
          c*=1.-smoothstep(.45,.95,r)*.55; c+=vec3(1.,.95,.9)*flash; c=mix(c,c*vec3(1.6,.35,.4),red*smoothstep(.2,.9,r)+red*.15);
          gl_FragColor=vec4(c,1.); }`,
    });
    comp.addPass(this.post);
    comp.addPass(new OutputPass());
  }

  resize(W, H) {
    this.W = W; this.H = H;
    this.renderer.setSize(W, H, false);
    this.composer.setSize(W, H);
    this.bloom.resolution.set(W, H);
    this.camera.aspect = W / H; this.camera.clearViewOffset(); this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------- plan
  buildPlan() {
    const { headers, plies } = parsePgn(PGN);
    this.headers = headers;
    this.plies = plies;
    const chess = new Chess();
    const map = {};
    chess.board().forEach((row, ri) => row.forEach((p, fi) => { if (p) { const sq = String.fromCharCode(97 + fi) + (8 - ri); map[sq] = p.color + p.type + sq; } }));
    const mat = { w: 39, b: 39 };
    this.actions = plies.map((p) => {
      const a = { ...p, id: map[p.from], capId: null, rook: null, matAfter: null };
      let capSq = p.captured ? p.to : null;
      if (p.flags.includes('e')) capSq = p.to[0] + p.from[1];
      if (capSq) { a.capId = map[capSq]; a.capSq = capSq; delete map[capSq]; mat[p.color === 'w' ? 'b' : 'w'] -= VAL[p.captured]; }
      delete map[p.from]; map[p.to] = a.id;
      if (p.flags.includes('k') || p.flags.includes('q')) {
        const rk = p.from[1], ks = p.flags.includes('k');
        const rf = (ks ? 'h' : 'a') + rk, rt = (ks ? 'f' : 'd') + rk;
        a.rook = { id: map[rf], from: rf, to: rt };
        delete map[rf]; map[rt] = a.rook.id;
      }
      a.matAfter = { ...mat };
      const cap = CAPTIONS[p.i];
      a.caption = cap || null;
      const q = p.effects.find((e) => QUALITY[e.type] && e.sq === p.to);
      a.quality = q ? QUALITY[q.type] : null;
      return a;
    });
    this.layout();
  }

  layout() {
    let t = INTRO;
    const pace = this.pace;
    this.plan = this.actions.map((a, i) => {
      let base = i < 8 ? 0.42 : 0.55;
      if (a.capId) base = 1.5;
      if (a.rook) base = 0.95;
      if (a.check && !a.capId) base += 0.4;
      if (a.caption) base = Math.max(base, a.caption.dur);
      if (a.mate) base = 7.4;
      if (i === 8) base = 3.7;
      const dur = base / pace;
      const p = { a, i, base, dur, start: t, speed: base / dur, started: false, fired: {} };
      t += dur;
      return p;
    });
    this.endT = t + 1.6;
    this.total = this.endT;
  }
  setPace(p) { this.pace = p; this.layout(); }

  // ---------------------------------------------------------------- state
  reset() {
    this.t = 0; this.rt = 0; this.cur = 0; this.freeze = 0; this.slow = 1;
    this.rand = rng(1234);
    for (const o of Object.values(this.pieceObjs)) {
      o.sq = o.home; o.alive = true; o.g.visible = true; resetTint(o.g);
      o.g.position.copy(sqPos(o.home)); o.g.rotation.set(0, FACE_CAM, 0); o.g.scale.setScalar(1); o.rage = 0; o.pulse = 0;
      if (o.type !== o.g.userData.type) { /* promotions unsupported in this game */ }
    }
    for (const s of [this.debris, this.sparks]) { for (const p of s.p) p.life = 0; s.i = 0; this.flush(s); }
    for (const f of this.fx) this.scene.remove(f.mesh);
    this.fx = [];
    this.ufo.visible = false; this.tractor.visible = false;
    this.hp = { w: 1, b: 1 }; this.hpShow = { w: 1, b: 1 };
    this.score = { w: 0, b: 0 };
    this.clocks = { w: 180, b: 180 };
    this.hits = { w: 0, b: 0 };
    this.chain = { side: null, n: 0 };
    this.lastCap = null;
    this.banners = []; this.floaters = []; this.words = [];
    this.badge = null; this.lastMove = null; this.checkedKing = null;
    this.shake = 0; this.roll = 0; this.flash = 0; this.redFx = 0; this.aberr = 0;
    this.cam = { az: 0, el: 0, dist: 0, look: new THREE.Vector3(0, 0, 0), zoom: 0, focus: new THREE.Vector3(0, 0, 0), orbit: 0, init: false };
    this.over = false; this.ko = 0; this.confettiOn = false;
    for (const k in this.sqMesh) { const m = this.sqMesh[k].material; m.color.set(this.sqBase[k]); m.emissive.set(this.sqBase[k]); m.emissiveIntensity = 0.25; }
    this.sfxEvents = [];
    this.updateCamera(0.016, true);
  }

  seek(t) { // deterministic re-simulation (used by tests and the scrubber)
    this.reset();
    const dt = 1 / 60;
    for (let s = 0; s < t / dt; s++) this.advance(dt, true);
  }

  // ---------------------------------------------------------------- effects helpers
  emit(sys, o) {
    const p = sys.p[sys.i]; sys.i = (sys.i + 1) % sys.n;
    p.life = p.max = o.life; p.pos.copy(o.pos); p.vel.copy(o.vel);
    p.rot.set(this.rand() * 6, this.rand() * 6, this.rand() * 6); p.rv.set((this.rand() - 0.5) * 14, (this.rand() - 0.5) * 14, (this.rand() - 0.5) * 14);
    p.size = o.size; p.drag = o.drag ?? 0.4; p.g = o.g ?? 14; p.col.set(o.color); p.shrink = o.shrink ?? true;
  }
  burst(pos, color, n, speed, size, life, up = 5) {
    for (let k = 0; k < n; k++) {
      const a = this.rand() * 6.283, e = this.rand() * 1.1 - 0.15, s = speed * (0.4 + this.rand() * 0.8);
      this.emit(this.debris, { pos: pos.clone().add(new THREE.Vector3(0, 0.5, 0)), vel: new THREE.Vector3(Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s * 0.9 + up, Math.sin(a) * Math.cos(e) * s), color, size: size * (0.5 + this.rand()), life: life * (0.7 + this.rand() * 0.6) });
    }
  }
  sparkBurst(pos, color, n, speed, size = 0.09, life = 0.7, g = 9) {
    for (let k = 0; k < n; k++) {
      const a = this.rand() * 6.283, e = (this.rand() - 0.3) * 1.5, s = speed * (0.3 + this.rand());
      this.emit(this.sparks, { pos: pos.clone().add(new THREE.Vector3(0, 0.6, 0)), vel: new THREE.Vector3(Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + 2, Math.sin(a) * Math.cos(e) * s), color, size: size * (0.4 + this.rand()), life: life * (0.6 + this.rand() * 0.8), g, drag: 1.2 });
    }
  }
  ring(pos, color, max = 3, dur = 0.55, y = 0.12, thick = 1) {
    const mesh = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    mesh.rotation.x = -Math.PI / 2; mesh.position.set(pos.x, y, pos.z); this.scene.add(mesh);
    this.fx.push({ kind: 'ring', mesh, age: 0, dur, max, thick });
  }
  blast(pos, color, max = 2.2, dur = 0.4) {
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    mesh.position.set(pos.x, 0.7, pos.z); this.scene.add(mesh);
    this.fx.push({ kind: 'blast', mesh, age: 0, dur, max });
  }
  beamFx(a, b, color, dur, width = 0.12) {
    const mesh = new THREE.Mesh(this.beamGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    const dir = b.clone().sub(a), len = dir.length();
    mesh.position.copy(a).add(b).multiplyScalar(0.5);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    mesh.scale.set(width, len, width);
    this.scene.add(mesh);
    this.fx.push({ kind: 'beam', mesh, age: 0, dur, width, len });
  }
  slash(pos, dirYaw, color) {
    const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.09, 6, 24, 2.4), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
    mesh.position.set(pos.x, 0.9, pos.z); mesh.rotation.set(0.5, dirYaw, 0); this.scene.add(mesh);
    this.fx.push({ kind: 'slash', mesh, age: 0, dur: 0.28, max: 1.8 });
  }
  flushFx(dt) {
    this.fx = this.fx.filter((f) => {
      f.age += dt; const u = f.age / f.dur;
      if (u >= 1) { this.scene.remove(f.mesh); f.mesh.material.dispose(); return false; }
      if (f.kind === 'ring') { const s = 0.2 + f.max * easeOut(u); f.mesh.scale.setScalar(s); f.mesh.material.opacity = (1 - u) * 0.95; }
      else if (f.kind === 'blast') { f.mesh.scale.setScalar(0.3 + f.max * easeOut(u)); f.mesh.material.opacity = (1 - u) * 0.9; }
      else if (f.kind === 'beam') { f.mesh.scale.x = f.mesh.scale.z = f.width * (u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8 * 0.9) * (1 + Math.sin(f.age * 60) * 0.15); f.mesh.material.opacity = u > 0.7 ? (1 - u) / 0.3 : 1; }
      else if (f.kind === 'slash') { const s = 0.5 + f.max * easeOut(u); f.mesh.scale.setScalar(s); f.mesh.material.opacity = 1 - u; f.mesh.rotation.z += 0.2; }
      return true;
    });
  }
  updateParticles(sys, dt) {
    const d = new THREE.Object3D();
    for (let i = 0; i < sys.n; i++) {
      const p = sys.p[i];
      if (p.life > 0) {
        p.life -= dt;
        p.vel.y -= p.g * dt; p.vel.multiplyScalar(1 - Math.min(1, p.drag * dt));
        p.pos.addScaledVector(p.vel, dt);
        if (p.pos.y < 0.1 && p.g > 0 && sys === this.debris) { p.pos.y = 0.1; p.vel.y *= -0.35; p.vel.x *= 0.7; p.vel.z *= 0.7; p.rv.multiplyScalar(0.6); }
        p.rot.addScaledVector(p.rv, dt);
        const k = p.life > 0 ? (p.shrink ? Math.min(1, p.life / (p.max * 0.4)) : 1) : 0;
        d.position.copy(p.pos); d.rotation.set(p.rot.x, p.rot.y, p.rot.z); d.scale.setScalar(p.size * k);
      } else d.scale.setScalar(0);
      d.updateMatrix(); sys.im.setMatrixAt(i, d.matrix);
      if (p.life > 0 || p.life > -0.02) sys.im.setColorAt(i, p.col);
    }
    sys.im.instanceMatrix.needsUpdate = true;
    if (sys.im.instanceColor) sys.im.instanceColor.needsUpdate = true;
  }
  flush(sys) { this.updateParticles(sys, 0); }

  banner(text, color, dur = 1.0, size = 150, y = 0.38, sub = '') { this.banners.push({ text, color, t0: this.rt, dur, size, y, sub }); }
  addShake(v) { this.shake = Math.max(this.shake, v); }
  hit(pos, power = 1) { this.freeze = 0.05 + 0.05 * power; this.addShake(0.35 * power); this.flash = Math.max(this.flash, 0.28 * power); this.aberr = 0.012 * power; this.roll = (this.rand() - 0.5) * 0.09 * power; }
  sfx(name, ...a) { this.sfxEvents.push([name, a]); }

  // ---------------------------------------------------------------- timeline
  advance(dt, silent = false) {
    this.rt += dt;
    let pdt = dt;
    if (this.freeze > 0) { this.freeze -= dt; pdt = dt * 0.04; }
    pdt *= this.slow;
    this.t += pdt;
    this.runTimeline();
    this.updateHp(dt);
    this.updateFx(dt);
    this.updateCamera(dt);
    if (silent) this.sfxEvents.length = 0;
  }

  runTimeline() {
    if (this.t < INTRO) { this.intro(this.t); }
    for (;;) {
      const p = this.plan[this.cur];
      if (!p) break;
      if (this.t < p.start) break;
      if (!p.started) this.beginPly(p);
      const lt = this.t - p.start;
      if (lt >= p.dur) { this.animatePly(p, p.base); this.endPly(p); this.cur++; continue; }
      this.animatePly(p, lt * p.speed);
      break;
    }
    if (this.cur >= this.plan.length && !this.over) { this.over = true; }
    this.updateIdle();
  }

  intro(t) {
    if (!this.introFired) { this.introFired = true; this.sfx('fight'); }
  }

  beginPly(p) {
    p.started = true;
    const a = p.a;
    this.activeIds = new Set([a.id, a.capId, a.rook && a.rook.id].filter(Boolean));
    this.lastMove = { from: a.from, to: a.to, t0: this.rt, color: a.color };
    this.checkedKing = null;
    if (a.clock != null) this.clocks[a.color] = a.clock;
    const o = this.pieceObjs[a.id];
    this.cam.focus.copy(sqPos(a.from)).lerp(sqPos(a.to), 0.5);
    this.cam.zoom = a.capId ? 0.55 : 0.12;
    this.cam.zoomT = this.rt;
    this.cam.dutch = 0;
    if (a.mate) { this.cam.focus.copy(sqPos('g2')); }
    p.dir = sqPos(a.to).sub(sqPos(a.from));
    p.dist = p.dir.length();
    p.yaw = Math.atan2(p.dir.x, p.dir.z);
  }

  endPly(p) {
    const a = p.a;
    const o = this.pieceObjs[a.id];
    o.sq = a.to;
    o.g.position.copy(sqPos(a.to)); o.g.rotation.set(0, FACE_CAM, 0); o.g.scale.setScalar(1);
    if (a.capId) { const v = this.pieceObjs[a.capId]; v.alive = false; v.g.visible = false; }
    if (a.rook) { const r = this.pieceObjs[a.rook.id]; r.sq = a.rook.to; r.g.position.copy(sqPos(a.rook.to)); r.g.rotation.set(0, FACE_CAM, 0); r.g.scale.setScalar(1); }
    this.activeIds = new Set();
  }

  fireOnce(p, key, fn) { if (!p.fired[key]) { p.fired[key] = true; fn(); } }

  updateIdle() {
    for (const o of Object.values(this.pieceObjs)) {
      if (!o.alive) continue;
      if (this.activeIds && this.activeIds.has(o.id)) continue;
      const base = sqPos(o.sq);
      const b = Math.sin(this.rt * 3 + o.phase);
      o.g.position.set(base.x, base.y + (o.rage ? Math.abs(Math.sin(this.rt * 14)) * 0.06 : 0), base.z);
      o.g.scale.set(1 + b * 0.012, 1 - b * 0.018, 1 + b * 0.012);
      o.g.rotation.y = FACE_CAM + Math.sin(this.rt * 1.7 + o.phase) * 0.12 + (o.rage ? Math.sin(this.rt * 40) * 0.05 : 0);
      if (o.pulse) { const k = 0.5 + 0.5 * Math.sin(this.rt * 16); setGlow(o.g, 0xff2030, 0.5 + k * 1.6); }
      if (o.rage) { setGlow(o.g, 0xff4a10, 0.9 + Math.sin(this.rt * 18) * 0.5); if (Math.floor(this.rt * 40) % 2 === 0) this.emit(this.sparks, { pos: base.clone().add(new THREE.Vector3((this.rand() - 0.5) * 0.4, 0.4 + this.rand() * 0.8, (this.rand() - 0.5) * 0.4)), vel: new THREE.Vector3((this.rand() - 0.5) * 0.8, 2.2 + this.rand() * 1.5, (this.rand() - 0.5) * 0.8), color: this.rand() > 0.5 ? 0xff7a18 : 0xffd23f, size: 0.09, life: 0.55, g: -1 }); }
    }
    // highlighted squares
    for (const k in this.sqMesh) { const m = this.sqMesh[k].material; m.emissive.set(this.sqBase[k]); m.emissiveIntensity = 0.25; }
    if (this.lastMove) {
      const col = this.lastMove.color === 'w' ? 0x19d9ff : 0xff3d8e;
      for (const s of [this.lastMove.from, this.lastMove.to]) { const m = this.sqMesh[s].material; m.emissive.set(col); m.emissiveIntensity = 0.9 + Math.sin(this.rt * 8) * 0.25; }
    }
  }

  // ---------------------------------------------------------------- per-ply animation (bt = base seconds since ply start)
  place(o, pos, yaw, sx = 1, sy = 1, sz = 1) { o.g.position.copy(pos); o.g.rotation.set(0, yaw, 0); o.g.scale.set(sx, sy, sz); }

  animatePly(p, bt) {
    const a = p.a;
    const o = this.pieceObjs[a.id];
    const from = sqPos(a.from), to = sqPos(a.to);
    if (a.i === 8) return this.animAlien(p, bt, o, from, to);
    if (a.mate) return this.animMate(p, bt, o, from, to);
    if (a.capId) this.animCapture(p, bt, o, from, to);
    else this.animQuiet(p, bt, o, from, to);

    if (a.rook) {
      const r = this.pieceObjs[a.rook.id], rf = sqPos(a.rook.from), rt = sqPos(a.rook.to);
      const u = clamp((bt - 0.1) / 0.6);
      const pos = rf.clone().lerp(rt, easeIO(u)); pos.y += Math.sin(u * Math.PI) * 0.7;
      this.place(r, pos, lerpAngle(p.yaw, FACE_CAM, clamp(u * 1.4)));
      this.fireOnce(p, 'castle', () => { this.banner('CASTLE!', '#ffd23f', 0.9, 120, 0.4); this.sfx('stamp'); });
      this.fireOnce(p, 'castleland', () => { if (u >= 1) { this.ring(rt, 0xffd23f, 2.4, 0.5); this.sfx('step'); } });
    }
    // check & quality come after the move lands
    const landT = a.capId ? 0.62 : (a.rook ? 0.7 : 0.38);
    if (bt >= landT) {
      if (a.check && !a.mate) this.fireOnce(p, 'check', () => {
        const kid = this.kingId[a.color === 'w' ? 'b' : 'w'];
        this.checkedKing = kid; this.pieceObjs[kid].pulse = 1;
        this.banner('CHECK!', '#ff3b5c', 0.9, 170, 0.42); this.sfx('check'); this.addShake(0.25); this.redFx = 0.6;
        this.ring(sqPos(this.pieceObjs[kid].sq), 0xff2030, 3, 0.6);
        this.score[a.color] += 50;
      });
      if (a.quality) this.fireOnce(p, 'quality', () => { this.badge = { q: a.quality, sq: a.to, t0: this.rt }; this.sfx('ding', ['Brilliant', 'GreatFind'].some((k) => QUALITY[k] === a.quality)); });
    }
    if (bt >= 0.2 && a.caption) this.fireOnce(p, 'caption', () => { this.capStart = this.rt; if (a.caption.kind !== 'alien' && a.i !== 69) this.sfx('stamp'); });
    if (a.i === 21 && bt > 0.45) this.fireOnce(p, 'rage', () => { o.rage = 1; this.ring(sqPos(a.to), 0xff4a10, 3.5, 0.7); this.addShake(0.4); this.sfx('boom'); this.blast(sqPos(a.to), 0xff6a20, 1.4, 0.5); });
    if (a.i === 22 && !p.fired.calm) { p.fired.calm = 1; for (const q of Object.values(this.pieceObjs)) q.rage = 0; }
  }

  animQuiet(p, bt, o, from, to) {
    const a = p.a;
    const mt = Math.min(0.34, p.base * 0.7);
    const u = clamp(bt / mt);
    const k = o.type;
    const hop = k === 'n' ? 1.1 : k === 'p' ? 0.3 : Math.min(0.5, 0.15 + p.dist * 0.05);
    const pos = from.clone().lerp(to, easeIO(u)); pos.y += Math.sin(u * Math.PI) * hop;
    const stretch = Math.sin(u * Math.PI) * 0.12;
    this.place(o, pos, lerpAngle(p.yaw, FACE_CAM, easeIO(clamp((u - 0.5) * 2))) , 1 - stretch * 0.5, 1 + stretch, 1 - stretch * 0.5);
    if (u < 1) this.fireOnce(p, 'go', () => { this.sfx('hop'); });
    if (u >= 1) this.fireOnce(p, 'land', () => {
      this.sparkBurst(to, 0xb8a8ff, 8, 2.5, 0.07, 0.4);
      this.ring(to, o.color === 'w' ? 0x19d9ff : 0xff3d8e, 1.4, 0.35);
      this.sfx('step'); this.addShake(0.04);
    });
    if (u >= 1) { const b = Math.sin((bt - mt) * 20) * Math.exp(-(bt - mt) * 9) * 0.1; o.g.scale.set(1 + b, 1 - b, 1 + b); }
  }

  animCapture(p, bt, o, from, to) {
    const a = p.a, victim = this.pieceObjs[a.capId];
    const T0 = 0.3, HIT = 0.52, END = 1.15;
    const dirN = p.dir.clone().normalize();
    const k = o.type;
    let pos = from.clone(), yaw = p.yaw, sx = 1, sy = 1, sz = 1;
    const back = from.clone().addScaledVector(dirN, -0.28);
    if (bt < T0) {
      const u = easeOut(bt / T0);
      pos.lerp(back, u); yaw = lerpAngle(FACE_CAM, p.yaw, easeOut(clamp(bt / 0.18)));
      sy = 1 - 0.2 * u; sx = sz = 1 + 0.12 * u;
      pos.y += k === 'n' ? 0 : 0;
      this.fireOnce(p, 'charge', () => { this.sfx(k === 'q' ? 'beam' : 'charge'); this.sparkBurst(from, o.color === 'w' ? 0x19d9ff : 0xff3d8e, 10, 2, 0.06, 0.5); });
      if (k === 'q') setGlow(o.g, 0xffffff, 0.8 + u * 2);
      this.cam.dutch = 0.0;
    } else if (bt < HIT) {
      const u = (bt - T0) / (HIT - T0);
      if (k === 'q') { pos.copy(back); setGlow(o.g, 0xffffff, 3); this.fireOnce(p, 'laser', () => { this.beamFx(from.clone().setY(1), to.clone().setY(0.8), o.color === 'w' ? 0x66eaff : 0xff4da0, 0.3, 0.16); this.sfx('laser'); }); sx = sy = sz = 1 + 0.15; }
      else {
        pos.copy(back).lerp(to.clone().addScaledVector(dirN, -0.2), easeIn(u));
        if (k === 'n') pos.y += Math.sin(Math.min(1, u * 1.15) * Math.PI) * 2.0;
        if (k === 'b') this.sparkBurst(pos, 0xffd23f, 2, 1.5, 0.06, 0.3, 0);
        if (k === 'r') this.sparkBurst(pos, 0xffffff, 1, 1, 0.05, 0.3, 0);
        sy = 1 + 0.15 * u; sx = sz = 1 - 0.08 * u;
        this.fireOnce(p, 'whoosh', () => this.sfx('whoosh'));
      }
    } else {
      const u = clamp((bt - HIT) / (END - HIT));
      const land = k === 'q' ? from.clone().lerp(to, easeOut(clamp(u * 2.5))) : to.clone();
      pos.copy(land);
      const bounce = Math.sin(u * 10) * Math.exp(-u * 4) * 0.18;
      sy = 1 + bounce; sx = sz = 1 - bounce * 0.5;
      yaw = lerpAngle(p.yaw, FACE_CAM, easeIO(clamp((u - 0.3) * 1.6)));
      setGlow(o.g, 0xffffff, Math.max(0.55, 2.4 * (1 - u * 2)));
      if (u >= 1 && !p.fired.reset) { p.fired.reset = 1; resetTint(o.g); if (o.alien) tintPiece(o.g, 0x7cff4d, 0.9); }
    }
    this.place(o, pos, yaw, sx, sy, sz);

    // ---- impact
    if (bt >= HIT) this.fireOnce(p, 'impact', () => {
      const col = a.color === 'w' ? 0x19d9ff : 0xff3d8e;
      const vcol = victim.alien ? 0x7cff4d : TEAM[victim.color].body;
      const power = clamp(0.5 + VAL[a.captured] * 0.12 + (k === 'q' ? 0.3 : 0), 0.6, 1.5);
      victim.g.visible = false; victim.alive = false;
      this.burst(to, vcol, 26 + VAL[a.captured] * 4, 5 + power * 2, 0.17, 1.6);
      this.burst(to, TEAM[victim.color].accent, 12, 6, 0.1, 1.4);
      this.sparkBurst(to, 0xffffff, 26, 8 * power, 0.1, 0.7);
      this.sparkBurst(to, col, 18, 6, 0.09, 0.8);
      this.ring(to, 0xffffff, 3.4 * power, 0.5);
      this.ring(to, col, 5 * power, 0.7);
      if (k === 'q') { this.blast(to, col, 2.6, 0.5); }
      if (k === 'b') this.slash(to, p.yaw + Math.PI / 2, 0xffe27a);
      if (k === 'r' || k === 'k') this.ring(to, 0xffd23f, 4.5, 0.8);
      if (k === 'n') this.burst(to, 0x8a6bff, 14, 4, 0.12, 1.1);
      this.hit(to, power);
      this.fxLight.color.set(col); this.fxLight.position.set(to.x, 2.2, to.z); this.fxLight.intensity = 140;
      const v = VAL[a.captured];
      this.floaters.push({ pos: to.clone().setY(1.6), text: v ? `-${v}` : 'KO', color: '#ffffff', t0: this.rt, big: v >= 5 });
      this.words.push({ pos: to.clone().setY(2.3), text: victim.alien ? 'ALIEN DOWN!' : POW[Math.floor(this.rand() * POW.length)], color: a.color === 'w' ? '#6ff0ff' : '#ff6fb1', t0: this.rt });
      this.sfx('hit', power);
      // HP, score, chain
      const enemy = a.color === 'w' ? 'b' : 'w';
      this.hp[enemy] = Math.max(0.02, a.matAfter[enemy] / 39);
      this.score[a.color] += v * 100; this.hits[a.color]++;
      if (this.chain.side === a.color) this.chain.n++; else this.chain = { side: a.color, n: 1 };
      this.chain.t0 = this.rt;
      if (this.lastCap && this.lastCap.sq === a.to && this.lastCap.color !== a.color) this.banner('RECAPTURE!', a.color === 'w' ? '#6ff0ff' : '#ff6fb1', 0.9, 120, 0.4);
      else if (v >= 5) this.banner(`${NAME[a.captured]} DOWN!`, '#ffd23f', 1.0, 130, 0.4);
      this.lastCap = { sq: a.to, color: a.color };
    });
  }

  animAlien(p, bt, o, from, to) {
    // UFO abducts the knight on e4, carries it to g5 and drops it with a stomp
    const ufo = this.ufo, tr = this.tractor, TOP = 3.6;
    const hov = (pos, y) => ufo.position.set(pos.x, y, pos.z);
    o.alien = true;
    ufo.visible = true; tr.visible = true;
    ufo.rotation.y = this.rt * 2.2;
    this.ufoLights.forEach((l, i) => { l.visible = Math.floor(this.rt * 8 + i) % 2 === 0; });
    let pos = from.clone(), y = 0, spin = 0, ufoPos = from.clone(), ufoY = TOP, beam = 0;
    if (bt < 0.6) { // fly in
      const u = easeOut(bt / 0.6); ufoPos = from.clone().add(new THREE.Vector3(7, 0, -3)).lerp(from, u); ufoY = TOP + 5 * (1 - u);
      this.fireOnce(p, 'ufo', () => this.sfx('ufo'));
    } else if (bt < 1.4) { // abduct
      const u = (bt - 0.6) / 0.8; ufoPos = from.clone(); beam = easeOut(Math.min(1, u * 3));
      y = easeIO(u) * 2.4; spin = u * 6.28 * 2;
      this.fireOnce(p, 'beam', () => { this.sfx('beam'); tintPiece(o.g, 0x7cff4d, 1.4); });
    } else if (bt < 2.5) { // carry
      const u = easeIO((bt - 1.4) / 1.1); ufoPos = from.clone().lerp(to, u); beam = 1; y = 2.4 + Math.sin(u * Math.PI) * 0.5; spin = 12.5 + u * 6;
      if (Math.floor(bt * 30) % 2 === 0) this.sparkBurst(ufoPos.clone().setY(0.2), 0x7cff4d, 1, 1.5, 0.06, 0.5, 2);
    } else if (bt < 3.05) { // drop
      const u = (bt - 2.5) / 0.55; ufoPos = to.clone(); beam = 1 - u * 0.3; y = lerp(2.4, 0, easeIn(u)); spin = 18 + u * 4;
    } else { // leave
      const u = clamp((bt - 3.05) / 0.6); ufoPos = to.clone(); ufoY = TOP + 8 * easeIn(u); beam = 0; y = 0; spin = 0; ufo.scale.setScalar(1 - u * 0.4);
      this.fireOnce(p, 'stomp', () => { this.ring(to, 0x7cff4d, 4.6, 0.8); this.ring(to, 0xffffff, 3, 0.5); this.sparkBurst(to, 0x7cff4d, 30, 7, 0.1, 0.9); this.burst(to, 0x7cff4d, 16, 4, 0.13, 1.2); this.hit(to, 0.9); this.sfx('hit', 0.8); this.cam.zoom = 0.6; });
    }
    hov(ufoPos, ufoY);
    if (bt < 3.05) ufo.scale.setScalar(1);
    pos = bt < 1.4 ? from.clone() : bt < 2.5 ? from.clone().lerp(to, easeIO((bt - 1.4) / 1.1)) : to.clone();
    pos.y = 0.06 + y;
    this.place(o, pos, FACE_CAM + spin, 1, 1, 1);
    // tractor beam from ufo to floor
    tr.visible = beam > 0.01;
    const h = Math.max(0.1, ufoY - 0.2);
    tr.position.set(ufoPos.x, ufoY - h / 2, ufoPos.z); tr.scale.set(beam, h, beam);
    this.cam.focus.copy(ufoPos).setY(0);
    if (bt >= 3.6) this.fireOnce(p, 'gone', () => { ufo.visible = false; tr.visible = false; });
    if (bt >= 0.2) this.fireOnce(p, 'caption', () => { this.capStart = this.rt; this.sfx('stamp'); });
    if (bt >= 3.05 && p.a.quality) this.fireOnce(p, 'quality', () => { this.badge = { q: p.a.quality, sq: p.a.to, t0: this.rt }; this.sfx('ding', false); });
    if (bt >= 3.2 && p.a.check) { /* none */ }
  }

  animMate(p, bt, o, from, to) {
    const a = p.a, kid = this.kingId.w, king = this.pieceObjs[kid], kpos = sqPos(king.sq);
    const col = 0xff3d8e;
    // 0..0.55 queen slides in
    const u = easeIO(clamp(bt / 0.55));
    const pos = from.clone().lerp(to, u); pos.y += Math.sin(u * Math.PI) * 0.4;
    this.place(o, pos, lerpAngle(p.yaw, FACE_CAM, clamp((bt - 0.3) / 0.3)));
    this.fireOnce(p, 'go', () => this.sfx('whoosh'));
    if (bt >= 0.55) this.fireOnce(p, 'land', () => { this.ring(to, col, 3, 0.5); this.sparkBurst(to, col, 14, 4, 0.08, 0.5); this.sfx('step'); this.slowStart = this.rt; this.slow = 0.35; this.cam.zoom = 0.9; this.cam.focus.copy(sqPos('g2')); this.redFx = 1; this.pieceObjs[kid].pulse = 1; this.checkedKing = kid; this.banner('CHECKMATE', '#ff3b5c', 1.6, 190, 0.4); this.sfx('check'); this.addShake(0.4); });
    // lasers
    if (bt >= 1.0) this.fireOnce(p, 'lasers', () => {
      const bq = this.pieceObjs['bbf8'];
      this.beamFx(sqPos('f3').setY(1), kpos.clone().setY(0.9), 0xff4da0, 0.7, 0.2);
      this.beamFx(sqPos('h3').setY(0.9), sqPos('g2').setY(0.5), 0xffd23f, 0.5, 0.12);
      this.sfx('laser'); this.cam.focus.copy(kpos); this.cam.zoom = 1.1; this.flash = 0.15;
    });
    if (bt >= 1.5) {
      const w = clamp((bt - 1.5) / 1.4);
      if (!p.fired.boom) {
        p.fired.boom = 1;
        this.slow = 1;
        king.g.visible = true;
        this.burst(kpos, 0xe9f7ff, 90, 9, 0.22, 2.2, 8);
        this.burst(kpos, 0x19d9ff, 50, 11, 0.14, 2.0, 8);
        this.sparkBurst(kpos, 0xffffff, 80, 12, 0.14, 1.3);
        this.sparkBurst(kpos, 0xff3d8e, 60, 10, 0.12, 1.3);
        this.ring(kpos, 0xffffff, 8, 1.0); this.ring(kpos, 0xff3d8e, 12, 1.4); this.ring(kpos, 0xffd23f, 16, 1.7);
        this.blast(kpos, 0xffe9a0, 4.2, 0.7);
        this.hit(kpos, 2.4); this.freeze = 0.22; this.flash = 0.9; this.addShake(1.4); this.redFx = 0;
        this.fxLight.color.set(0xffffff); this.fxLight.position.set(kpos.x, 2, kpos.z); this.fxLight.intensity = 400;
        king.pulse = 0; king.g.visible = false; king.alive = false;
        this.hp.w = 0; this.ko = this.rt; this.score.b += 5000;
        this.sfx('boom');
        this.confettiOn = true; this.confettiT = this.rt;
        this.cam.orbit = 1;
      }
    }
    if (bt >= 1.65) this.fireOnce(p, 'ko', () => { this.koAt = this.rt; this.sfx('stamp'); });
    if (bt >= 2.4) this.fireOnce(p, 'fanfare', () => this.sfx('fanfare'));
  }

  // ---------------------------------------------------------------- hp / fx / camera
  updateHp(dt) {
    for (const s of ['w', 'b']) this.hpShow[s] += (this.hp[s] - this.hpShow[s]) * Math.min(1, dt * 6);
  }

  updateFx(dt) {
    this.updateParticles(this.debris, dt);
    this.updateParticles(this.sparks, dt);
    this.flushFx(dt);
    this.fxLight.intensity *= Math.exp(-dt * 9);
    this.shake *= Math.exp(-dt * 6);
    this.roll *= Math.exp(-dt * 7);
    this.flash *= Math.exp(-dt * 7);
    this.aberr *= Math.exp(-dt * 8);
    this.redFx *= Math.exp(-dt * (this.redFx > 0.5 && this.slow < 1 ? 0.1 : 1.6));
    if (this.confettiOn && this.rt - this.confettiT < 6) {
      for (let k = 0; k < 3; k++) {
        const c = [0xff3d8e, 0x19d9ff, 0xffd23f, 0x7cff4d, 0xffffff][Math.floor(this.rand() * 5)];
        this.emit(this.sparks, { pos: new THREE.Vector3((this.rand() - 0.5) * 12, 9 + this.rand() * 3, (this.rand() - 0.5) * 12), vel: new THREE.Vector3((this.rand() - 0.5) * 2, -2 - this.rand() * 2, (this.rand() - 0.5) * 2), color: c, size: 0.12 + this.rand() * 0.1, life: 4, g: 0.5, drag: 0.1, shrink: true });
      }
    }
    this.post.uniforms.amt.value = this.aberr + this.redFx * 0.004;
    this.post.uniforms.flash.value = this.flash;
    this.post.uniforms.red.value = this.redFx;
    this.post.uniforms.time.value = this.rt;
    this.banners = this.banners.filter((b) => this.rt - b.t0 < b.dur + 0.1);
    this.floaters = this.floaters.filter((f) => this.rt - f.t0 < 1.3);
    this.words = this.words.filter((f) => this.rt - f.t0 < 0.9);
  }

  updateCamera(dt, snap = false) {
    const c = this.cam, cam = this.camera;
    const intro = this.t < INTRO;
    const lookBase = new THREE.Vector3(0, 0.4, 0.2);
    const f = c.focus.clone(); f.y = 0;
    const tZoom = intro ? 0 : c.zoom;
    const k = snap ? 1 : 1 - Math.exp(-dt * 5);
    c.zoomS = (c.zoomS ?? 0) + (tZoom - (c.zoomS ?? 0)) * k;
    // slow decay of zoom toward 0.25 so the camera breathes between hits
    c.zoom = Math.max(0.12, c.zoom - dt * 0.35);
    const orbitT = c.orbit ? (this.rt - this.ko) : 0;
    const lookT = lookBase.clone().lerp(f, intro ? 0 : 0.5 * Math.min(1, c.zoomS + 0.35));
    c.look.lerp(lookT, k);
    // portrait framing: board must fit the width
    let az = Math.sin(this.rt * 0.35) * 0.1, el = 0.52, dist = 15.6 - c.zoomS * 4.6;
    if (intro) { const u = this.t / INTRO; az = lerp(1.2, 0, easeOut(u)); el = lerp(0.3, 0.52, easeOut(u)); dist = lerp(24, 15.6, easeOut(u)); }
    if (c.orbit) { az = Math.sin(orbitT * 0.7) * 0.9 + 0.2; el = 0.55 + Math.sin(orbitT * 0.5) * 0.1; dist = 11 - Math.min(1, orbitT * 0.4) * 1.0 + (orbitT > 3.6 ? (orbitT - 3.6) * 1.2 : 0); }
    const s = this.shake;
    const sh = new THREE.Vector3((Math.sin(this.rt * 91) + Math.sin(this.rt * 57)) * s * 0.35, (Math.sin(this.rt * 83)) * s * 0.3, (Math.cos(this.rt * 71)) * s * 0.35);
    cam.position.set(c.look.x + Math.sin(az) * Math.cos(el) * dist * -1 * -1 + 0, c.look.y + Math.sin(el) * dist, c.look.z - Math.cos(az) * Math.cos(el) * dist);
    cam.position.x = c.look.x + Math.sin(az) * Math.cos(el) * dist;
    cam.position.add(sh);
    cam.lookAt(c.look.clone().add(sh.clone().multiplyScalar(0.4)));
    cam.rotateZ(this.roll + Math.sin(this.rt * 0.6) * 0.012);
    cam.fov = 66 - c.zoomS * 7; cam.setViewOffset(this.W, this.H, 0, -this.H * 0.07, this.W, this.H); cam.updateProjectionMatrix();
  }

  project(v) {
    const p = v.clone().project(this.camera);
    return { x: (p.x * 0.5 + 0.5) * 1080, y: (-p.y * 0.5 + 0.5) * 1920 };
  }

  render() {
    this.composer.render();
  }
}
export { QUALITY, VAL, NAME };
