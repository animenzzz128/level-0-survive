import * as THREE from 'three';

export interface BackroomsMaterialSet {
  wallpaper: THREE.MeshStandardMaterial;
  baseboard: THREE.MeshStandardMaterial;
  carpet: THREE.MeshStandardMaterial;
  ceiling: THREE.MeshStandardMaterial;
  lightFixtureFrame: THREE.MeshStandardMaterial;
  lightPanelOn: THREE.MeshStandardMaterial;
  lightPanelDim: THREE.MeshStandardMaterial;
  pillar: THREE.MeshStandardMaterial;
  tableMetal: THREE.MeshStandardMaterial;
  tableTop: THREE.MeshStandardMaterial;
  exitDoor: THREE.MeshStandardMaterial;
  exitFrame: THREE.MeshStandardMaterial;
  graffitiMaterials: THREE.MeshStandardMaterial[];
  smilerFace: THREE.MeshBasicMaterial;
  muzzleFlashTex: THREE.CanvasTexture;
  dustTex: THREE.CanvasTexture;
  softShadowTex: THREE.CanvasTexture;
  vhsLabelTex: THREE.CanvasTexture;
  lightGlowTex: THREE.CanvasTexture;
  howlerBodyTex: THREE.CanvasTexture;
  howlerNormalTex: THREE.DataTexture;
  bruteSkinTex: THREE.CanvasTexture;
  bruteNormalTex: THREE.DataTexture;
  smilerHaloTex: THREE.CanvasTexture;
  dispose: () => void;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  return [canvas, ctx];
}

