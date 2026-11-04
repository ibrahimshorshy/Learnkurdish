// Chunky "fighter" chess pieces built from primitives. Local +Z is the face direction.
import * as THREE from 'three';

const V = (a) => a.map(([r, y]) => new THREE.Vector2(r, y));
const SPH = new THREE.SphereGeometry(1, 16, 12);
const BOX = new THREE.BoxGeometry(1, 1, 1);
const eyeWhite = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
const eyePupil = new THREE.MeshBasicMaterial({ color: 0x120a20 });

export const TEAM = {
  w: { body: 0xe9f7ff, accent: 0x19d9ff, emissive: 0x0a5a78 },
  b: { body: 0xff3d8e, accent: 0xffd23f, emissive: 0x6a0a35 },
};

function lathe(profile, mat, seg = 28) {
  return new THREE.Mesh(new THREE.LatheGeometry(V(profile), seg), mat);
}
function mesh(geo, mat, pos, scale, rot) {
  const m = new THREE.Mesh(geo, mat);
  if (pos) m.position.set(...pos);
  if (scale) m.scale.set(...scale);
  if (rot) m.rotation.set(...rot);
  return m;
}

function addEyes(g, y, z, spread = 0.115, size = 0.085) {
  const eg = new THREE.Group();
  for (const sx of [-1, 1]) {
    const w = mesh(SPH, eyeWhite, [sx * spread, y, z], [size, size * 1.15, size * 0.55]);
    const p = mesh(SPH, eyePupil, [sx * spread * 0.9, y - size * 0.1, z + size * 0.38], [size * 0.5, size * 0.6, size * 0.3]);
    const brow = mesh(BOX, eyePupil, [sx * spread, y + size * 1.25, z + 0.01], [size * 2.1, size * 0.4, size * 0.4], [0, 0, sx * 0.5]);
    eg.add(w, p, brow);
  }
  g.add(eg);
  g.userData.eyes = eg;
}