function createNormalFromHeight(
  heightData: Float32Array,
  size: number,
  strength: number,
  anisotropy: number,
): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const idx = (x: number, y: number) => {
    const wx = ((x % size) + size) % size;
    const wy = ((y % size) + size) % size;
    return wy * size + wx;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const tl = heightData[idx(x - 1, y - 1)];
      const t = heightData[idx(x, y - 1)];
      const tr = heightData[idx(x + 1, y - 1)];
      const l = heightData[idx(x - 1, y)];
      const r = heightData[idx(x + 1, y)];
      const bl = heightData[idx(x - 1, y + 1)];
      const b = heightData[idx(x, y + 1)];
      const br = heightData[idx(x + 1, y + 1)];

      const dX = tr + 2 * r + br - (tl + 2 * l + bl);
      const dY = bl + 2 * b + br - (tl + 2 * t + tr);

      let nx = -dX * strength;
      let ny = -dY * strength;
      let nz = 1.0;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      const p = (y * size + x) * 4;
      data[p] = Math.round((nx * 0.5 + 0.5) * 255);
      data[p + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[p + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[p + 3] = 255;
    }
  }

  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  // DataTexture defaults to nearest filtering with no mipmaps: with the carpet tiled ~32 times the lighting
  // detail sparkled and blocked up in motion. Filter and mip it like the colour maps.
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function finalizeColorTex(
  canvas: HTMLCanvasElement,
  anisotropy: number,
  repeatX = 1,
  repeatY = 1,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function finalizeDataTex(
  canvas: HTMLCanvasElement,
  anisotropy: number,
  repeatX = 1,
  repeatY = 1,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = anisotropy;
  tex.needsUpdate = true;
  return tex;
}

function buildWallpaperTextures(anisotropy: number) {
  const size = 512;
  const rng = mulberry32(104729);
  const [albedo, ctx] = makeCanvas(size, size);
  const [roughCanvas, rCtx] = makeCanvas(size, size);
  const height = new Float32Array(size * size);

  // Iconic Level 0 sickly mustard-ochre base
  ctx.fillStyle = '#c4ac54';
  ctx.fillRect(0, 0, size, size);

  rCtx.fillStyle = '#d4d4d4';
  rCtx.fillRect(0, 0, size, size);

  // Vertical pinstripe & classic Backrooms arrow-diamond motif
  const cols = 8;
  const colW = size / cols;
  for (let c = 0; c < cols; c++) {
    const x0 = c * colW;
    ctx.fillStyle = c % 2 === 0 ? 'rgba(155, 132, 54, 0.24)' : 'rgba(218, 198, 114, 0.16)';
    ctx.fillRect(x0, 0, colW * 0.5, size);

    // Thin vertical dotted rib
    ctx.strokeStyle = 'rgba(132, 110, 42, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x0 + colW * 0.25, 0);
    ctx.lineTo(x0 + colW * 0.25, size);
    ctx.stroke();

    // Repeating geometric diamond/chevron ornament
    const rows = 8;
    const rowH = size / rows;
    for (let r = 0; r < rows; r++) {
      const cx = x0 + colW * 0.72;
      const cy = r * rowH + rowH * 0.5;
      ctx.strokeStyle = 'rgba(128, 105, 38, 0.42)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy - 16);
      ctx.lineTo(cx + 10, cy);
      ctx.lineTo(cx, cy + 16);
      ctx.lineTo(cx - 10, cy);
      ctx.closePath();
      ctx.stroke();

      ctx.fillStyle = 'rgba(166, 140, 56, 0.32)';
      ctx.beginPath();
      ctx.arc(cx, cy, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Wallpaper panel seam lines
  ctx.fillStyle = 'rgba(72, 58, 22, 0.25)';
  ctx.fillRect(0, 0, 2, size);
  ctx.fillRect(size * 0.5, 0, 2, size);

  // Subtle damp water-damage gradient near bottom + soft ceiling cove shadow at top
  const bottomGrad = ctx.createLinearGradient(0, size * 0.66, 0, size);
  bottomGrad.addColorStop(0, 'rgba(65, 52, 20, 0)');
  bottomGrad.addColorStop(1, 'rgba(42, 33, 12, 0.52)');
  ctx.fillStyle = bottomGrad;
  ctx.fillRect(0, size * 0.66, size, size * 0.34);

  const topGrad = ctx.createLinearGradient(0, 0, 0, size * 0.14);
  topGrad.addColorStop(0, 'rgba(40, 34, 15, 0.38)');
  topGrad.addColorStop(1, 'rgba(40, 34, 15, 0)');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, size, size * 0.14);

  // Damp glossy streaks in roughness map
  const roughGrad = rCtx.createLinearGradient(0, size * 0.7, 0, size);
  roughGrad.addColorStop(0, 'rgba(210,210,210,0)');
  roughGrad.addColorStop(1, 'rgba(110,110,110,0.65)');
  rCtx.fillStyle = roughGrad;
  rCtx.fillRect(0, size * 0.7, size, size * 0.3);

  for (let i = 0; i < 18; i++) {
    const sx = rng() * size;
    const sy = rng() * size;
    const rad = 18 + rng() * 52;
    const g = ctx.createRadialGradient(sx, sy, 2, sx, sy, rad);
    g.addColorStop(0, 'rgba(85, 68, 26, 0.16)');
    g.addColorStop(1, 'rgba(85, 68, 26, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // Paper fiber & embossed pattern heightfield for normal map
  const img = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    const lum = (img[i * 4] * 0.3 + img[i * 4 + 1] * 0.59 + img[i * 4 + 2] * 0.11) / 255;
    const grain = (rng() - 0.5) * 0.08;
    height[i] = lum * 0.65 + grain;
  }

  return {
    map: finalizeColorTex(albedo, anisotropy),
    normalMap: createNormalFromHeight(height, size, 1.35, anisotropy),
    roughnessMap: finalizeDataTex(roughCanvas, anisotropy),
  };
}

function buildCarpetTextures(anisotropy: number) {
  const size = 512;
  const rng = mulberry32(42913);
  const [albedo, ctx] = makeCanvas(size, size);
  const [roughCanvas, rCtx] = makeCanvas(size, size);
  const height = new Float32Array(size * size);

  ctx.fillStyle = '#6e5c34';
  ctx.fillRect(0, 0, size, size);
  rCtx.fillStyle = '#ececec';
  rCtx.fillRect(0, 0, size, size);

  // Commercial loop-pile carpet weave
  const imgData = ctx.getImageData(0, 0, size, size);
  const rData = rCtx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const weave =
        Math.sin(x * 0.9) * 0.5 +
        Math.cos(y * 0.9) * 0.5 +
        (rng() - 0.5) * 1.4;
      const delta = weave * 14;
      imgData.data[i * 4] = THREE.MathUtils.clamp(112 + delta, 35, 165);
      imgData.data[i * 4 + 1] = THREE.MathUtils.clamp(94 + delta * 0.88, 30, 145);
      imgData.data[i * 4 + 2] = THREE.MathUtils.clamp(51 + delta * 0.55, 18, 95);
      imgData.data[i * 4 + 3] = 255;
      height[i] = weave * 0.35 + 0.5;
    }
  }
  ctx.putImageData(imgData, 0, 0);

  // Damp mildew patches that look slightly darker & wetter
  for (let i = 0; i < 12; i++) {
    const sx = rng() * size;
    const sy = rng() * size;
    const rad = 30 + rng() * 80;
    const g = ctx.createRadialGradient(sx, sy, 4, sx, sy, rad);
    g.addColorStop(0, 'rgba(34, 28, 14, 0.38)');
    g.addColorStop(1, 'rgba(34, 28, 14, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, rad, 0, Math.PI * 2);
    ctx.fill();

    const rg = rCtx.createRadialGradient(sx, sy, 4, sx, sy, rad);
    rg.addColorStop(0, 'rgba(130, 130, 130, 0.75)');
    rg.addColorStop(1, 'rgba(236, 236, 236, 0)');
    rCtx.fillStyle = rg;
    rCtx.beginPath();
    rCtx.arc(sx, sy, rad, 0, Math.PI * 2);
    rCtx.fill();
  }
  void rData;

  return {
    map: finalizeColorTex(albedo, anisotropy),
    normalMap: createNormalFromHeight(height, size, 1.8, anisotropy),
    roughnessMap: finalizeDataTex(roughCanvas, anisotropy),
  };
}

function buildCeilingTextures(anisotropy: number) {
  const size = 512;
  const rng = mulberry32(88317);
  const [albedo, ctx] = makeCanvas(size, size);
  const height = new Float32Array(size * size);

  ctx.fillStyle = '#c8c2a6';
  ctx.fillRect(0, 0, size, size);

  // Acoustic tile speckles
  for (let i = 0; i < 4200; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const w = 1 + rng() * 2.5;
    const dark = rng() > 0.35;
    ctx.fillStyle = dark ? 'rgba(68, 63, 46, 0.35)' : 'rgba(224, 218, 192, 0.35)';
    ctx.fillRect(x, y, w, w);
  }

  // Water leak rings
  for (let i = 0; i < 4; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 25 + rng() * 55;
    ctx.strokeStyle = 'rgba(116, 94, 48, 0.25)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
  }

  // 2x2 suspended T-bar grid
  ctx.strokeStyle = '#7e7967';
  ctx.lineWidth = 10;
  ctx.strokeRect(0, 0, size, size);
  ctx.beginPath();
  ctx.moveTo(size * 0.5, 0);
  ctx.lineTo(size * 0.5, size);
  ctx.moveTo(0, size * 0.5);
  ctx.lineTo(size, size * 0.5);
  ctx.stroke();

  // Inner subtle highlight bevel on T-bars
  ctx.strokeStyle = 'rgba(235, 230, 208, 0.45)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(size * 0.5 - 4, 0);
  ctx.lineTo(size * 0.5 - 4, size);
  ctx.moveTo(0, size * 0.5 - 4);
  ctx.lineTo(size, size * 0.5 - 4);
  ctx.stroke();

  const img = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    height[i] = img[i * 4] / 255;
  }

  return {
    map: finalizeColorTex(albedo, anisotropy),
    normalMap: createNormalFromHeight(height, size, 1.4, anisotropy),
  };
}

function buildLightPanelTexture(anisotropy: number, on: boolean): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 512);
  ctx.fillStyle = on ? '#e8e4c8' : '#4a473a';
  ctx.fillRect(0, 0, 256, 512);

  // Diffuser louvers
  for (let y = 0; y < 512; y += 8) {
    ctx.fillStyle = on ? 'rgba(175, 165, 118, 0.28)' : 'rgba(20, 18, 14, 0.45)';
    ctx.fillRect(0, y, 256, 3);
  }

  // Twin fluorescent tubes visible behind diffuser
  const tubeX = [72, 184];
  for (const tx of tubeX) {
    const grad = ctx.createLinearGradient(tx - 32, 0, tx + 32, 0);
    grad.addColorStop(0, 'rgba(255, 250, 220, 0)');
    grad.addColorStop(0.5, on ? 'rgba(255, 253, 232, 0.95)' : 'rgba(95, 92, 75, 0.35)');
    grad.addColorStop(1, 'rgba(255, 250, 220, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(tx - 32, 16, 64, 480);
  }

  // Troffer metal frame border
  ctx.strokeStyle = '#625e4f';
  ctx.lineWidth = 14;
  ctx.strokeRect(0, 0, 256, 512);

  return finalizeColorTex(canvas, anisotropy, 1, 1);
}

function buildExitDoorTexture(anisotropy: number): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(512, 768);
  ctx.fillStyle = '#3c403a';
  ctx.fillRect(0, 0, 512, 768);

  // Brushed vertical metal streaks
  const rng = mulberry32(991);
  for (let i = 0; i < 400; i++) {
    ctx.fillStyle = rng() > 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.06)';
    ctx.fillRect(rng() * 512, 0, 1 + rng() * 3, 768);
  }

  // Heavy bulkhead ribs & perimeter rivets
  ctx.strokeStyle = '#252823';
  ctx.lineWidth = 12;
  ctx.strokeRect(20, 20, 472, 728);
  ctx.fillStyle = '#2c302b';
  ctx.fillRect(36, 420, 440, 28);
  ctx.fillStyle = '#686d63';
  for (let ry = 48; ry <= 720; ry += 84) {
    ctx.beginPath();
    ctx.arc(38, ry, 4, 0, Math.PI * 2);
    ctx.arc(474, ry, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Caution hazard stripe
  ctx.save();
  ctx.beginPath();
  ctx.rect(36, 580, 440, 56);
  ctx.clip();
  ctx.fillStyle = '#c89b28';
  ctx.fillRect(36, 580, 440, 56);
  ctx.fillStyle = '#181815';
  for (let x = -40; x < 540; x += 48) {
    ctx.beginPath();
    ctx.moveTo(x, 580);
    ctx.lineTo(x + 24, 580);
    ctx.lineTo(x - 10, 636);
    ctx.lineTo(x - 34, 636);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Stencil signage
  ctx.fillStyle = '#e5dcc0';
  ctx.font = 'bold 42px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('SECTOR 00', 256, 175);
  ctx.fillStyle = '#d9534f';
  ctx.font = 'bold 34px monospace';
  ctx.fillText('THRESHOLD EXIT', 256, 228);
  ctx.fillStyle = '#a3a08d';
  ctx.font = '20px monospace';
  ctx.fillText('ARCHIVE EXTRACTION SEAL', 256, 275);

  // Push bar
  ctx.fillStyle = '#8b8f86';
  ctx.fillRect(80, 385, 352, 26);
  ctx.fillStyle = '#c24339';
  ctx.fillRect(100, 391, 312, 14);

  return finalizeColorTex(canvas, anisotropy, 1, 1);
}

function buildGraffitiMaterials(anisotropy: number): THREE.MeshStandardMaterial[] {
  const texts = [
    { lines: ['DO NOT', 'STRAY'], color: '#2b1b14', tallies: 14 },
    { lines: ['KEEP', 'MOVING'], color: '#201e17', tallies: 9 },
    { lines: ['IT HEARS', 'GUNFIRE'], color: '#421512', tallies: 22 },
  ];

  return texts.map((entry, idx) => {
    const [canvas, ctx] = makeCanvas(512, 512);
    ctx.clearRect(0, 0, 512, 512);
    ctx.save();
    ctx.translate(256, 256);
    ctx.rotate((idx - 1) * 0.06);

    ctx.fillStyle = entry.color;
    ctx.font = 'bold 62px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(entry.lines[0], 0, -40);
    ctx.fillText(entry.lines[1], 0, 30);

    // Scratched tally marks below
    ctx.strokeStyle = entry.color;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    const startX = -130;
    for (let t = 0; t < entry.tallies; t++) {
      const group = Math.floor(t / 5);
      const pos = t % 5;
      const gx = startX + group * 64;
      if (pos < 4) {
        const lx = gx + pos * 11;
        ctx.beginPath();
        ctx.moveTo(lx, 95);
        ctx.lineTo(lx + 2, 138);
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.moveTo(gx - 4, 132);
        ctx.lineTo(gx + 38, 102);
        ctx.stroke();
      }
    }
    ctx.restore();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = anisotropy;
    tex.needsUpdate = true;
    return new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      roughness: 0.9,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
  });
}

function buildSmilerFaceMaterial(): THREE.MeshBasicMaterial {
  const [canvas, ctx] = makeCanvas(256, 256);
  ctx.clearRect(0, 0, 256, 256);

  // Subtle glow aura behind eyes and grin
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 14;
  ctx.fillStyle = '#ffffff';

  // Piercing hollow eyes
  ctx.beginPath();
  ctx.ellipse(82, 92, 16, 24, -0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(174, 92, 16, 24, 0.1, 0, Math.PI * 2);
  ctx.fill();

  // Wide jagged crescent grin
  ctx.beginPath();
  ctx.moveTo(38, 138);
  ctx.quadraticCurveTo(128, 224, 218, 138);
  ctx.quadraticCurveTo(128, 184, 38, 138);
  ctx.closePath();
  ctx.fill();

  // Dark vertical tooth gaps
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#050507';
  for (let x = 58; x <= 198; x += 17) {
    ctx.fillRect(x, 146, 4, 52);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
    fog: false,
  });
}

function buildMuzzleFlashTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 256);
  const cx = 128;
  const cy = 128;

  const glow = ctx.createRadialGradient(cx, cy, 4, cx, cy, 120);
  glow.addColorStop(0, 'rgba(255, 255, 240, 1)');
  glow.addColorStop(0.25, 'rgba(255, 210, 110, 0.92)');
  glow.addColorStop(0.6, 'rgba(255, 115, 20, 0.35)');
  glow.addColorStop(1, 'rgba(255, 80, 0, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 256, 256);

  // Star spikes
  ctx.fillStyle = 'rgba(255, 245, 205, 0.9)';
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate((i * Math.PI) / 3);
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(116, 0);
    ctx.lineTo(0, 10);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildDustTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  g.addColorStop(0, 'rgba(255, 245, 200, 0.9)');
  g.addColorStop(0.5, 'rgba(235, 215, 145, 0.35)');
  g.addColorStop(1, 'rgba(235, 215, 145, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildSoftShadowTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(8, 7, 4, 0.72)');
  g.addColorStop(0.45, 'rgba(8, 7, 4, 0.38)');
  g.addColorStop(1, 'rgba(8, 7, 4, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildTableTopTexture(anisotropy: number): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 256);
  const rng = mulberry32(55123);
  ctx.fillStyle = '#756b52';
  ctx.fillRect(0, 0, 256, 256);

  // Subtle laminate grain + grime
  for (let y = 0; y < 256; y += 2) {
    ctx.fillStyle = rng() > 0.5 ? 'rgba(42,36,24,0.08)' : 'rgba(210,198,164,0.06)';
    ctx.fillRect(0, y, 256, 2);
  }
  // Coffee/water stain ring
  ctx.strokeStyle = 'rgba(48, 36, 18, 0.28)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(178, 86, 24, 0, Math.PI * 2);
  ctx.stroke();

  // Edge scuffing
  ctx.strokeStyle = 'rgba(34, 30, 20, 0.35)';
  ctx.lineWidth = 8;
  ctx.strokeRect(0, 0, 256, 256);
  return finalizeColorTex(canvas, anisotropy, 1, 1);
}

function buildVhsLabelTexture(anisotropy: number): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(256, 128);
  ctx.fillStyle = '#e8dcc0';
  ctx.fillRect(0, 0, 256, 128);
  ctx.fillStyle = '#d9821e';
  ctx.fillRect(0, 0, 256, 28);
  ctx.fillStyle = '#b83227';
  ctx.fillRect(0, 28, 256, 12);
  ctx.fillStyle = '#1d1b16';
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('TAPE // L0', 128, 86);
  return finalizeColorTex(canvas, anisotropy, 1, 1);
}

function buildLightGlowTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
  g.addColorStop(0, 'rgba(255, 244, 195, 0.52)');
  g.addColorStop(0.4, 'rgba(248, 224, 145, 0.22)');
  g.addColorStop(1, 'rgba(248, 224, 145, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function buildHowlerSkinTextures(anisotropy: number) {
  const size = 256;
  const rng = mulberry32(71933);
  const [canvas, ctx] = makeCanvas(size, size);
  const height = new Float32Array(size * size);

  ctx.fillStyle = '#12100e';
  ctx.fillRect(0, 0, size, size);

  // Twisted desiccated wire/sinew strands
  for (let i = 0; i < 220; i++) {
    const x0 = rng() * size;
    const y0 = rng() * size;
    const len = 35 + rng() * 90;
    const ang = (rng() - 0.5) * 0.65 + Math.PI * 0.5;
    ctx.strokeStyle = rng() > 0.35 ? 'rgba(38, 33, 27, 0.72)' : 'rgba(6, 5, 4, 0.85)';
    ctx.lineWidth = 1.2 + rng() * 3.2;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(
      x0 + Math.cos(ang + 0.4) * len * 0.5,
      y0 + Math.sin(ang + 0.4) * len * 0.5,
      x0 + Math.cos(ang) * len,
      y0 + Math.sin(ang) * len,
    );
    ctx.stroke();
  }

  const img = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    height[i] = img[i * 4] / 255 + (rng() - 0.5) * 0.1;
  }

  return {
    map: finalizeColorTex(canvas, anisotropy, 2, 2),
    normalMap: createNormalFromHeight(height, size, 2.2, anisotropy),
  };
}

function buildBruteSkinTextures(anisotropy: number) {
  const size = 256;
  const rng = mulberry32(92811);
  const [canvas, ctx] = makeCanvas(size, size);
  const height = new Float32Array(size * size);

  // Pallid bruised mottled flesh base
  ctx.fillStyle = '#7d6956';
  ctx.fillRect(0, 0, size, size);

  for (let i = 0; i < 48; i++) {
    const sx = rng() * size;
    const sy = rng() * size;
    const rad = 14 + rng() * 44;
    const g = ctx.createRadialGradient(sx, sy, 2, sx, sy, rad);
    g.addColorStop(0, rng() > 0.5 ? 'rgba(68, 38, 34, 0.34)' : 'rgba(148, 128, 108, 0.25)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sx, sy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  // Dark veins & stitched creases
  for (let i = 0; i < 65; i++) {
    let vx = rng() * size;
    let vy = rng() * size;
    ctx.strokeStyle = 'rgba(48, 24, 24, 0.45)';
    ctx.lineWidth = 1 + rng() * 1.8;
    ctx.beginPath();
    ctx.moveTo(vx, vy);
    for (let s = 0; s < 5; s++) {
      vx += (rng() - 0.5) * 26;
      vy += 8 + rng() * 18;
      ctx.lineTo(vx, vy);
    }
    ctx.stroke();
  }

  const img = ctx.getImageData(0, 0, size, size).data;
  for (let i = 0; i < size * size; i++) {
    height[i] = img[i * 4] / 255 + (rng() - 0.5) * 0.08;
  }

  return {
    map: finalizeColorTex(canvas, anisotropy, 1.5, 1.5),
    normalMap: createNormalFromHeight(height, size, 1.75, anisotropy),
  };
}

function buildSmilerHaloTexture(): THREE.CanvasTexture {
  const [canvas, ctx] = makeCanvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 6, 64, 64, 60);
  g.addColorStop(0, 'rgba(220, 240, 255, 0.34)');
  g.addColorStop(0.45, 'rgba(180, 215, 245, 0.12)');
  g.addColorStop(1, 'rgba(180, 215, 245, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createBackroomsMaterialSet(
  renderer: THREE.WebGLRenderer,
): BackroomsMaterialSet {
  const anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const wallTex = buildWallpaperTextures(anisotropy);
  const carpetTex = buildCarpetTextures(anisotropy);
  const ceilingTex = buildCeilingTextures(anisotropy);
  const lightOnTex = buildLightPanelTexture(anisotropy, true);
  const lightDimTex = buildLightPanelTexture(anisotropy, false);
  const exitTex = buildExitDoorTexture(anisotropy);

  const wallpaper = new THREE.MeshStandardMaterial({
    map: wallTex.map,
    normalMap: wallTex.normalMap,
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughnessMap: wallTex.roughnessMap,
    roughness: 0.85,
    metalness: 0.02,
  });

  const pillarMap = wallTex.map.clone();
  pillarMap.repeat.set(0.24, 1);
  pillarMap.needsUpdate = true;
  const pillarNormal = wallTex.normalMap.clone();
  pillarNormal.repeat.set(0.24, 1);
  pillarNormal.needsUpdate = true;

  const pillar = new THREE.MeshStandardMaterial({
    map: pillarMap,
    normalMap: pillarNormal,
    normalScale: new THREE.Vector2(0.45, 0.45),
    roughness: 0.85,
    metalness: 0.02,
  });

  const baseboard = new THREE.MeshStandardMaterial({
    color: 0x2c2416,
    roughness: 0.58,
    metalness: 0.06,
  });

  const carpet = new THREE.MeshStandardMaterial({
    map: carpetTex.map,
    normalMap: carpetTex.normalMap,
    normalScale: new THREE.Vector2(0.65, 0.65),
    roughnessMap: carpetTex.roughnessMap,
    roughness: 0.94,
    metalness: 0.0,
  });

  const ceiling = new THREE.MeshStandardMaterial({
    map: ceilingTex.map,
    normalMap: ceilingTex.normalMap,
    normalScale: new THREE.Vector2(0.4, 0.4),
    roughness: 0.88,
    metalness: 0.06,
  });

  const lightFixtureFrame = new THREE.MeshStandardMaterial({
    color: 0x5c5848,
    roughness: 0.42,
    metalness: 0.65,
  });

  const lightPanelOn = new THREE.MeshStandardMaterial({
    map: lightOnTex,
    emissiveMap: lightOnTex,
    emissive: new THREE.Color(0xfff4c2),
    emissiveIntensity: 1.55,
    roughness: 0.3,
    metalness: 0.05,
  });

  const lightPanelDim = new THREE.MeshStandardMaterial({
    map: lightDimTex,
    emissive: new THREE.Color(0x2a2515),
    emissiveIntensity: 0.15,
    roughness: 0.6,
    metalness: 0.1,
  });

  const tableMetal = new THREE.MeshStandardMaterial({
    color: 0x3b3e3a,
    roughness: 0.42,
    metalness: 0.78,
  });

  const tableTopTex = buildTableTopTexture(anisotropy);
  const tableTop = new THREE.MeshStandardMaterial({
    map: tableTopTex,
    roughness: 0.78,
    metalness: 0.06,
  });

  const exitDoor = new THREE.MeshStandardMaterial({
    map: exitTex,
    roughness: 0.45,
    metalness: 0.62,
  });

  const exitFrame = new THREE.MeshStandardMaterial({
    color: 0x242622,
    roughness: 0.4,
    metalness: 0.8,
  });

  const graffitiMaterials = buildGraffitiMaterials(anisotropy);
  const smilerFace = buildSmilerFaceMaterial();
  const muzzleFlashTex = buildMuzzleFlashTexture();
  const dustTex = buildDustTexture();
  const softShadowTex = buildSoftShadowTexture();
  const vhsLabelTex = buildVhsLabelTexture(anisotropy);
  const lightGlowTex = buildLightGlowTexture();
  const howlerTex = buildHowlerSkinTextures(anisotropy);
  const bruteTex = buildBruteSkinTextures(anisotropy);
  const smilerHaloTex = buildSmilerHaloTexture();

  const allMaterials: THREE.Material[] = [
    wallpaper,
    pillar,
    baseboard,
    carpet,
    ceiling,
    lightFixtureFrame,
    lightPanelOn,
    lightPanelDim,
    tableMetal,
    tableTop,
    exitDoor,
    exitFrame,
    smilerFace,
    ...graffitiMaterials,
  ];

  const allTextures: THREE.Texture[] = [
    wallTex.map,
    wallTex.normalMap,
    wallTex.roughnessMap,
    pillarMap,
    pillarNormal,
    carpetTex.map,
    carpetTex.normalMap,
    carpetTex.roughnessMap,
    ceilingTex.map,
    ceilingTex.normalMap,
    lightOnTex,
    lightDimTex,
    exitTex,
    tableTopTex,
    muzzleFlashTex,
    dustTex,
    softShadowTex,
    vhsLabelTex,
    lightGlowTex,
    howlerTex.map,
    howlerTex.normalMap,
    bruteTex.map,
    bruteTex.normalMap,
    smilerHaloTex,
  ];

  return {
    wallpaper,
    baseboard,
    carpet,
    ceiling,
    lightFixtureFrame,
    lightPanelOn,
    lightPanelDim,
    pillar,
    tableMetal,
    tableTop,
    exitDoor,
    exitFrame,
    graffitiMaterials,
    smilerFace,
    muzzleFlashTex,
    dustTex,
    softShadowTex,
    vhsLabelTex,
    lightGlowTex,
    howlerBodyTex: howlerTex.map,
    howlerNormalTex: howlerTex.normalMap,
    bruteSkinTex: bruteTex.map,
    bruteNormalTex: bruteTex.normalMap,
    smilerHaloTex,
    dispose: () => {
      allMaterials.forEach((m) => {
        if ('map' in m && m.map instanceof THREE.Texture) m.map.dispose();
        m.dispose();
      });
      allTextures.forEach((t) => t.dispose());
    },
  };
}