export function makePiece(type, color) {
  const t = TEAM[color];
  const body = new THREE.MeshStandardMaterial({ color: t.body, metalness: 0.25, roughness: 0.32, emissive: t.emissive, emissiveIntensity: 0.55 });
  const accent = new THREE.MeshStandardMaterial({ color: t.accent, metalness: 0.2, roughness: 0.3, emissive: t.accent, emissiveIntensity: 0.55 });
  const g = new THREE.Group();
  g.userData.mats = [body, accent];
  g.userData.type = type;
  g.userData.color = color;

  const base = lathe([[0.001, 0], [0.37, 0], [0.4, 0.05], [0.36, 0.12], [0.28, 0.17]], accent);
  g.add(base);

  if (type === 'p') {
    g.add(lathe([[0.001, 0.1], [0.28, 0.12], [0.18, 0.3], [0.15, 0.5], [0.24, 0.56], [0.001, 0.56]], body));
    g.add(mesh(SPH, body, [0, 0.74, 0], [0.24, 0.24, 0.24]));
    addEyes(g, 0.76, 0.2, 0.09, 0.07);
    g.userData.h = 1.0;
  } else if (type === 'r') {
    g.add(lathe([[0.001, 0.1], [0.3, 0.12], [0.26, 0.4], [0.25, 0.8], [0.34, 0.86], [0.35, 1.05], [0.001, 1.05]], body));
    for (let k = 0; k < 4; k++) {
      const a = Math.PI / 4 + (k * Math.PI) / 2;
      g.add(mesh(BOX, body, [Math.sin(a) * 0.25, 1.17, Math.cos(a) * 0.25], [0.2, 0.2, 0.2], [0, a, 0]));
    }
    g.add(mesh(new THREE.TorusGeometry(0.3, 0.03, 8, 24), accent, [0, 0.82, 0], null, [Math.PI / 2, 0, 0]));
    addEyes(g, 0.6, 0.27);
    g.userData.h = 1.3;
  } else if (type === 'n') {
    g.add(lathe([[0.001, 0.1], [0.3, 0.12], [0.26, 0.35], [0.2, 0.55], [0.001, 0.55]], body));
    g.add(mesh(BOX, body, [0, 0.82, -0.02], [0.34, 0.6, 0.4], [-0.15, 0, 0]));
    g.add(mesh(BOX, body, [0, 0.9, 0.32], [0.26, 0.28, 0.4], [0.28, 0, 0]));
    g.add(mesh(BOX, accent, [0, 0.82, 0.5], [0.2, 0.1, 0.06], [0.28, 0, 0]));
    for (const sx of [-1, 1]) g.add(mesh(new THREE.ConeGeometry(0.075, 0.24, 6), body, [sx * 0.11, 1.2, -0.1], null, [-0.15, 0, sx * 0.12]));
    for (let k = 0; k < 4; k++) g.add(mesh(BOX, accent, [0, 1.02 - k * 0.14, -0.26 - k * 0.01], [0.09, 0.14, 0.12], [0.3, 0, 0]));
    addEyes(g, 0.98, 0.22, 0.13, 0.075);
    g.userData.h = 1.4;
  } else if (type === 'b') {
    g.add(lathe([[0.001, 0.1], [0.3, 0.12], [0.2, 0.35], [0.14, 0.75], [0.26, 0.82], [0.12, 0.95], [0.001, 0.95]], body));
    g.add(mesh(SPH, body, [0, 1.2, 0], [0.27, 0.36, 0.27]));
    g.add(mesh(SPH, accent, [0, 1.62, 0], [0.08, 0.08, 0.08]));
    g.add(mesh(BOX, accent, [0.1, 1.38, 0.1], [0.04, 0.34, 0.04], [0, 0, -0.55]));
    addEyes(g, 1.15, 0.2, 0.1, 0.075);
    g.userData.h = 1.7;
  } else if (type === 'q') {
    g.add(lathe([[0.001, 0.1], [0.3, 0.12], [0.2, 0.4], [0.16, 0.9], [0.36, 1.12], [0.3, 1.2], [0.001, 1.2]], body));
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      g.add(mesh(new THREE.ConeGeometry(0.06, 0.28, 6), accent, [Math.sin(a) * 0.27, 1.34, Math.cos(a) * 0.27]));
    }
    g.add(mesh(SPH, accent, [0, 1.42, 0], [0.12, 0.12, 0.12]));
    g.add(mesh(new THREE.TorusGeometry(0.28, 0.03, 8, 24), accent, [0, 0.92, 0], null, [Math.PI / 2, 0, 0]));
    addEyes(g, 0.7, 0.21, 0.1, 0.08);
    g.userData.h = 1.7;
  } else {
    g.add(lathe([[0.001, 0.1], [0.3, 0.12], [0.2, 0.4], [0.17, 0.95], [0.37, 1.18], [0.32, 1.3], [0.001, 1.3]], body));
    g.add(mesh(BOX, accent, [0, 1.62, 0], [0.12, 0.42, 0.12]));
    g.add(mesh(BOX, accent, [0, 1.68, 0], [0.34, 0.12, 0.12]));
    g.add(mesh(new THREE.TorusGeometry(0.31, 0.035, 8, 24), accent, [0, 1.2, 0], null, [Math.PI / 2, 0, 0]));
    addEyes(g, 0.75, 0.21, 0.1, 0.08);
    g.userData.h = 2.0;
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; } });
  return g;
}

export function tintPiece(g, hex, intensity = 0.9) {
  const [body, accent] = g.userData.mats;
  body.color.set(hex);
  body.emissive.set(hex);
  body.emissiveIntensity = intensity;
  accent.emissive.set(hex);
}
export function resetTint(g) {
  const t = TEAM[g.userData.color];
  const [body, accent] = g.userData.mats;
  body.color.set(t.body);
  body.emissive.set(t.emissive);
  body.emissiveIntensity = 0.55;
  accent.color.set(t.accent);
  accent.emissive.set(t.accent);
  accent.emissiveIntensity = 0.55;
}
export function setGlow(g, hex, k) {
  const [body] = g.userData.mats;
  body.emissive.set(hex);
  body.emissiveIntensity = k;
}
