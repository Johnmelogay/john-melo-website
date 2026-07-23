/* ═══════════════════════════════════════════════════════════════
   JOHN MELO — FIGURA PÚBLICA
   Procedural 3D First-Person Art Space
   
   ARCHITECTURE: Infinite chunk-based procedural world
   ─────────────────────────────────────────────────
   • World is divided into CHUNKS (40×40 units each)
   • Only chunks within LOAD_RADIUS of the player are alive
   • Chunks beyond UNLOAD_RADIUS are disposed (meshes, lights freed)
   • Each chunk has a deterministic SEED from its grid coordinates
   • A seeded PRNG decides what rooms, corridors, posters, and
     artworks spawn inside each chunk — same seed = same result
   • Geometries and materials are SHARED (never duplicated)
   • Textures are loaded ONCE and reused everywhere
   • Result: infinite, unpredictable world using ~constant memory
   ═══════════════════════════════════════════════════════════════ */

import * as THREE from 'three';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { initMultiplayer, updateLocalPlayer, listenToPlayers, broadcastGraffiti, listenToGraffiti, getPlayerId, listenToSaturation, incrementGlobalSaturation } from './firebase-multiplayer.js';

const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

/* ═══════════════════════════════════════════
   CONFIGURATION & PHYSICS
   ═══════════════════════════════════════════ */
const config = {
  moveSpeed: 40,
  runSpeed: 70,
  jumpStrength: 16,
  gravity: 40,
  fogDensityIndoor: 0.002,
  fogColorIndoor: 0x050505,
  fogDensityOutdoor: 0.016,
  fogColorOutdoor: 0x8a8a8a,
  ambientLightIntensity: 3.5,
  flashlightIntensity: 80.0,
  lightIntensityScale: 300.0,
  spotIntensityScale: 400.0,
  scanlineIntensity: 0.0,
  noiseIntensity: 0.05,
  worldMode: 'indoor', // 'indoor' or 'outdoor'
  dayNightTime: 12.0,  // Always daytime
  autoTimeCycle: false, // Disabled time cycle
  islandRadius: 220,
  hillHeight: 35,
};

const CHUNK_SIZE = 40;         // world units per chunk
const LOAD_RADIUS = 4;         // chunks around player to keep loaded
const UNLOAD_RADIUS = 5;       // chunks beyond this get disposed
const CHUNK_CHECK_INTERVAL = 0.5; // seconds between chunk checks

const PLAYER_HEIGHT = 4.5;
const PLAYER_RADIUS = 1.0;
const INTERACT_DISTANCE = 6;
const WALL_HEIGHT = 12;
const CELL_SIZE = 10;          // each chunk is CHUNK_SIZE/CELL_SIZE = 4×4 cells
const CELLS_PER_CHUNK = CHUNK_SIZE / CELL_SIZE; // 4

/* ═══════════════════════════════════════════
   SEEDED PRNG (mulberry32)
   ═══════════════════════════════════════════ */
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function chunkSeed(cx, cz) {
  // deterministic hash from chunk coords
  let h = 0x811c9dc5;
  h = Math.imul(h ^ cx, 0x01000193);
  h = Math.imul(h ^ cz, 0x01000193);
  h = Math.imul(h ^ (cx * 7919 + cz * 104729), 0x01000193);
  return h >>> 0;
}

/* ═══════════════════════════════════════════
   TERRAIN SYSTEM — Noise, Heightmap, Biomes
   ═══════════════════════════════════════════ */

// Simple 2D value noise with smooth interpolation
const _noiseP = new Uint8Array(512);
(function initNoiseTable() {
  for (let i = 0; i < 256; i++) _noiseP[i] = i;
  // Fisher-Yates shuffle with fixed seed
  let s = 42;
  for (let i = 255; i > 0; i--) {
    s = (s * 16807 + 0) % 2147483647;
    const j = s % (i + 1);
    [_noiseP[i], _noiseP[j]] = [_noiseP[j], _noiseP[i]];
  }
  for (let i = 0; i < 256; i++) _noiseP[i + 256] = _noiseP[i];
})();

function _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function _lerp(a, b, t) { return a + t * (b - a); }
function _hash2d(ix, iz) { return (_noiseP[(_noiseP[ix & 255] + iz) & 255]) / 255.0; }

function noise2D(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = _fade(fx), v = _fade(fz);
  const a = _hash2d(ix, iz), b = _hash2d(ix + 1, iz);
  const c = _hash2d(ix, iz + 1), d = _hash2d(ix + 1, iz + 1);
  return _lerp(_lerp(a, b, u), _lerp(c, d, u), v);
}

function fbm(x, z, octaves, lacunarity, gain) {
  let val = 0, amp = 1, freq = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    val += noise2D(x * freq, z * freq) * amp;
    max += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return val / max;
}

// Island shape — returns > 0 for land, < 0 for water
// Creates an organic, non-circular island
function getLandValue(wx, wz) {
  const dist = Math.sqrt(wx * wx + wz * wz);
  // Base island shape: radial falloff with noise perturbation
  const angle = Math.atan2(wz, wx);
  const shoreNoise = fbm(wx * 0.008, wz * 0.008, 4, 2.0, 0.5) * 80;
  const bayNoise = Math.sin(angle * 3) * 30 + Math.cos(angle * 5 + 1.3) * 20;
  const effectiveRadius = config.islandRadius + shoreNoise + bayNoise;
  return effectiveRadius - dist;
}

// Terrain height at any world position
function getTerrainHeight(wx, wz) {
  if (config.worldMode === 'outdoor' && state.blenderSceneActive && blenderGroundMeshes.length > 0) {
    const ray = new THREE.Raycaster(
      new THREE.Vector3(wx, 500, wz),
      new THREE.Vector3(0, -1, 0)
    );
    const intersects = ray.intersectObjects(blenderGroundMeshes, true);
    if (intersects.length > 0) {
      return intersects[0].point.y;
    }
    return -2.0;
  }

  const land = getLandValue(wx, wz);
  if (land < 0) return -2; // underwater

  const dist = Math.sqrt(wx * wx + wz * wz);

  // City center is flat (radius < 100)
  if (dist < 80) return 0;

  // Transition zone (80-120): gradually introduce hills
  const hillFactor = Math.min(1, Math.max(0, (dist - 80) / 40));

  // Multi-octave hills
  const hillHeight = fbm(wx * 0.012 + 50, wz * 0.012 + 50, 5, 2.0, 0.45) * config.hillHeight;

  // Shore zone: flatten near water
  const shoreFactor = Math.min(1, land / 30); // 0 at shore, 1 inland

  return hillHeight * hillFactor * shoreFactor;
}

// Biome classification for a chunk
function getBiome(cx, cz) {
  const centerX = cx * CHUNK_SIZE + CHUNK_SIZE / 2;
  const centerZ = cz * CHUNK_SIZE + CHUNK_SIZE / 2;
  const land = getLandValue(centerX, centerZ);
  const dist = Math.sqrt(centerX * centerX + centerZ * centerZ);

  if (land < -10) return 'ocean';
  if (land < 12) return 'shore';
  if (dist < 100) return 'city';
  return 'hills';
}

/* ═══════════════════════════════════════════
   STATE
   ═══════════════════════════════════════════ */
window.stickerCount = 10;
let lastStickerSpawn = 0;
const stickerPickups = [];

const state = {
  started: false,
  paused: false,
  moveForward: false,
  moveBackward: false,
  moveLeft: false,
  moveRight: false,
  isRunning: false,
  velocity: new THREE.Vector3(),
  direction: new THREE.Vector3(),
  interactTarget: null,
  overlayOpen: null,
  glitchTimer: 0,
  glitchCooldown: 12 + Math.random() * 25,
  counterValue: 128442,
  footstepPhase: 0,
  locationName: 'TERRITÓRIO JOHN MELO',
  lastChunkCheck: 0,
  playerChunkX: Infinity,
  playerChunkZ: Infinity,
  editorActive: false,
  selectedObject: null,
  customScript: null,
  importedModels: [],
  flySpeed: 50,
  flyKeys: {
    w: false, s: false, a: false, d: false, q: false, e: false
  },
  mouseLook: { x: 0, y: 0, pitch: 0, yaw: 0 },
  blenderSceneActive: false,
  graffitiActive: false,
  graffitiBrush: 'face', // 'face', 'red', 'black', 'white'
  graffitiSize: 1.0,
};

let blenderWorldGroup = null;
let blenderColliders = [];
let blenderInteractables = [];
let blenderGroundMeshes = [];
let blenderSpawnPoint = new THREE.Vector3(0, 5, 0);
let blenderMixer = null;

let graffitiPreviewMesh = null;
let placedDecals = [];
let isSpraying = false;
let lastSprayTime = 0;
let brushTextures = {};
let brushMaterials = {};

/* ═══════════════════════════════════════════
   CHUNK REGISTRY
   ═══════════════════════════════════════════ */
const chunks = new Map();      // key "cx,cz" → ChunkData
// ChunkData = { group: THREE.Group, colliders: Box3[], interactables: Mesh[], lights: Light[] }

/* ═══════════════════════════════════════════
   DOM REFS
   ═══════════════════════════════════════════ */
const dom = {
  landing: document.getElementById('landing'),
  loading: document.getElementById('loading'),
  canvas: document.getElementById('game-canvas'),
  hud: document.getElementById('hud'),
  enterBtn: document.getElementById('enter-btn'),
  hudInteract: document.getElementById('hud-interact'),
  hudLocation: document.getElementById('hud-location'),
  hudCounter: document.getElementById('hud-counter'),
  loadingBar: document.getElementById('loading-bar'),
  loadingText: document.getElementById('loading-text'),
  pauseMenu: document.getElementById('pause-menu'),
  fullscreenFace: document.getElementById('fullscreen-face'),
  counterValue: document.getElementById('counter-value'),
  landingStamps: document.getElementById('landing-stamps'),
};

/* ═══════════════════════════════════════════
   THREE.JS GLOBALS
   ═══════════════════════════════════════════ */
let scene, camera, renderer, controls, composer;
let sunLight, skyLight, rainGeometry, rainPoints;
const rainCount = 3500;
let isRaining = false;
let rainCycleTimer = 0;

// Web Audio API Globals for procedural ambience
let audioCtx = null;
let humNode = null, rainNoiseNode = null;
let humOsc1 = null, humOsc2 = null;
const clock = new THREE.Clock();
const raycaster = new THREE.Raycaster();
const textureLoader = new THREE.TextureLoader();

// Global light pools to avoid WebGL uniform limits and prevent runtime compilations
const pointLightPool = [];
const spotLightPool = [];
const MAX_POI_LIGHTS = 8;
const MAX_SPOT_LIGHTS = 4;

/* ═══════════════════════════════════════════
   SHARED GEOMETRY POOL
   Geometries are created once, reused everywhere
   ═══════════════════════════════════════════ */
const geo = {};
function initGeometries() {
  geo.wallThin   = new THREE.BoxGeometry(0.4, WALL_HEIGHT, CELL_SIZE);
  geo.wallThinX  = new THREE.BoxGeometry(CELL_SIZE, WALL_HEIGHT, 0.4);
  geo.wallShort  = new THREE.BoxGeometry(0.4, WALL_HEIGHT, CELL_SIZE * 0.4);
  geo.wallShortX = new THREE.BoxGeometry(CELL_SIZE * 0.4, WALL_HEIGHT, 0.4);
  geo.floor      = new THREE.PlaneGeometry(CELL_SIZE, CELL_SIZE);
  geo.ceiling    = new THREE.PlaneGeometry(CELL_SIZE, CELL_SIZE);
  geo.chunkFloor = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE);
  geo.poster     = new THREE.PlaneGeometry(3, 4);
  geo.posterBig  = new THREE.PlaneGeometry(8, 10);
  geo.posterWide = new THREE.PlaneGeometry(6, 3.5);
  geo.posterSmall= new THREE.PlaneGeometry(1.5, 2);
  geo.fluorescentTube = new THREE.BoxGeometry(3, 0.12, 0.25);
  geo.fluorescentHousing = new THREE.BoxGeometry(3.4, 0.06, 0.4);
  geo.lampPost   = new THREE.BoxGeometry(0.25, 7, 0.25);
  geo.box        = new THREE.BoxGeometry(1.5, 2, 1);
  geo.boxTall    = new THREE.BoxGeometry(2, 4, 0.8);
  geo.table      = new THREE.BoxGeometry(3, 0.18, 2);
  geo.tableLeg   = new THREE.BoxGeometry(0.12, 1.8, 0.12);
  geo.seat       = new THREE.BoxGeometry(1.6, 1.4, 0.9);
  geo.crtBody    = new THREE.BoxGeometry(1.6, 1.3, 1.3);
  geo.crtScreen  = new THREE.PlaneGeometry(1.2, 0.95);
  geo.cassetteBox= new THREE.BoxGeometry(1.3, 0.45, 0.9);
  geo.doorway    = new THREE.PlaneGeometry(2.2, 5);
  geo.elevPanel  = new THREE.BoxGeometry(0.35, 0.9, 0.08);
  geo.elevBtn    = new THREE.SphereGeometry(0.07, 6, 6);
  geo.zine       = new THREE.BoxGeometry(0.25, 0.7, 0.55);
  geo.frame      = new THREE.BoxGeometry(3.3, 4.3, 0.12);
  geo.frameBig   = new THREE.BoxGeometry(8.3, 10.3, 0.12);
  geo.frameWide  = new THREE.BoxGeometry(6.3, 3.8, 0.12);
}

/* ═══════════════════════════════════════════
   SHARED MATERIAL POOL
   ═══════════════════════════════════════════ */
const mat = {};

function createWaterNormalMap() {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const imgData = ctx.createImageData(128, 128);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const nx = Math.sin(x * 0.18) * Math.cos(y * 0.12) + Math.sin(y * 0.22) * 0.4;
      const ny = Math.cos(x * 0.12) * Math.sin(y * 0.18) + Math.cos(x * 0.22) * 0.4;
      const r = Math.floor((nx + 1.4) * 91);
      const g = Math.floor((ny + 1.4) * 91);
      const b = 255;
      const idx = (y * 128 + x) * 4;
      imgData.data[idx] = r;
      imgData.data[idx+1] = g;
      imgData.data[idx+2] = b;
      imgData.data[idx+3] = 255;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  return tex;
}

function initMaterials() {
  mat.concrete      = new THREE.MeshStandardMaterial({ color: 0x5a5a5a, roughness: 0.95 });
  mat.concreteDark  = new THREE.MeshStandardMaterial({ color: 0x2e2e2e, roughness: 0.95 });
  mat.concreteLight = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.9 });
  mat.floor         = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.85, metalness: 0.1 });
  mat.floorPolished = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.3, metalness: 0.2 });
  mat.backroomsFloor= new THREE.MeshStandardMaterial({ color: 0x6e684d, roughness: 0.95 });
  mat.backroomsWall = new THREE.MeshStandardMaterial({ color: 0x857d59, roughness: 0.95 });
  mat.white         = new THREE.MeshStandardMaterial({ color: 0xf0f0e8, roughness: 0.8 });
  mat.black         = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.9 });
  mat.red           = new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0xff0000, emissiveIntensity: 0.3 });
  mat.metal         = new THREE.MeshStandardMaterial({ color: 0x555555, roughness: 0.3, metalness: 0.8 });
  mat.frame         = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.5 });
  mat.fluorescentOn = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xeeeedd, emissiveIntensity: 1.5 });
  mat.fluorescentOff= new THREE.MeshStandardMaterial({ color: 0x555544, emissive: 0x333322, emissiveIntensity: 0.15 });
  mat.housing       = new THREE.MeshStandardMaterial({ color: 0x444444, roughness: 0.5, metalness: 0.5 });
  mat.screenGlow    = new THREE.MeshStandardMaterial({ color: 0x003300, emissive: 0x00ff41, emissiveIntensity: 0.4 });
  mat.elevButton    = new THREE.MeshStandardMaterial({ color: 0xffcc00, emissive: 0xffcc00, emissiveIntensity: 1 });
  mat.door          = new THREE.MeshStandardMaterial({ color: 0x3a3525, roughness: 0.9 });
  mat.shelf         = new THREE.MeshStandardMaterial({ color: 0x2a2520, roughness: 0.9 });
  mat.cassette      = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6, metalness: 0.3 });
  mat.crt           = new THREE.MeshStandardMaterial({ color: 0x3a3a35, roughness: 0.7 });
  mat.cinema        = new THREE.MeshStandardMaterial({ color: 0x0a0505, roughness: 0.95 });
  mat.cinemaScreen  = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x333333, emissiveIntensity: 0.3, roughness: 0.5 });
  mat.asphalt       = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.95 });
  mat.roadLine      = new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0x222222, emissiveIntensity: 0.2 });
  mat.ocean          = new THREE.MeshStandardMaterial({ color: 0x0a2a3a, roughness: 0.3, metalness: 0.6 });
  mat.windowGlow     = new THREE.MeshBasicMaterial({ color: 0xffddaa });
  mat.windowDark     = new THREE.MeshBasicMaterial({ color: 0x1a1a1a });

  // Terrain materials
  mat.grass          = new THREE.MeshStandardMaterial({ color: 0x2a3a1a, roughness: 0.95 });
  mat.sand           = new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 0.98 });
  mat.rock           = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.92 });
  mat.pierWood       = new THREE.MeshStandardMaterial({ color: 0x5a4530, roughness: 0.9 });
  mat.sidewalk       = new THREE.MeshStandardMaterial({ color: 0x666666, roughness: 0.88 });
}

/* ═══════════════════════════════════════════
   TEXTURES
   ═══════════════════════════════════════════ */
const textures = {};
function loadTextures(onProgress) {
  return new Promise(resolve => {
    const list = [
      { name: 'face',      url: './assets/face.png' },
      { name: 'poster',    url: './assets/poster.png' },
      { name: 'city',      url: './assets/city.png' },
      { name: 'posterRed', url: './assets/poster_red.png' },
    ];
    let loaded = 0;
    list.forEach(({ name, url }) => {
      textureLoader.load(url, tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.minFilter = THREE.NearestFilter;
        tex.magFilter = THREE.NearestFilter;
        textures[name] = tex;
        loaded++;
        onProgress?.(loaded / list.length);
        if (loaded === list.length) resolve();
      }, undefined, () => {
        loaded++;
        onProgress?.(loaded / list.length);
        if (loaded === list.length) resolve();
      });
    });
  });
}

/* poster material pool — created once after textures load */
const posterMats = [];
const monumentalMats = [];
function initPosterMaterials() {
  const texList = ['face', 'poster', 'city', 'posterRed'];
  texList.forEach(name => {
    if (!textures[name]) return;
    posterMats.push(new THREE.MeshStandardMaterial({
      map: textures[name], roughness: 0.8, side: THREE.DoubleSide,
    }));
    // MeshBasicMaterial is self-illuminated, glowing brightly at night
    monumentalMats.push(new THREE.MeshBasicMaterial({
      map: textures[name],
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.95
    }));
  });
  mat.facePaper = new THREE.MeshBasicMaterial({ map: textures['face'] });
}

/* ═══════════════════════════════════════════
   SILHOUETTE GENERATOR (PROCEDURAL SILHOUETTE)
   ═══════════════════════════════════════════ */
let silhouetteTex = null;
function generateSilhouetteTexture() {
  if (silhouetteTex) return silhouetteTex;

  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');

  // Background is transparent
  ctx.clearRect(0, 0, 128, 256);

  // Draw dark stencil silhouette of John Melo's "Figura Pública"
  ctx.fillStyle = '#0a0a0d';
  
  // Head
  ctx.beginPath();
  ctx.arc(64, 42, 22, 0, Math.PI * 2);
  ctx.fill();
  
  // Neck
  ctx.fillRect(58, 62, 12, 10);
  
  // Torso / Shoulders
  ctx.beginPath();
  ctx.moveTo(30, 72);
  ctx.lineTo(98, 72);
  ctx.lineTo(84, 160);
  ctx.lineTo(44, 160);
  ctx.closePath();
  ctx.fill();

  // Legs
  ctx.fillRect(44, 160, 12, 85);
  ctx.fillRect(72, 160, 12, 85);

  // Glowing red eyes (Figura Pública signature stencil)
  ctx.fillStyle = '#ff0033';
  ctx.fillRect(52, 38, 7, 4);
  ctx.fillRect(69, 38, 7, 4);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  silhouetteTex = texture;
  return texture;
}

function spawnNPC(group, cx, cz, rng, seed, npcs) {
  // NPCs removed per request (lonely atmosphere)
}


/* ═══════════════════════════════════════════
   TEXT SPRITE CACHE
   ═══════════════════════════════════════════ */
const spriteCache = new Map();
function makeTextSprite(text, scale = 1, color = '#f0f0e8', font = 'Helvetica') {
  const key = `${text}|${scale}|${color}|${font}`;
  if (spriteCache.has(key)) {
    // reuse same material
    const s = new THREE.Sprite(spriteCache.get(key));
    s.scale.set(scale * 5, scale * 1.2, 1);
    return s;
  }
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.font = `bold 56px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true });
  spriteCache.set(key, m);
  const s = new THREE.Sprite(m);
  s.scale.set(scale * 5, scale * 1.2, 1);
  return s;
}

/* ═══════════════════════════════════════════
   GENERATIVE ART — canvas-based textures
   Created per-seed, but very lightweight (small canvases)
   ═══════════════════════════════════════════ */
const generatedArtCache = new Map(); // seed → material

function generateArtMaterial(seed) {
  if (generatedArtCache.size > 60) {
    // evict oldest entries to cap memory
    const first = generatedArtCache.keys().next().value;
    const old = generatedArtCache.get(first);
    old.map?.dispose();
    old.dispose();
    generatedArtCache.delete(first);
  }
  if (generatedArtCache.has(seed)) return generatedArtCache.get(seed);

  const rng = mulberry32(seed);
  const size = 256;
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d');

  const type = Math.floor(rng() * 11);

  switch (type) {
    case 0: // halftone face grid
      ctx.fillStyle = '#f0f0e8';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000';
      const gridN = 2 + Math.floor(rng() * 4);
      const cellW = size / gridN;
      for (let r = 0; r < gridN; r++) {
        for (let cl = 0; cl < gridN; cl++) {
          if (rng() > 0.35) {
            ctx.fillRect(cl * cellW + 2, r * cellW + 2, cellW - 4, cellW - 4);
            ctx.clearRect(cl * cellW + cellW * 0.15, r * cellW + cellW * 0.15, cellW * 0.7, cellW * 0.7);
            // draw a circle "face"
            ctx.beginPath();
            ctx.arc(cl * cellW + cellW / 2, r * cellW + cellW / 2, cellW * 0.3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      break;

    case 1: // text composition
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#f0f0e8';
      const phrases = [
        'JOHN MELO', 'FIGURA PÚBLICA', 'VOCÊ JÁ VIU ESTE ROSTO?',
        'PROFISSIONALMENTE NÃO ORTODOXO', 'ROSTOS DISTRIBUÍDOS',
        'INVASÃO', 'PROPAGANDA', 'ARQUIVO', 'VOCÊ ESTÁ SENDO EXPOSTO',
        'NÃO EXISTE OPÇÃO NÃO', 'ESTE É UM DOCUMENTO PÚBLICO',
        'REGISTRO', 'MANIFESTO', 'DISTRIBUIÇÃO GRATUITA',
      ];
      for (let i = 0; i < 8; i++) {
        const fsize = 10 + Math.floor(rng() * 30);
        ctx.font = `bold ${fsize}px ${rng() > 0.5 ? 'Helvetica' : 'Courier New'}`;
        const phrase = phrases[Math.floor(rng() * phrases.length)];
        const tx = rng() * size;
        const ty = 20 + rng() * (size - 40);
        ctx.save();
        ctx.translate(tx, ty);
        ctx.rotate((rng() - 0.5) * 0.3);
        ctx.fillText(phrase, 0, 0);
        ctx.restore();
      }
      break;

    case 2: // noise / static
      {
        const imgData = ctx.createImageData(size, size);
        for (let i = 0; i < imgData.data.length; i += 4) {
          const v = rng() > 0.5 ? 255 : 0;
          imgData.data[i] = v;
          imgData.data[i + 1] = v;
          imgData.data[i + 2] = v;
          imgData.data[i + 3] = 255;
        }
        ctx.putImageData(imgData, 0, 0);
      }
      break;

    case 3: // "registro" document
      ctx.fillStyle = '#f0f0e8';
      ctx.fillRect(0, 0, size, size);
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.strokeRect(10, 10, size - 20, size - 20);
      ctx.fillStyle = '#000';
      ctx.font = 'bold 18px Courier New';
      ctx.fillText('REGISTRO #' + String(Math.floor(rng() * 99999)).padStart(5, '0'), 20, 40);
      ctx.font = '14px Courier New';
      const lines = [
        'LOCAL: ' + ['SHOPPING', 'EXPOSIÇÃO', 'RUA', 'METRÔ', 'PRAÇA', 'GALERIA'][Math.floor(rng() * 6)],
        'DATA: ' + (Math.floor(rng() * 28) + 1) + '/' + (Math.floor(rng() * 12) + 1).toString().padStart(2, '0') + '/20' + (18 + Math.floor(rng() * 8)),
        'AÇÃO: DISTRIBUIÇÃO DE ' + (Math.floor(rng() * 500) + 50) + ' ROSTOS',
        'STATUS: EXECUTADO',
        '',
        'CLASSIFICAÇÃO: FIGURA PÚBLICA',
      ];
      lines.forEach((l, i) => ctx.fillText(l, 20, 65 + i * 20));
      // stamp
      ctx.globalAlpha = 0.15;
      ctx.font = 'bold 60px Helvetica';
      ctx.save();
      ctx.translate(size / 2, size / 2 + 40);
      ctx.rotate(-0.3);
      ctx.fillText('JOHN MELO', 0, 0);
      ctx.restore();
      ctx.globalAlpha = 1;
      break;

    case 4: // striped propaganda
      {
        const stripeH = 8 + Math.floor(rng() * 15);
        for (let y = 0; y < size; y += stripeH * 2) {
          ctx.fillStyle = rng() > 0.8 ? '#ff0000' : '#000';
          ctx.fillRect(0, y, size, stripeH);
          ctx.fillStyle = '#f0f0e8';
          ctx.fillRect(0, y + stripeH, size, stripeH);
        }
        ctx.fillStyle = '#f0f0e8';
        ctx.font = 'bold 40px Helvetica';
        ctx.textAlign = 'center';
        ctx.fillText('JOHN', size / 2, size / 2 - 15);
        ctx.fillText('MELO', size / 2, size / 2 + 35);
      }
      break;

    case 5: // inverted high-contrast blocks
      ctx.fillStyle = '#f0f0e8';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000';
      const blockCount = 3 + Math.floor(rng() * 6);
      for (let i = 0; i < blockCount; i++) {
        const bx = rng() * size;
        const by = rng() * size;
        const bw = 20 + rng() * 80;
        const bh = 20 + rng() * 80;
        ctx.fillRect(bx, by, bw, bh);
      }
      ctx.fillStyle = rng() > 0.5 ? '#ff0000' : '#f0f0e8';
      ctx.font = 'bold 24px Helvetica';
      ctx.textAlign = 'center';
      ctx.fillText('FIGURA PÚBLICA', size / 2, size - 30);
      break;

    case 6: // xerox repeated face pattern
      ctx.fillStyle = '#f0f0e8';
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = '#000';
      // simple face icon
      const faceSize = 30 + Math.floor(rng() * 30);
      const cols = Math.floor(size / faceSize);
      const rows = Math.floor(size / faceSize);
      for (let r = 0; r < rows; r++) {
        for (let cl = 0; cl < cols; cl++) {
          if (rng() > 0.2) {
            const fx = cl * faceSize + faceSize / 2;
            const fy = r * faceSize + faceSize / 2;
            ctx.beginPath();
            ctx.ellipse(fx, fy, faceSize * 0.35, faceSize * 0.42, 0, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      break;

    case 7: // Online image fetch & threshold filter
      ctx.fillStyle = '#f0f0e8';
      ctx.fillRect(0, 0, size, size);
      const img = new Image();
      img.crossOrigin = 'Anonymous';
      img.src = `https://picsum.photos/${size}/${size}?grayscale&random=${seed}`;
      img.onload = () => {
        ctx.drawImage(img, 0, 0, size, size);
        const imgData = ctx.getImageData(0, 0, size, size);
        for(let i=0; i<imgData.data.length; i+=4) {
          let r = imgData.data[i];
          let v = r > 120 ? 255 : 0;
          imgData.data[i] = v;
          imgData.data[i+1] = v;
          imgData.data[i+2] = v;
        }
        ctx.putImageData(imgData, 0, 0);
        ctx.fillStyle = rng() > 0.5 ? '#ff0000' : '#000000';
        ctx.font = 'bold 36px Helvetica';
        ctx.textAlign = 'center';
        ctx.fillText('JOHN MELO', size / 2, size - 20);
        
        // Update the texture when the async load finishes
        if (m && m.map) m.map.needsUpdate = true;
        m.userData = { canvasDataUrl: c.toDataURL() };
      };
      break;

    case 8: // Red-infused photocopy style
      ctx.fillStyle = '#ff1a1a'; // bright red background
      ctx.fillRect(0, 0, size, size);
      const img8 = new Image();
      img8.crossOrigin = 'Anonymous';
      img8.src = `https://picsum.photos/${size}/${size}?grayscale&random=${seed}`;
      img8.onload = () => {
        ctx.drawImage(img8, 0, 0, size, size);
        const imgData = ctx.getImageData(0, 0, size, size);
        for(let i=0; i<imgData.data.length; i+=4) {
          let r = imgData.data[i];
          let v = r > 128 ? 255 : 0;
          if (v === 0) {
            // Keep black shadows black
            imgData.data[i] = 0;
            imgData.data[i+1] = 0;
            imgData.data[i+2] = 0;
          } else {
            // Make highlights bright red
            imgData.data[i] = 255;
            imgData.data[i+1] = 26;
            imgData.data[i+2] = 26;
          }
        }
        ctx.putImageData(imgData, 0, 0);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 32px Helvetica';
        ctx.textAlign = 'center';
        ctx.fillText('MANIFESTO', size / 2, size - 20);
        
        if (m && m.map) m.map.needsUpdate = true;
        m.userData = { canvasDataUrl: c.toDataURL() };
      };
      break;

    case 9: // Glitch / slice collage
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, size, size);
      const img9 = new Image();
      img9.crossOrigin = 'Anonymous';
      img9.src = `https://picsum.photos/${size}/${size}?grayscale&random=${seed}`;
      img9.onload = () => {
        // Draw to temp canvas first for slicing
        const tempC = document.createElement('canvas');
        tempC.width = size; tempC.height = size;
        const tempCtx = tempC.getContext('2d');
        tempCtx.drawImage(img9, 0, 0, size, size);

        // Slice into horizontal strips and offset them
        const numSlices = 6 + Math.floor(rng() * 6);
        const sliceH = size / numSlices;
        for (let i = 0; i < numSlices; i++) {
          const offset = (rng() - 0.5) * 40;
          ctx.drawImage(tempC, 0, i * sliceH, size, sliceH, offset, i * sliceH, size, sliceH);
        }

        // Binarize
        const imgData = ctx.getImageData(0, 0, size, size);
        for(let i=0; i<imgData.data.length; i+=4) {
          let r = imgData.data[i];
          let v = r > 110 ? 240 : 15;
          imgData.data[i] = v;
          imgData.data[i+1] = v;
          imgData.data[i+2] = v;
        }
        ctx.putImageData(imgData, 0, 0);

        // Overlay a red warning block (no yellow!)
        ctx.fillStyle = '#ff1a1a';
        ctx.fillRect(10, size - 50, size - 20, 36);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 22px Helvetica';
        ctx.textAlign = 'center';
        ctx.fillText('JOHN MELO // REPLICADO', size / 2, size - 24);
        
        if (m && m.map) m.map.needsUpdate = true;
        m.userData = { canvasDataUrl: c.toDataURL() };
      };
      break;

    case 10: // Brutalist black/white/red warning poster (no yellow)
      ctx.fillStyle = '#f0f0e8'; // stark paper white background
      ctx.fillRect(0, 0, size, size);
      const img10 = new Image();
      img10.crossOrigin = 'Anonymous';
      img10.src = `https://picsum.photos/${size}/${size}?grayscale&random=${seed}`;
      img10.onload = () => {
        ctx.drawImage(img10, 0, 0, size, size);
        const imgData = ctx.getImageData(0, 0, size, size);
        for(let i=0; i<imgData.data.length; i+=4) {
          let r = imgData.data[i];
          let v = r > 115 ? 240 : 15;
          imgData.data[i] = v;
          imgData.data[i+1] = v;
          imgData.data[i+2] = v;
        }
        ctx.putImageData(imgData, 0, 0);

        // Black warning diagonal stripes at the top
        ctx.fillStyle = '#000000';
        for (let x = -20; x < size + 20; x += 15) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x + 8, 0);
          ctx.lineTo(x - 2, 12);
          ctx.lineTo(x - 10, 12);
          ctx.fill();
        }

        // Bold red stamp text at bottom
        ctx.fillStyle = '#ff1a1a';
        ctx.font = 'bold 20px Helvetica';
        ctx.textAlign = 'center';
        ctx.fillText('REGISTRO PÚBLICO', size / 2, size - 20);
        
        if (m && m.map) m.map.needsUpdate = true;
        m.userData = { canvasDataUrl: c.toDataURL() };
      };
      break;
  }

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  var m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85, side: THREE.DoubleSide });
  m.userData = { canvasDataUrl: c.toDataURL() };
  generatedArtCache.set(seed, m);
  return m;
}

/* ═══════════════════════════════════════════
   ROOM TYPES
   ═══════════════════════════════════════════ */
const ROOM_TYPES = [
  'street',       // open area, billboards, lamp posts
  'backroom',     // fluorescent corridors, beige walls
  'gallery',      // white walls, paintings
  'cinema',       // dark room, screen
  'archive',      // filing cabinets
  'crt',          // computer terminal
  'cassette',     // music player
  'zine',         // bookshelves
  'corridor',     // simple connection corridor
  'void',         // empty dark room
  'secret',       // hidden face room
];

/* ═══════════════════════════════════════════
   CHUNK GENERATOR
   ═══════════════════════════════════════════ */
function generateChunk(cx, cz) {
  const key = `${cx},${cz}`;
  if (chunks.has(key)) return;

  const group = new THREE.Group();
  group.name = `chunk_${key}`;
  const chunkColliders = [];
  const chunkInteractables = [];
  const chunkLights = [];
  const chunkNPCs = [];

  const seed = chunkSeed(cx, cz);
  const rng = mulberry32(seed);

  // World-space origin of this chunk
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;

  // ── OUTDOOR MODE: Biome-based fixed world ──
  if (config.worldMode === 'outdoor') {
    const biome = getBiome(cx, cz);

    switch (biome) {
      case 'ocean':
        buildOceanChunk(group, ox, oz);
        break;
      case 'shore':
        buildShoreChunk(group, ox, oz, rng, seed, chunkColliders, chunkInteractables, chunkLights);
        break;
      case 'city':
        buildCityChunk(group, ox, oz, rng, seed, chunkColliders, chunkInteractables, chunkLights);
        break;
      case 'hills':
        buildHillChunk(group, ox, oz, rng, seed, chunkColliders, chunkInteractables, chunkLights);
        break;
    }

    // Floor faces (collectables) on land chunks
    if (biome !== 'ocean') {
      for (let i = 0; i < 8; i++) {
        const fx = ox + rng() * CHUNK_SIZE;
        const fz = oz + rng() * CHUNK_SIZE;
        const fy = getTerrainHeight(fx, fz);
        if (fy >= -0.5) {
          const p = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), mat.facePaper);
          p.rotation.x = -Math.PI / 2;
          p.rotation.z = rng() * Math.PI;
          p.position.set(fx, fy + 0.05, fz);
          group.add(p);
          chunkInteractables.push(p);
          p.userData = { type: 'paper' };
        }
      }
    }

    applyCreatorCustomizations(group, cx, cz, rng, chunkColliders, chunkInteractables, chunkLights);

    scene.add(group);
    chunks.set(key, { group, colliders: chunkColliders, interactables: chunkInteractables, lights: chunkLights, dustGeo: null, npcs: chunkNPCs });
    return;
  }

  // ── INDOOR MODE: Procedural generation (unchanged) ──

  // ── GROUND ──
  const ground = new THREE.Mesh(geo.chunkFloor, mat.asphalt);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(ox + CHUNK_SIZE / 2, 0, oz + CHUNK_SIZE / 2);
  ground.receiveShadow = true;
  group.add(ground);

  // ── DECIDE ROOM LAYOUT ──
  // The chunk is divided into a 4×4 grid of cells
  // Each cell can be: open, wall, or room
  const grid = [];
  for (let r = 0; r < CELLS_PER_CHUNK; r++) {
    grid[r] = [];
    for (let c = 0; c < CELLS_PER_CHUNK; c++) {
      grid[r][c] = { type: 'open', room: null };
    }
  }

  // Place walls using a maze-like pattern (binary tree method)
  // Each cell decides: wall on east? wall on south?
  for (let r = 0; r < CELLS_PER_CHUNK; r++) {
    for (let c = 0; c < CELLS_PER_CHUNK; c++) {
      // Much fewer walls in outdoor mode to simulate wide open plazas/streets
      grid[r][c].wallEast = config.worldMode === 'outdoor' ? (rng() > 0.98) : (rng() > 0.85);
      grid[r][c].wallSouth = config.worldMode === 'outdoor' ? (rng() > 0.98) : (rng() > 0.85);
    }
  }

  // ── ASSIGN ROOM TYPES TO CELLS ──
  // Probability-weighted selection based on environment mode
  const roomWeightsIndoor = {
    street: 40,
    backroom: 5,
    gallery: 10,
    cinema: 5,
    archive: 5,
    crt: 5,
    cassette: 5,
    zine: 5,
    corridor: 5,
    void: 20,
    secret: 2,
  };
  let roomWeightsOutdoor = {
    street: 100,
    gallery: 5,
    cinema: 2,
    archive: 2,
    crt: 2,
    cassette: 2,
    zine: 2,
    corridor: 5,
    void: 2,
    secret: 5,
  };
  
  if (config.worldMode === 'outdoor') {
    const dist = Math.max(Math.abs(cx), Math.abs(cz));
    if (cx === 0 && cz === 0) {
      // Central Plaza Hub — wide open
      roomWeightsOutdoor.street = 200;
      roomWeightsOutdoor.void = 0;
      roomWeightsOutdoor.gallery = 10;
      roomWeightsOutdoor.secret = 8;
    } else if (dist <= 1) {
      // Inner City — mixed streets and buildings
      roomWeightsOutdoor.street = 60;
      roomWeightsOutdoor.void = 30;
      roomWeightsOutdoor.gallery = 8;
      roomWeightsOutdoor.cassette = 5;
    } else if (dist <= 2) {
      // Dense Commercial — more buildings
      roomWeightsOutdoor.street = 40;
      roomWeightsOutdoor.void = 50;
      roomWeightsOutdoor.gallery = 5;
    } else if (dist <= 3) {
      // Residential/Industrial Outskirts
      roomWeightsOutdoor.street = 80;
      roomWeightsOutdoor.void = 15;
      roomWeightsOutdoor.corridor = 10;
    } else {
      // Waterfront edge — mostly open with sparse structures
      roomWeightsOutdoor.street = 120;
      roomWeightsOutdoor.void = 5;
      roomWeightsOutdoor.secret = 10;
    }
  }
  const roomWeights = config.worldMode === 'outdoor' ? roomWeightsOutdoor : roomWeightsIndoor;
  const totalWeight = Object.values(roomWeights).reduce((a, b) => a + b, 0);

  function pickRoom() {
    let r = rng() * totalWeight;
    for (const [type, w] of Object.entries(roomWeights)) {
      r -= w;
      if (r <= 0) return type;
    }
    return 'street';
  }

  for (let r = 0; r < CELLS_PER_CHUNK; r++) {
    for (let c = 0; c < CELLS_PER_CHUNK; c++) {
      grid[r][c].room = pickRoom();
    }
  }


  // ── BUILD EACH CELL ──
  for (let r = 0; r < CELLS_PER_CHUNK; r++) {
    for (let c = 0; c < CELLS_PER_CHUNK; c++) {
      const cell = grid[r][c];
      const cellX = ox + c * CELL_SIZE + CELL_SIZE / 2;
      const cellZ = oz + r * CELL_SIZE + CELL_SIZE / 2;
      const cellSeed = seed ^ ((r * 17 + c * 31) >>> 0);
      const cellRng = mulberry32(cellSeed);

      buildCell(group, cell, cellX, cellZ, cellRng, cellSeed, chunkColliders, chunkInteractables, chunkLights, chunkNPCs);
    }
  }

  // ── DUST PARTICLES ──
  const dustCount = 80;
  const positions = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    positions[i * 3] = ox + rng() * CHUNK_SIZE;
    positions[i * 3 + 1] = rng() * WALL_HEIGHT;
    positions[i * 3 + 2] = oz + rng() * CHUNK_SIZE;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    color: 0x666666, size: 0.06, transparent: true, opacity: 0.35,
  }));
  group.add(dust);

  // ── FLOOR FACES ──
  for(let i=0; i<15; i++) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.7), mat.facePaper);
      p.rotation.x = -Math.PI/2;
      p.rotation.z = rng() * Math.PI;
      p.position.set(ox + rng()*CHUNK_SIZE, 0.01, oz + rng()*CHUNK_SIZE);
      group.add(p);
      chunkInteractables.push(p);
      p.userData = { type: 'paper' };
  }

  // Illuminated zone randomizer
  if (rng() > 0.7) {
    chunkLights.push({
      type: 'point',
      color: 0xffffff,
      intensity: 2.0,
      distance: CHUNK_SIZE * 1.5,
      position: new THREE.Vector3(ox + CHUNK_SIZE/2, WALL_HEIGHT - 2, oz + CHUNK_SIZE/2),
      flicker: false,
      seed: seed
    });
  }

  applyCreatorCustomizations(group, cx, cz, rng, chunkColliders, chunkInteractables, chunkLights);

  scene.add(group);

  chunks.set(key, {
    group,
    colliders: chunkColliders,
    interactables: chunkInteractables,
    lights: chunkLights, // Stores light definitions instead of live three.js light instances
    npcs: chunkNPCs,     // Procedural NPCs walking/standing in this chunk
    dustGeo,
  });
}

function applyCreatorCustomizations(group, cx, cz, rng, chunkColliders, chunkInteractables, chunkLights) {
  const ox = cx * CHUNK_SIZE;
  const oz = cz * CHUNK_SIZE;
  
  // 1. Spawning custom imported GLTF models
  state.importedModels.forEach(model => {
    const isOutdoor = config.worldMode === 'outdoor';
    const chunkBiome = isOutdoor ? getBiome(cx, cz) : 'indoor';
    
    let matches = false;
    if (model.room === 'street' && isOutdoor && chunkBiome === 'city') matches = true;
    if (model.room === 'hills' && isOutdoor && chunkBiome === 'hills') matches = true;
    if (model.room === 'gallery' && !isOutdoor) matches = true;
    if (model.room === 'backroom' && !isOutdoor) matches = true;
    if (model.room === 'void' && !isOutdoor) matches = true;
    
    if (matches) {
      const count = Math.floor(rng() * 2) + 1;
      for (let attempt = 0; attempt < count; attempt++) {
        if (rng() * 100 < model.chance) {
          const cloned = model.scene.clone();
          
          let px = ox + 5 + rng() * (CHUNK_SIZE - 10);
          let pz = oz + 5 + rng() * (CHUNK_SIZE - 10);
          let py = 0;
          
          if (isOutdoor) {
            py = getTerrainHeight(px, pz);
          } else {
            if (model.placement === 'ceiling') py = WALL_HEIGHT - 0.5;
            else if (model.placement === 'table') py = 1.0;
            else py = 0.05;
          }
          
          cloned.position.set(px, py, pz);
          const sc = model.scale || 1.0;
          cloned.scale.set(sc, sc, sc);
          cloned.rotation.y = rng() * Math.PI * 2;
          
          cloned.traverse(child => {
            if (child.isMesh) {
              child.userData = { type: 'custom_mesh', modelName: model.name };
            }
          });
          
          group.add(cloned);
          if (model.placement === 'floor' || model.placement === 'table') {
            chunkColliders.push(new THREE.Box3().setFromObject(cloned));
          }
        }
      }
    }
  });

  // 2. Custom JS Script execution
  if (state.customScript) {
    try {
      state.customScript(group, cx, cz, rng, chunkColliders, chunkInteractables, chunkLights);
    } catch (e) {
      console.error('Creator Studio script error:', e);
    }
  }
}

/* ═══════════════════════════════════════════
   OUTDOOR BIOME CHUNK BUILDERS
   ═══════════════════════════════════════════ */

function buildOceanChunk(group, ox, oz) {
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE),
    mat.ocean
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(ox + CHUNK_SIZE / 2, -1.5, oz + CHUNK_SIZE / 2);
  group.add(water);
}

function buildShoreChunk(group, ox, oz, rng, seed, colliders, interactables, lights) {
  // Generate terrain mesh with sandy shore
  const segs = 16;
  const terrainGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, segs, segs);
  const pos = terrainGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), lz = pos.getY(i);
    const wx = ox + CHUNK_SIZE / 2 + lx;
    const wz = oz + CHUNK_SIZE / 2 - lz; // Fixed Z-axis flip
    const h = getTerrainHeight(wx, wz);
    pos.setZ(i, Math.max(h, -1.5));
  }
  terrainGeo.computeVertexNormals();
  const terrain = new THREE.Mesh(terrainGeo, mat.sand);
  terrain.rotation.x = -Math.PI / 2;
  terrain.position.set(ox + CHUNK_SIZE / 2, 0, oz + CHUNK_SIZE / 2);
  group.add(terrain);

  // Water below shore
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(CHUNK_SIZE * 1.5, CHUNK_SIZE * 1.5),
    mat.ocean
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(ox + CHUNK_SIZE / 2, -1.5, oz + CHUNK_SIZE / 2);
  group.add(water);

  // Pier generation (50% chance)
  if (rng() > 0.5) {
    const pierLength = 15 + rng() * 20;
    const pierWidth = 3;
    const pierHeight = 1.5;
    const pierX = ox + CHUNK_SIZE * 0.3 + rng() * CHUNK_SIZE * 0.4;
    const pierZ = oz + CHUNK_SIZE * 0.3 + rng() * CHUNK_SIZE * 0.4;

    // Pier deck
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(pierWidth, 0.3, pierLength),
      mat.pierWood
    );
    deck.position.set(pierX, pierHeight, pierZ + pierLength / 2);
    group.add(deck);
    colliders.push(new THREE.Box3().setFromObject(deck));

    // Pier supports
    for (let p = 0; p < pierLength; p += 4) {
      const post = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, pierHeight + 1.5, 0.3),
        mat.pierWood
      );
      post.position.set(pierX - 1, pierHeight / 2, pierZ + p);
      group.add(post);
      const post2 = post.clone();
      post2.position.x = pierX + 1;
      group.add(post2);
    }

    // Lamp at end of pier
    const lamp = new THREE.Mesh(geo.lampPost, mat.metal);
    lamp.position.set(pierX, pierHeight + 3.5, pierZ + pierLength - 2);
    group.add(lamp);
    lights.push({
      type: 'point', color: 0xffaa55, intensity: 0.8, distance: 25,
      position: new THREE.Vector3(pierX, pierHeight + 7, pierZ + pierLength - 2),
      flicker: true, seed
    });
  }

  // Shore lamppost
  if (rng() > 0.4) {
    const lx = ox + 5 + rng() * 30;
    const lz = oz + 5 + rng() * 30;
    const lh = getTerrainHeight(lx, lz);
    if (lh > 0.5) {
      const post = new THREE.Mesh(geo.lampPost, mat.metal);
      post.position.set(lx, lh + 3.5, lz);
      group.add(post);
      lights.push({
        type: 'point', color: 0xffddaa, intensity: 0.5, distance: 20,
        position: new THREE.Vector3(lx, lh + 7.5, lz),
        flicker: false, seed
      });
    }
  }
}

function buildCityChunk(group, ox, oz, rng, seed, colliders, interactables, lights) {
  // Flat asphalt ground
  const ground = new THREE.Mesh(geo.chunkFloor, mat.asphalt);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(ox + CHUNK_SIZE / 2, 0, oz + CHUNK_SIZE / 2);
  group.add(ground);

  // Sidewalks along edges
  const sidewalkGeo = new THREE.BoxGeometry(CHUNK_SIZE, 0.25, 3);
  const sw1 = new THREE.Mesh(sidewalkGeo, mat.sidewalk);
  sw1.position.set(ox + CHUNK_SIZE / 2, 0.125, oz + 1.5);
  group.add(sw1);
  const sw2 = new THREE.Mesh(sidewalkGeo, mat.sidewalk);
  sw2.position.set(ox + CHUNK_SIZE / 2, 0.125, oz + CHUNK_SIZE - 1.5);
  group.add(sw2);

  // Road lines
  for (let i = 0; i < 3; i++) {
    const dashZ = oz + 8 + i * 10;
    const dash = new THREE.Mesh(
      new THREE.PlaneGeometry(0.15, 4),
      mat.roadLine
    );
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(ox + CHUNK_SIZE / 2, 0.02, dashZ);
    group.add(dash);
  }

  // Buildings on this city chunk (2-4 buildings per chunk)
  const numBuildings = 2 + Math.floor(rng() * 3);
  const buildingSlots = [];

  for (let i = 0; i < numBuildings; i++) {
    const bWidth = 4 + rng() * 4;
    const bDepth = 4 + rng() * 4;
    const bHeight = 12 + rng() * 40;
    const side = rng() > 0.5 ? 1 : -1; // which side of the street
    const bx = ox + 4 + rng() * (CHUNK_SIZE - 8);
    const bz = side > 0
      ? oz + CHUNK_SIZE - 3 - bDepth / 2 - rng() * 2
      : oz + 3 + bDepth / 2 + rng() * 2;

    // Check overlap with previous buildings
    let overlaps = false;
    for (const slot of buildingSlots) {
      if (Math.abs(bx - slot.x) < (bWidth + slot.w) / 2 + 2) { overlaps = true; break; }
    }
    if (overlaps) continue;
    buildingSlots.push({ x: bx, w: bWidth });

    const building = new THREE.Mesh(
      new THREE.BoxGeometry(bWidth, bHeight, bDepth),
      mat.concreteDark
    );
    building.position.set(bx, bHeight / 2, bz);
    group.add(building);
    colliders.push(new THREE.Box3().setFromObject(building));

    // Windows on outside
    const winGeo = new THREE.PlaneGeometry(0.6, 0.9);
    const winRows = Math.floor(bHeight / 3.5);
    const halfW = bWidth / 2 + 0.06;
    const halfD = bDepth / 2 + 0.06;

    // Front and back faces
    for (let r = 0; r < winRows; r++) {
      for (let c = -1; c <= 1; c++) {
        if (rng() > 0.25) {
          const isLit = rng() > 0.4;
          const wMat = isLit ? mat.windowGlow : mat.windowDark;
          // Front
          const wf = new THREE.Mesh(winGeo, wMat);
          wf.position.set(bx + c * 1.4, 3 + r * 3.5, bz + halfD);
          group.add(wf);
          // Back
          const wb = new THREE.Mesh(winGeo, wMat);
          wb.position.set(bx + c * 1.4, 3 + r * 3.5, bz - halfD);
          wb.rotation.y = Math.PI;
          group.add(wb);
        }
      }
    }

    // Side windows
    for (let r = 0; r < winRows; r++) {
      if (rng() > 0.3) {
        const isLit = rng() > 0.4;
        const wMat = isLit ? mat.windowGlow : mat.windowDark;
        const ws = new THREE.Mesh(winGeo, wMat);
        ws.position.set(bx + halfW, 3 + r * 3.5, bz);
        ws.rotation.y = Math.PI / 2;
        group.add(ws);
        const ws2 = new THREE.Mesh(winGeo, wMat);
        ws2.position.set(bx - halfW, 3 + r * 3.5, bz);
        ws2.rotation.y = -Math.PI / 2;
        group.add(ws2);
      }
    }

    // Door to indoor (portal)
    if (rng() > 0.5) {
      const doorFrame = new THREE.Mesh(geo.doorway, mat.metal);
      const doorZ = side > 0 ? bz - bDepth / 2 - 0.1 : bz + bDepth / 2 + 0.1;
      doorFrame.position.set(bx, 2.5, doorZ);
      group.add(doorFrame);

      const doorPane = new THREE.Mesh(geo.doorway, mat.door);
      doorPane.position.set(bx, 2.5, doorZ + (side > 0 ? -0.05 : 0.05));
      doorPane.userData = { type: 'portal', targetMode: 'indoor' };
      interactables.push(doorPane);
      group.add(doorPane);

      const sign = makeTextSprite('ENTRAR', 0.35, '#00ff41', 'Courier New');
      sign.position.set(bx, 5.5, doorZ);
      group.add(sign);
    }

    // Monumental art on side
    // Monumental art on side (highly likely to cover city in John Melo faces)
    if (monumentalMats.length > 0 && rng() > 0.15) {
      const artMat = monumentalMats[Math.floor(rng() * monumentalMats.length)];
      const artH = bHeight * 0.4;
      const artW = bWidth * 0.8;
      const artMesh = new THREE.Mesh(new THREE.PlaneGeometry(artW, artH), artMat);
      const artSide = rng() > 0.5 ? halfW : -halfW;
      artMesh.position.set(bx + artSide, bHeight * 0.4, bz);
      artMesh.rotation.y = artSide > 0 ? Math.PI / 2 : -Math.PI / 2;
      group.add(artMesh);
    }
  }

  // Standalone dual-sided sidewalk billboards
  if (posterMats.length > 0 && rng() > 0.25) {
    const bx = ox + 6 + rng() * (CHUNK_SIZE - 12);
    const bz = rng() > 0.5 ? oz + 3 : oz + CHUNK_SIZE - 3;
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.3, 7, 0.3), mat.metal);
    pole.position.set(bx, 3.5, bz);
    group.add(pole);
    colliders.push(new THREE.Box3().setFromObject(pole));
    
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(4.5, 3.5, 0.3), 
      posterMats[Math.floor(rng() * posterMats.length)]
    );
    board.position.set(bx, 6, bz);
    group.add(board);
  }

  // Street lampposts
  for (let i = 0; i < 2; i++) {
    const lx = ox + 8 + i * 22;
    const post = new THREE.Mesh(geo.lampPost, mat.metal);
    post.position.set(lx, 3.5, oz + CHUNK_SIZE / 2);
    group.add(post);
    colliders.push(new THREE.Box3().setFromObject(post));

    lights.push({
      type: 'point', color: 0xffddaa, intensity: 0.6, distance: 22,
      position: new THREE.Vector3(lx, 7.5, oz + CHUNK_SIZE / 2),
      flicker: rng() > 0.85, seed
    });
  }
}

function buildHillChunk(group, ox, oz, rng, seed, colliders, interactables, lights) {
  // Generate deformed terrain mesh
  const segs = 20;
  const terrainGeo = new THREE.PlaneGeometry(CHUNK_SIZE, CHUNK_SIZE, segs, segs);
  const pos = terrainGeo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const lx = pos.getX(i), lz = pos.getY(i);
    const wx = ox + CHUNK_SIZE / 2 + lx;
    const wz = oz + CHUNK_SIZE / 2 - lz; // Fixed Z-axis flip
    pos.setZ(i, getTerrainHeight(wx, wz));
  }
  terrainGeo.computeVertexNormals();
  const terrain = new THREE.Mesh(terrainGeo, mat.grass);
  terrain.rotation.x = -Math.PI / 2;
  terrain.position.set(ox + CHUNK_SIZE / 2, 0, oz + CHUNK_SIZE / 2);
  group.add(terrain);

  // Scattered rocks
  const rockCount = Math.floor(rng() * 4);
  for (let i = 0; i < rockCount; i++) {
    const rx = ox + 4 + rng() * (CHUNK_SIZE - 8);
    const rz = oz + 4 + rng() * (CHUNK_SIZE - 8);
    const rh = getTerrainHeight(rx, rz);
    if (rh < 0) continue;
    const rockSize = 1 + rng() * 3;
    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(rockSize, 1),
      mat.rock
    );
    rock.position.set(rx, rh + rockSize * 0.3, rz);
    rock.rotation.set(rng() * Math.PI, rng() * Math.PI, 0);
    group.add(rock);
    colliders.push(new THREE.Box3().setFromObject(rock));
  }

  // Dead trees / poles
  const treeCount = Math.floor(rng() * 3);
  for (let i = 0; i < treeCount; i++) {
    const tx = ox + 3 + rng() * (CHUNK_SIZE - 6);
    const tz = oz + 3 + rng() * (CHUNK_SIZE - 6);
    const th = getTerrainHeight(tx, tz);
    if (th < 1) continue;
    const treeH = 5 + rng() * 8;
    const trunk = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, treeH, 0.4),
      mat.concreteDark
    );
    trunk.position.set(tx, th + treeH / 2, tz);
    group.add(trunk);
    colliders.push(new THREE.Box3().setFromObject(trunk));

    // Bare branches
    for (let b = 0; b < 3; b++) {
      const branchLen = 2 + rng() * 3;
      const branch = new THREE.Mesh(
        new THREE.BoxGeometry(branchLen, 0.15, 0.15),
        mat.concreteDark
      );
      const by = th + treeH * 0.5 + b * 1.5;
      const angle = rng() * Math.PI * 2;
      branch.position.set(
        tx + Math.cos(angle) * branchLen * 0.4,
        by,
        tz + Math.sin(angle) * branchLen * 0.4
      );
      branch.rotation.y = angle;
      branch.rotation.z = (rng() - 0.5) * 0.5;
      group.add(branch);
    }
  }

  // Creepy propaganda signposts on the hills (wooden posts with John Melo face)
  const signCount = Math.floor(rng() * 2);
  for (let i = 0; i < signCount; i++) {
    const sx = ox + 5 + rng() * (CHUNK_SIZE - 10);
    const sz = oz + 5 + rng() * (CHUNK_SIZE - 10);
    const sh = getTerrainHeight(sx, sz);
    if (sh > 1) {
      const pole = new THREE.Mesh(new THREE.BoxGeometry(0.2, 4, 0.2), mat.pierWood);
      pole.position.set(sx, sh + 2, sz);
      group.add(pole);
      colliders.push(new THREE.Box3().setFromObject(pole));

      const board = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6, 2.2),
        new THREE.MeshBasicMaterial({ map: textures['face'], side: THREE.DoubleSide })
      );
      board.position.set(sx, sh + 3.8, sz);
      board.rotation.y = rng() * Math.PI;
      group.add(board);
    }
  }

  // Portal door to indoor (rare on hills)
  if (rng() > 0.8) {
    const dx = ox + 10 + rng() * 20;
    const dz = oz + 10 + rng() * 20;
    const dh = getTerrainHeight(dx, dz);
    if (dh > 2) {
      const portalBlock = new THREE.Mesh(
        new THREE.BoxGeometry(4, WALL_HEIGHT, 1.2),
        mat.concreteDark
      );
      portalBlock.position.set(dx, dh + WALL_HEIGHT / 2, dz);
      group.add(portalBlock);
      colliders.push(new THREE.Box3().setFromObject(portalBlock));

      const doorPane = new THREE.Mesh(geo.doorway, mat.door);
      doorPane.position.set(dx, dh + 2.5, dz + 0.65);
      doorPane.userData = { type: 'portal', targetMode: 'indoor' };
      interactables.push(doorPane);
      group.add(doorPane);

      const sign = makeTextSprite('ENTRAR NO PRÉDIO', 0.4, '#00ff41', 'Courier New');
      sign.position.set(dx, dh + 5.8, dz + 0.7);
      group.add(sign);
    }
  }

  // Atmospheric light
  if (rng() > 0.5) {
    const lx = ox + CHUNK_SIZE / 2;
    const lz = oz + CHUNK_SIZE / 2;
    const lh = getTerrainHeight(lx, lz);
    lights.push({
      type: 'point', color: 0xaabbcc, intensity: 0.2, distance: 30,
      position: new THREE.Vector3(lx, Math.max(lh, 0) + 10, lz),
      flicker: false, seed
    });
  }
}

/* ═══════════════════════════════════════════
   CELL BUILDER
   ═══════════════════════════════════════════ */
function buildCell(group, cell, cx, cz, rng, seed, colliders, interactables, lights, npcs) {
  const halfCell = CELL_SIZE / 2;
  const hy = WALL_HEIGHT / 2;

  // Outdoor mode override: bypass indoor wall layouts & ceilings entirely
  if (config.worldMode === 'outdoor') {
    let mode = 'street';
    if (cell.room === 'void') {
      mode = 'void';
    } else if (cell.room === 'secret') {
      mode = 'secret';
    } else if (rng() > 0.5) {
      mode = 'plaza';
    }

    switch (mode) {
      case 'street': buildStreetCell(group, cx, cz, rng, seed, colliders, interactables, lights, npcs); break;
      case 'void': buildSkyscraper(group, cx, cz, rng, seed, colliders); break;
      case 'secret': buildSecretOutdoorCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
      case 'plaza': buildPlazaCell(group, cx, cz, rng, seed, colliders, interactables, lights, npcs); break;
    }
    return;
  }

  // ── WALLS ──
  if (cell.wallEast) {
    const w = new THREE.Mesh(geo.wallThin, pickWallMat(cell.room));
    w.position.set(cx + halfCell, hy, cz);
    group.add(w);
    colliders.push(new THREE.Box3().setFromObject(w));
  }
  if (cell.wallSouth) {
    const w = new THREE.Mesh(geo.wallThinX, pickWallMat(cell.room));
    w.position.set(cx, hy, cz + halfCell);
    group.add(w);
    colliders.push(new THREE.Box3().setFromObject(w));
  }

  // ── CELL CEILING (only in indoor mode) ──
  if (cell.room !== 'street' && config.worldMode === 'indoor') {
    const ceil = new THREE.Mesh(geo.floor, pickCeilingMat(cell.room));
    ceil.rotation.x = Math.PI / 2;
    ceil.position.set(cx, WALL_HEIGHT, cz);
    group.add(ceil);
  }


  // ── ROOM-SPECIFIC CONTENT ──
  switch (cell.room) {
    case 'street': buildStreetCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
    case 'backroom': buildBackroomCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
    case 'gallery': buildGalleryCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
    case 'cinema': buildCinemaCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
    case 'archive': buildArchiveCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
    case 'crt': buildCRTCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
    case 'cassette': buildCassetteCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
    case 'zine': buildZineCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
    case 'corridor': buildCorridorCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
    case 'void':
      if (config.worldMode === 'outdoor') {
        buildSkyscraper(group, cx, cz, rng, seed, colliders);
      } else {
        buildVoidCell(group, cx, cz, rng, seed, colliders, interactables, lights);
      }
      break;
    case 'secret': buildSecretCell(group, cx, cz, rng, seed, colliders, interactables, lights); break;
  }
}

/* ═══════════════ OUTDOOR: SKYSCRAPER ═══════════════ */
function buildSkyscraper(group, cx, cz, rng, seed, colliders) {
  const bHeight = 20 + rng() * 45; // Varied heights
  const bWidth = CELL_SIZE * 0.55; // Smaller footprint for walkability
  
  // Brutalist building box
  const buildingMesh = new THREE.Mesh(
    new THREE.BoxGeometry(bWidth, bHeight, bWidth),
    mat.concreteDark
  );
  buildingMesh.position.set(cx, bHeight / 2, cz);
  group.add(buildingMesh);
  colliders.push(new THREE.Box3().setFromObject(buildingMesh));

  // Monumental Art Poster on building side
  if (monumentalMats.length > 0 && rng() > 0.3) {
    const artMat = monumentalMats[Math.floor(rng() * monumentalMats.length)];
    const artHeight = bHeight * 0.5;
    const artWidth = bWidth * 0.85;
    const artGeo = new THREE.PlaneGeometry(artWidth, artHeight);
    const artMesh = new THREE.Mesh(artGeo, artMat);
    
    const faceIndex = Math.floor(rng() * 4);
    let px = cx, pz = cz, ry = 0;
    const offset = bWidth / 2 + 0.05;
    
    switch (faceIndex) {
      case 0: pz += offset; ry = 0; break;
      case 1: pz -= offset; ry = Math.PI; break;
      case 2: px += offset; ry = Math.PI / 2; break;
      case 3: px -= offset; ry = -Math.PI / 2; break;
    }
    
    artMesh.position.set(px, 3.0 + artHeight / 2, pz);
    artMesh.rotation.y = ry;
    group.add(artMesh);
  }

  // Procedural Window grids — ON THE OUTSIDE of the building
  const winRows = Math.floor(bHeight / 3.5) - 1;
  const winGeo = new THREE.PlaneGeometry(0.7, 1.0);
  const halfW = bWidth / 2 + 0.06; // offset outside building face

  // 4 facades
  const facades = [
    { dx: 0, dz: halfW, ry: 0 },          // North
    { dx: 0, dz: -halfW, ry: Math.PI },    // South
    { dx: halfW, dz: 0, ry: Math.PI / 2 }, // East
    { dx: -halfW, dz: 0, ry: -Math.PI / 2} // West
  ];

  facades.forEach(f => {
    for (let r = 0; r < winRows; r++) {
      for (let c = -1; c <= 1; c++) {
        if (rng() > 0.3) {
          const isLit = rng() > 0.4;
          const w = new THREE.Mesh(winGeo, isLit ? mat.windowGlow : mat.windowDark);
          const wy = 3 + r * 3.5;

          // Place windows along the facade direction
          if (Math.abs(f.dz) > 0.01) {
            // North/South face
            w.position.set(cx + c * 1.5, wy, cz + f.dz);
          } else {
            // East/West face
            w.position.set(cx + f.dx, wy, cz + c * 1.5);
          }
          w.rotation.y = f.ry;
          group.add(w);
        }
      }
    }
  });
}

/* ═══════════════ OUTDOOR: PLAZA CELL ═══════════════ */
function buildPlazaCell(group, cx, cz, rng, seed, colliders, interactables, lights, npcs) {
  // Spawn 1-2 silhouettes in plazas (Removed for Silent Hill vibe)

  // Flat concrete plaza ground instead of dark asphalt
  const groundMesh = new THREE.Mesh(geo.floor, mat.concreteLight);
  groundMesh.position.set(cx, 0.015, cz);
  groundMesh.rotation.x = -Math.PI / 2;
  group.add(groundMesh);

  // Sidewalk curb around the plaza cell border
  const curbHeight = 0.3;
  const sidewalkCurb = new THREE.Mesh(
    new THREE.BoxGeometry(CELL_SIZE, curbHeight, 0.6),
    mat.concreteDark
  );
  sidewalkCurb.position.set(cx, curbHeight / 2, cz + CELL_SIZE * 0.45);
  group.add(sidewalkCurb);
  colliders.push(new THREE.Box3().setFromObject(sidewalkCurb));

  // Brutalist concrete benches
  const benchCount = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < benchCount; i++) {
    const bx = cx + (rng() - 0.5) * 6;
    const bz = cz + (rng() - 0.5) * 6;
    
    // Bench seat
    const benchSeat = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.2, 0.8), mat.concrete);
    benchSeat.position.set(bx, 0.8, bz);
    group.add(benchSeat);
    colliders.push(new THREE.Box3().setFromObject(benchSeat));

    // Bench legs
    const legL = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.7, 0.8), mat.concreteDark);
    legL.position.set(bx - 0.9, 0.35, bz);
    group.add(legL);

    const legR = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.7, 0.8), mat.concreteDark);
    legR.position.set(bx + 0.9, 0.35, bz);
    group.add(legR);
  }

  // Centered plaza lamppost
  if (rng() > 0.3) {
    const post = new THREE.Mesh(geo.lampPost, mat.metal);
    post.position.set(cx, 3.5, cz);
    group.add(post);

    lights.push({
      type: 'point',
      color: 0xffddaa,
      intensity: 0.6,
      distance: 22,
      position: new THREE.Vector3(cx, 7.5, cz),
      flicker: rng() > 0.8,
      seed: seed
    });
  }

  // Giant central double-sided Billboard advertising John Melo
  if (rng() > 0.4 && posterMats.length > 0) {
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.4, 9, 0.4), mat.metal);
    pole.position.set(cx + 2.5, 4.5, cz - 2.5);
    group.add(pole);
    colliders.push(new THREE.Box3().setFromObject(pole));

    const board = new THREE.Mesh(geo.posterBig, posterMats[Math.floor(rng() * posterMats.length)]);
    board.position.set(cx + 2.5, 10, cz - 2.5);
    group.add(board);
  }
}

/* ═══════════════ OUTDOOR: SECRET CELL (PORTAL INSIDE) ═══════════════ */
function buildSecretOutdoorCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  // Red warning spotlight
  lights.push({
    type: 'spot',
    color: 0xff0000,
    intensity: 1.5,
    distance: 20,
    angle: Math.PI / 4,
    penumbra: 0.5,
    position: new THREE.Vector3(cx, WALL_HEIGHT + 2, cz),
    targetPos: new THREE.Vector3(cx, 0, cz)
  });

  // Portal block standing in the open space
  const portalBlock = new THREE.Mesh(
    new THREE.BoxGeometry(4, WALL_HEIGHT, 1.2),
    mat.concreteDark
  );
  portalBlock.position.set(cx, WALL_HEIGHT / 2, cz);
  group.add(portalBlock);
  colliders.push(new THREE.Box3().setFromObject(portalBlock));

  // Metal door frame
  const doorFrame = new THREE.Mesh(geo.doorway, mat.metal);
  doorFrame.position.set(cx, 2.5, cz + 0.61);
  group.add(doorFrame);

  // Portal door pane
  const doorPane = new THREE.Mesh(geo.doorway, mat.door);
  doorPane.position.set(cx, 2.5, cz + 0.55);
  doorPane.userData = { type: 'portal', targetMode: 'indoor' };
  interactables.push(doorPane);
  group.add(doorPane);

  const sign = makeTextSprite('ENTRAR NO PRÉDIO', 0.45, '#00ff41', 'Courier New');
  sign.position.set(cx, 5.8, cz + 0.61);
  group.add(sign);
}


function pickWallMat(room) {
  switch (room) {
    case 'gallery': return mat.white;
    case 'backroom': return mat.backroomsWall;
    case 'cinema': case 'void': case 'secret': return mat.concreteDark;
    case 'street': return mat.concrete;
    default: return mat.concrete;
  }
}

function pickCeilingMat(room) {
  switch (room) {
    case 'gallery': return mat.white;
    case 'backroom': return mat.backroomsWall;
    case 'cinema': case 'void': case 'secret': return mat.asphalt; // Asphalt is now grey (0x333333)
    default: return mat.concrete;
  }
}

/* ═══════════════ CELL: STREET ═══════════════ */
function buildStreetCell(group, cx, cz, rng, seed, colliders, interactables, lights, npcs) {
  // NPCs removed
  // Lamp post
  if (rng() > 0.5) {
    const lx = cx + (rng() - 0.5) * 6;
    const lz = cz + (rng() - 0.5) * 6;
    const post = new THREE.Mesh(geo.lampPost, mat.metal);
    post.position.set(lx, 3.5, lz);
    group.add(post);
    lights.push({
      type: 'point',
      color: 0xffddaa,
      intensity: 0.5,
      distance: 20,
      position: new THREE.Vector3(lx, 7.5, lz),
      flicker: false,
      seed: seed
    });
  }



  // Road lines
  if (rng() > 0.6) {
    const lineGeo = new THREE.PlaneGeometry(0.15, CELL_SIZE * 0.8);
    const line = new THREE.Mesh(lineGeo, mat.roadLine);
    line.rotation.x = -Math.PI / 2;
    line.position.set(cx, 0.01, cz);
    group.add(line);
  }

  // Procedural portal to inside (only in outdoor mode)
  if (config.worldMode === 'outdoor' && rng() > 0.85) {
    const doorFrame = new THREE.Mesh(geo.doorway, mat.metal);
    doorFrame.position.set(cx, 2.5, cz - 4.5);
    group.add(doorFrame);

    const doorPane = new THREE.Mesh(geo.doorway, mat.concreteDark);
    doorPane.position.set(cx, 2.5, cz - 4.4);
    doorPane.userData = { type: 'portal', targetMode: 'indoor' };
    interactables.push(doorPane);
    group.add(doorPane);

    const sign = makeTextSprite('ENTRAR NO PRÉDIO', 0.45, '#00ff41', 'Courier New');
    sign.position.set(cx, 5.5, cz - 4.5);
    group.add(sign);
  }
}


/* ═══════════════ CELL: BACKROOM ═══════════════ */
function buildBackroomCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  // Floor override
  const fl = new THREE.Mesh(geo.floor, mat.backroomsFloor);
  fl.rotation.x = -Math.PI / 2;
  fl.position.set(cx, 0.02, cz);
  fl.receiveShadow = true;
  group.add(fl);

  // Fluorescent light
  const tube = new THREE.Mesh(geo.fluorescentTube, mat.fluorescentOn);
  tube.position.set(cx, WALL_HEIGHT - 0.3, cz);
  group.add(tube);
  const hous = new THREE.Mesh(geo.fluorescentHousing, mat.housing);
  hous.position.set(cx, WALL_HEIGHT - 0.18, cz);
  group.add(hous);

  // Fluorescent lights in Backrooms are always ON and bright
  const isFlickering = rng() > 0.8;
  lights.push({
    type: 'point',
    color: 0xf4f3d6,
    intensity: 2.6,
    distance: 26,
    position: new THREE.Vector3(cx, WALL_HEIGHT - 0.5, cz),
    flicker: isFlickering,
    seed: seed ^ 0x9923
  });


  // Random door
  if (rng() > 0.6) {
    const side = rng() > 0.5 ? 4.5 : -4.5;
    const d = new THREE.Mesh(geo.doorway, mat.door);
    d.position.set(cx + side, 2.5, cz + (rng() - 0.5) * 3);
    d.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(d);
  }

  // Face poster on wall
  if (rng() > 0.55 && posterMats.length > 0) {
    const p = new THREE.Mesh(geo.posterSmall, posterMats[Math.floor(rng() * posterMats.length)]);
    const side = rng() > 0.5 ? 4.7 : -4.7;
    p.position.set(cx + side, 2 + rng() * 2, cz + (rng() - 0.5) * 4);
    p.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(p);
  }

  // Procedural portal to outside (only in indoor mode)
  if (config.worldMode === 'indoor' && rng() > 0.85) {
    const doorFrame = new THREE.Mesh(geo.doorway, mat.metal);
    doorFrame.position.set(cx, 2.5, cz + 4.5);
    group.add(doorFrame);

    const doorPane = new THREE.Mesh(geo.doorway, mat.door);
    doorPane.position.set(cx, 2.5, cz + 4.4);
    doorPane.userData = { type: 'portal', targetMode: 'outdoor' };
    interactables.push(doorPane);
    group.add(doorPane);

    const sign = makeTextSprite('SAÍDA PARA A RUA', 0.45, '#ff0000', 'Courier New');
    sign.position.set(cx, 5.5, cz + 4.5);
    group.add(sign);
  }
}


/* ═══════════════ CELL: GALLERY ═══════════════ */
function buildGalleryCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  // Polished dark floor
  const fl = new THREE.Mesh(geo.floor, mat.floorPolished);
  fl.rotation.x = -Math.PI / 2;
  fl.position.set(cx, 0.02, cz);
  group.add(fl);

  // Spot light definition
  const spotX = cx + (rng() - 0.5) * 3;
  const spotZ = cz + (rng() - 0.5) * 3;
  lights.push({
    type: 'spot',
    color: 0xffffff,
    intensity: 2.0,
    distance: 22,
    angle: Math.PI / 5,
    penumbra: 0.5,
    position: new THREE.Vector3(spotX, WALL_HEIGHT - 0.5, spotZ),
    targetPos: new THREE.Vector3(cx, 2, cz)
  });

  // 1–3 paintings
  const count = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < count; i++) {
    const useGenerated = rng() > 0.4;
    const paintingMat = useGenerated
      ? generateArtMaterial(seed ^ (i * 9973))
      : (posterMats.length > 0 ? posterMats[Math.floor(rng() * posterMats.length)] : mat.white);

    const isWide = rng() > 0.6;
    const geoType = isWide ? geo.posterWide : geo.poster;
    const frameGeo = isWide ? geo.frameWide : geo.frame;

    const side = rng() > 0.5 ? 4.7 : -4.7;
    const py = 2.5 + rng() * 1.5;
    const pz = cz + (rng() - 0.5) * 5;
    const rot = side > 0 ? -Math.PI / 2 : Math.PI / 2;

    // Frame
    const frame = new THREE.Mesh(frameGeo, mat.frame);
    frame.position.set(cx + side, py, pz);
    frame.rotation.y = rot;
    group.add(frame);

    // Canvas
    const painting = new THREE.Mesh(geoType, paintingMat);
    painting.position.set(cx + side + (side > 0 ? -0.12 : 0.12), py, pz);
    painting.rotation.y = rot;
    painting.userData = {
      type: 'painting',
      id: String(seed ^ i).slice(-5).padStart(5, '0'),
      title: useGenerated ? 'OBRA GENERATIVA #' + ((seed ^ i) & 0xFFFF) : 'JOHN MELO',
      meta: useGenerated
        ? 'Geração procedural — Seed ' + (seed ^ i)
        : ['Impressão em alto contraste', 'Xerografia sobre papel', 'Serigrafia', 'Montagem digital'][Math.floor(rng() * 4)] + ' — 20' + (18 + Math.floor(rng() * 8)),
      texName: useGenerated ? null : ['face', 'poster', 'city', 'posterRed'][Math.floor(rng() * 4)],
      desc: useGenerated 
        ? 'MEMORIAL TÉCNICO: Obra visual de John Melo gerada algoritmicamente por síntese de tela determinística baseada na seed ' + (seed ^ i) + '. Processada localmente por binarização estocástica e técnicas mistas.'
        : 'MEMORIAL TÉCNICO: Registro visual analógico / xerográfico de John Melo (Figura Pública). Capturado e distribuído na rede pública como documento de manifesto artístico.',
    };
    interactables.push(painting);
    group.add(painting);
  }
}

/* ═══════════════ CELL: CINEMA ═══════════════ */
function buildCinemaCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  const fl = new THREE.Mesh(geo.floor, mat.cinema);
  fl.rotation.x = -Math.PI / 2;
  fl.position.set(cx, 0.02, cz);
  group.add(fl);

  // Screen
  const screen = new THREE.Mesh(geo.posterBig, mat.cinemaScreen);
  screen.position.set(cx, WALL_HEIGHT * 0.55, cz + 4.5);
  screen.rotation.y = Math.PI;
  screen.userData = { type: 'cinema' };
  interactables.push(screen);
  group.add(screen);

  // Seats
  for (let r = 0; r < 2; r++) {
    for (let s = -1; s <= 1; s++) {
      const seat = new THREE.Mesh(geo.seat, mat.concreteDark);
      seat.position.set(cx + s * 2.2, 0.7, cz - 1 + r * 2.5);
      group.add(seat);
    }
  }

  // Dim red light definition
  lights.push({
    type: 'point',
    color: 0xff2200,
    intensity: 0.25,
    distance: 15,
    position: new THREE.Vector3(cx, WALL_HEIGHT - 1, cz),
    flicker: false,
    seed: seed
  });
}

/* ═══════════════ CELL: ARCHIVE ═══════════════ */
function buildArchiveCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  // Fluorescent
  const tube = new THREE.Mesh(geo.fluorescentTube, mat.fluorescentOn);
  tube.position.set(cx, WALL_HEIGHT - 0.3, cz);
  group.add(tube);
  
  lights.push({
    type: 'point',
    color: 0xeeeedd,
    intensity: 2.2,
    distance: 22,
    position: new THREE.Vector3(cx, WALL_HEIGHT - 0.5, cz),
    flicker: false,
    seed: seed
  });

  // Filing boxes (2–5)
  const count = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i++) {
    const bx = cx + (rng() - 0.5) * 6;
    const bz = cz + (rng() - 0.5) * 6;
    const box = new THREE.Mesh(geo.box, mat.concreteLight);
    box.position.set(bx, 1, bz);
    box.userData = {
      type: 'archive',
      year: 2016 + Math.floor(rng() * 10),
    };
    interactables.push(box);
    group.add(box);
    colliders.push(new THREE.Box3().setFromObject(box));

    // Year label
    const label = makeTextSprite(String(box.userData.year), 0.25, '#f0f0e8', 'Courier New');
    label.position.set(bx, 2.2, bz);
    group.add(label);
  }
}

/* ═══════════════ CELL: CRT ═══════════════ */
function buildCRTCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  const fl = new THREE.Mesh(geo.floor, mat.floor);
  fl.rotation.x = -Math.PI / 2;
  fl.position.set(cx, 0.02, cz);
  group.add(fl);

  // Desk
  const desk = new THREE.Mesh(geo.table, mat.concreteLight);
  desk.position.set(cx, 1.9, cz + 1);
  group.add(desk);
  // Legs
  [[-1.2, -0.8], [1.2, -0.8], [-1.2, 0.8], [1.2, 0.8]].forEach(([dx, dz]) => {
    const leg = new THREE.Mesh(geo.tableLeg, mat.metal);
    leg.position.set(cx + dx, 0.9, cz + 1 + dz);
    group.add(leg);
  });

  // CRT body
  const body = new THREE.Mesh(geo.crtBody, mat.crt);
  body.position.set(cx, 2.65, cz + 1);
  group.add(body);
  colliders.push(new THREE.Box3().setFromObject(body));

  // Screen
  const scr = new THREE.Mesh(geo.crtScreen, mat.screenGlow);
  scr.position.set(cx, 2.65, cz + 0.33);
  scr.userData = { type: 'crt' };
  interactables.push(scr);
  group.add(scr);

  // Green glow definition
  lights.push({
    type: 'point',
    color: 0x00ff41,
    intensity: 0.25,
    distance: 8,
    position: new THREE.Vector3(cx, 3.2, cz),
    flicker: true,
    seed: seed ^ 0x7777
  });

  // Chair
  const chair = new THREE.Mesh(geo.seat, mat.concreteDark);
  chair.position.set(cx, 0.7, cz - 1.2);
  group.add(chair);
}

/* ═══════════════ CELL: CASSETTE ═══════════════ */
function buildCassetteCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  // Table
  const desk = new THREE.Mesh(geo.table, mat.concreteLight);
  desk.position.set(cx, 1.9, cz);
  group.add(desk);
  [[-1.2, -0.8], [1.2, -0.8], [-1.2, 0.8], [1.2, 0.8]].forEach(([dx, dz]) => {
    const leg = new THREE.Mesh(geo.tableLeg, mat.metal);
    leg.position.set(cx + dx, 0.9, cz + dz);
    group.add(leg);
  });

  // Cassette player
  const cas = new THREE.Mesh(geo.cassetteBox, mat.cassette);
  cas.position.set(cx, 2.22, cz);
  cas.userData = { type: 'cassette' };
  interactables.push(cas);
  group.add(cas);

  // Warm light definition
  lights.push({
    type: 'point',
    color: 0xffaa55,
    intensity: 2.0,
    distance: 20,
    position: new THREE.Vector3(cx, WALL_HEIGHT - 0.5, cz),
    flicker: false,
    seed: seed
  });

  // Label
  const label = makeTextSprite('TOCA-FITAS', 0.35, '#ffaa55', 'Courier New');
  label.position.set(cx, 0.8, cz - 3);
  group.add(label);
}

/* ═══════════════ CELL: ZINE ═══════════════ */
function buildZineCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  // Fluorescent
  const tube = new THREE.Mesh(geo.fluorescentTube, mat.fluorescentOn);
  tube.position.set(cx, WALL_HEIGHT - 0.3, cz);
  group.add(tube);
  
  lights.push({
    type: 'point',
    color: 0xeeeedd,
    intensity: 2.4,
    distance: 24,
    position: new THREE.Vector3(cx, WALL_HEIGHT - 0.5, cz),
    flicker: false,
    seed: seed
  });

  // Bookshelves (1–3)
  const shelfCount = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < shelfCount; i++) {
    const sx = cx - 3 + i * 3;
    const shelf = new THREE.Mesh(geo.boxTall, mat.shelf);
    shelf.position.set(sx, 2, cz + 3.5);
    group.add(shelf);
    colliders.push(new THREE.Box3().setFromObject(shelf));

    // Zines on shelf
    for (let j = 0; j < 3; j++) {
      const z = new THREE.Mesh(geo.zine, new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(rng() * 0.1, 0.15, 0.25 + rng() * 0.2),
        roughness: 0.9,
      }));
      z.position.set(sx - 0.4 + j * 0.4, 1 + j * 1.2, cz + 3.5);
      z.userData = { type: 'zine', id: (seed ^ (i * 3 + j)) & 0xFFFF };
      interactables.push(z);
      group.add(z);
    }
  }
}

/* ═══════════════ CELL: CORRIDOR ═══════════════ */
function buildCorridorCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  // Fluorescent (bright)
  const tube = new THREE.Mesh(geo.fluorescentTube, mat.fluorescentOn);
  tube.position.set(cx, WALL_HEIGHT - 0.3, cz);
  group.add(tube);

  lights.push({
    type: 'point',
    color: 0xeeeedd,
    intensity: 2.2,
    distance: 22,
    position: new THREE.Vector3(cx, WALL_HEIGHT - 0.5, cz),
    flicker: rng() > 0.8,
    seed: seed
  });

  // Random face poster
  if (rng() > 0.6 && posterMats.length > 0) {
    const p = new THREE.Mesh(geo.posterSmall, posterMats[Math.floor(rng() * posterMats.length)]);
    const side = rng() > 0.5 ? 4.7 : -4.7;
    p.position.set(cx + side, 2 + rng() * 2.5, cz + (rng() - 0.5) * 4);
    p.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    group.add(p);
  }

  // Generative art poster on floor/wall
  if (rng() > 0.7) {
    const artMat = generateArtMaterial(seed ^ 0xBEEF);
    const art = new THREE.Mesh(geo.posterSmall, artMat);
    art.position.set(cx + (rng() - 0.5) * 6, 1.5 + rng() * 2, cz + (rng() - 0.5) * 6);
    art.rotation.y = rng() * Math.PI;
    group.add(art);
  }

  // Procedural portal to outside (only in indoor mode)
  if (config.worldMode === 'indoor' && rng() > 0.85) {
    const doorFrame = new THREE.Mesh(geo.doorway, mat.metal);
    doorFrame.position.set(cx, 2.5, cz + 4.5);
    group.add(doorFrame);

    const doorPane = new THREE.Mesh(geo.doorway, mat.door);
    doorPane.position.set(cx, 2.5, cz + 4.4);
    doorPane.userData = { type: 'portal', targetMode: 'outdoor' };
    interactables.push(doorPane);
    group.add(doorPane);

    const sign = makeTextSprite('SAÍDA PARA A RUA', 0.45, '#ff0000', 'Courier New');
    sign.position.set(cx, 5.5, cz + 4.5);
    group.add(sign);
  }
}


/* ═══════════════ CELL: VOID ═══════════════ */
function buildVoidCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  const fl = new THREE.Mesh(geo.floor, mat.black);
  fl.rotation.x = -Math.PI / 2;
  fl.position.set(cx, 0.02, cz);
  group.add(fl);

  // Almost no light
  if (rng() > 0.7) {
    lights.push({
      type: 'point',
      color: 0xffffff,
      intensity: 0.08,
      distance: 8,
      position: new THREE.Vector3(cx, WALL_HEIGHT - 1, cz),
      flicker: false,
      seed: seed
    });
  }

  // Occasionally: a single generative artwork floating in darkness
  if (rng() > 0.5) {
    const artMat = generateArtMaterial(seed ^ 0xDEAD);
    const art = new THREE.Mesh(geo.poster, artMat);
    art.position.set(cx, 2 + rng() * 2, cz);
    art.rotation.y = rng() * Math.PI;
    art.userData = {
      type: 'painting',
      id: String(seed & 0xFFFF).padStart(5, '0'),
      title: 'OBRA ENCONTRADA NO VAZIO',
      meta: 'Origem desconhecida — Seed ' + seed,
      texName: null,
      desc: 'MEMORIAL TÉCNICO: Fragmento estético flutuante encontrado em zona de silêncio (void). Obra gerada algoritmicamente via renderizador procedimental baseada na seed ' + seed + '.',
    };
    interactables.push(art);
    group.add(art);

    // Single dramatic spot definition
    lights.push({
      type: 'spot',
      color: 0xffffff,
      intensity: 0.8,
      distance: 10,
      angle: Math.PI / 6,
      penumbra: 0.6,
      position: new THREE.Vector3(cx, WALL_HEIGHT - 0.5, cz),
      targetPos: new THREE.Vector3(cx, 2, cz)
    });
  }
}

/* ═══════════════ CELL: SECRET ═══════════════ */
function buildSecretCell(group, cx, cz, rng, seed, colliders, interactables, lights) {
  const fl = new THREE.Mesh(geo.floor, mat.black);
  fl.rotation.x = -Math.PI / 2;
  fl.position.set(cx, 0.02, cz);
  group.add(fl);

  // Red spot definition
  lights.push({
    type: 'spot',
    color: 0xff0000,
    intensity: 1.5,
    distance: 15,
    angle: Math.PI / 4,
    penumbra: 0.5,
    position: new THREE.Vector3(cx, WALL_HEIGHT - 1, cz),
    targetPos: new THREE.Vector3(cx, 0, cz)
  });

  // Giant face
  if (posterMats.length > 0) {
    const face = new THREE.Mesh(geo.posterBig, posterMats[0]);
    face.position.set(cx, WALL_HEIGHT * 0.55, cz + 4.7);
    face.rotation.y = Math.PI;
    group.add(face);
  }

  // Question trigger
  const trigger = new THREE.Mesh(
    new THREE.BoxGeometry(2, 2, 2),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  trigger.position.set(cx, 2, cz);
  trigger.userData = { type: 'question' };
  interactables.push(trigger);
  group.add(trigger);

  // Elevator button (teleport)
  const panel = new THREE.Mesh(geo.elevPanel, mat.metal);
  panel.position.set(cx - 4.5, 3, cz);
  panel.userData = { type: 'elevator' };
  interactables.push(panel);
  group.add(panel);
  const btn = new THREE.Mesh(geo.elevBtn, mat.elevButton);
  btn.position.set(cx - 4.55, 3, cz);
  group.add(btn);
}

/* ═══════════════════════════════════════════
   CHUNK UNLOADING
   ═══════════════════════════════════════════ */
function unloadChunk(key) {
  const data = chunks.get(key);
  if (!data) return;

  // Remove from scene
  scene.remove(data.group);

  // Dispose non-shared geometries (dust particles)
  if (data.dustGeo) data.dustGeo.dispose();

  // Traverse and dispose any per-chunk materials (generated art is cached separately)
  data.group.traverse(child => {
    if (child.isMesh) {
      // Only dispose geometry if it's not from our shared pool
      if (!Object.values(geo).includes(child.geometry)) {
        child.geometry.dispose();
      }
      // Only dispose material if it's not from our shared pools
      if (child.material && !Object.values(mat).includes(child.material)
        && !posterMats.includes(child.material)
        && !generatedArtCache.has(child.material)) {
        if (child.material.map && !child.material.map._shared) child.material.map.dispose();
        child.material.dispose();
      }
    }
    if (child.isPoints) {
      child.material.dispose();
    }
  });

  chunks.delete(key);
}

/* ═══════════════════════════════════════════
   CHUNK MANAGEMENT (load/unload around player)
   ═══════════════════════════════════════════ */
function updateChunks() {
  if (config.worldMode === 'outdoor' && state.blenderSceneActive) {
    return;
  }

  const px = Math.floor(camera.position.x / CHUNK_SIZE);
  const pz = Math.floor(camera.position.z / CHUNK_SIZE);

  if (px === state.playerChunkX && pz === state.playerChunkZ) return;
  state.playerChunkX = px;
  state.playerChunkZ = pz;

  // Load nearby chunks
  for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
    for (let dz = -LOAD_RADIUS; dz <= LOAD_RADIUS; dz++) {
      generateChunk(px + dx, pz + dz);
    }
  }

  // Unload distant chunks
  for (const [key] of chunks) {
    const [cx, cz] = key.split(',').map(Number);
    if (Math.abs(cx - px) > UNLOAD_RADIUS || Math.abs(cz - pz) > UNLOAD_RADIUS) {
      unloadChunk(key);
    }
  }
}

/* ═══════════════════════════════════════════
   COLLISION — check against active chunks only
   ═══════════════════════════════════════════ */
function checkCollision(pos) {
  const playerBox = new THREE.Box3(
    new THREE.Vector3(pos.x - PLAYER_RADIUS, pos.y - PLAYER_HEIGHT, pos.z - PLAYER_RADIUS),
    new THREE.Vector3(pos.x + PLAYER_RADIUS, pos.y + 0.5, pos.z + PLAYER_RADIUS),
  );

  // If Blender outside world is loaded, check against it
  if (config.worldMode === 'outdoor' && state.blenderSceneActive) {
    for (const box of blenderColliders) {
      if (playerBox.intersectsBox(box)) return true;
    }
    return false;
  }

  // Only check chunks near player (procedural fallback)
  const px = Math.floor(pos.x / CHUNK_SIZE);
  const pz = Math.floor(pos.z / CHUNK_SIZE);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const data = chunks.get(`${px + dx},${pz + dz}`);
      if (!data) continue;
      for (const box of data.colliders) {
        if (playerBox.intersectsBox(box)) return true;
      }
    }
  }
  return false;
}

/* ═══════════════════════════════════════════
   INTERACTION RAYCASTING — active chunks only
   ═══════════════════════════════════════════ */
function getInteractables() {
  if (config.worldMode === 'outdoor' && state.blenderSceneActive) {
    return blenderInteractables;
  }

  const px = Math.floor(camera.position.x / CHUNK_SIZE);
  const pz = Math.floor(camera.position.z / CHUNK_SIZE);
  const result = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      const data = chunks.get(`${px + dx},${pz + dz}`);
      if (data) result.push(...data.interactables);
    }
  }
  return result;
}

/* ═══════════════════════════════════════════
   ZONE DETECTION (procedural)
   ═══════════════════════════════════════════ */
function detectZone() {
  const px = Math.floor(camera.position.x / CHUNK_SIZE);
  const pz = Math.floor(camera.position.z / CHUNK_SIZE);
  const cx = Math.floor((camera.position.x % CHUNK_SIZE + CHUNK_SIZE) % CHUNK_SIZE / CELL_SIZE);
  const cz = Math.floor((camera.position.z % CHUNK_SIZE + CHUNK_SIZE) % CHUNK_SIZE / CELL_SIZE);
  const key = `${px},${pz}`;
  const data = chunks.get(key);
  if (!data) return 'TERRITÓRIO JOHN MELO';

  // We need to recover the room type from the seed
  const seed = chunkSeed(px, pz);
  const rng = mulberry32(seed);
  // Replay the grid generation to find the cell type
  const totalWeight = 100; // approximate
  const weights = { street:25, backroom:20, gallery:10, cinema:5, archive:8, crt:5, cassette:5, zine:6, corridor:10, void:4, secret:2 };
  const wTotal = Object.values(weights).reduce((a,b) => a+b, 0);

  // Skip wall decisions
  for (let r = 0; r < CELLS_PER_CHUNK; r++) {
    for (let c = 0; c < CELLS_PER_CHUNK; c++) {
      rng(); rng(); // wallEast, wallSouth
    }
  }
  // Replay room assignments
  let cellRoom = 'corridor';
  for (let r = 0; r < CELLS_PER_CHUNK; r++) {
    for (let c = 0; c < CELLS_PER_CHUNK; c++) {
      let rv = rng() * wTotal;
      let room = 'corridor';
      for (const [type, w] of Object.entries(weights)) {
        rv -= w;
        if (rv <= 0) { room = type; break; }
      }
      if (r === cz && c === cx) cellRoom = room;
    }
  }

  const names = {
    street: 'RUA — SETOR ' + ((Math.abs(px * 7 + pz * 13)) % 99 + 1).toString().padStart(2,'0'),
    backroom: 'BACKROOMS — CORREDOR ' + ((Math.abs(px * 3 + pz * 11)) % 50 + 1),
    gallery: 'GALERIA — SALA ' + ((Math.abs(px + pz * 5)) % 30 + 1),
    cinema: 'CINEMA — PROJEÇÃO',
    archive: 'ARQUIVO — REGISTROS',
    crt: 'LAN HOUSE — TERMINAL',
    cassette: 'SALA DE MÚSICA — TOCA-FITAS',
    zine: 'BIBLIOTECA — ZINES',
    corridor: 'CORREDOR — ' + ((Math.abs(px * 11 + pz)) % 100),
    void: '???',
    secret: '??? — SALA SECRETA',
  };
  return names[cellRoom] || 'TERRITÓRIO JOHN MELO';
}

/* ═══════════════════════════════════════════
   THREE.JS SETUP
   ═══════════════════════════════════════════ */
function initThree() {
  scene = new THREE.Scene();
  const initColor = config.worldMode === 'outdoor' ? config.fogColorOutdoor : config.fogColorIndoor;
  const initDensity = config.worldMode === 'outdoor' ? config.fogDensityOutdoor : config.fogDensityIndoor;
  scene.background = new THREE.Color(initColor);
  scene.fog = new THREE.Fog(initColor, 10, 100);
  Object.defineProperty(scene.fog, 'density', {
    get: function() { return this._density || 0.015; },
    set: function(val) {
      if (val <= 0.0001) val = 0.0001;
      this._density = val;
      this.far = Math.min(2.0 / val, 500);
      this.near = this.far * 0.1;
    }
  });
  scene.fog.density = initDensity;

  camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 600);
  camera.position.set(CHUNK_SIZE / 2, PLAYER_HEIGHT, CHUNK_SIZE / 2);

  renderer = new THREE.WebGLRenderer({
    canvas: dom.canvas,
    antialias: false,
    powerPreference: isTouchDevice ? 'low-power' : 'high-performance',
    precision: isTouchDevice ? 'mediump' : 'highp',
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(isTouchDevice ? 0.5 : Math.min(window.devicePixelRatio, 1.5));
  renderer.shadowMap.enabled = false; // disable for performance with many lights
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  controls = new PointerLockControls(camera, document.body);

  // Initialize PointLight pool
  for (let i = 0; i < MAX_POI_LIGHTS; i++) {
    const pl = new THREE.PointLight(0xffffff, 0, 10);
    scene.add(pl);
    pointLightPool.push(pl);
  }

  // Initialize SpotLight pool
  for (let i = 0; i < MAX_SPOT_LIGHTS; i++) {
    const sl = new THREE.SpotLight(0xffffff, 0, 10);
    const targetObj = new THREE.Object3D();
    scene.add(targetObj);
    sl.target = targetObj;
    scene.add(sl);
    spotLightPool.push(sl);
  }

  // Global low ambient light for general visibility
  const ambientLight = new THREE.AmbientLight(0xffffff);
  ambientLight.intensity = config.ambientLightIntensity;
  scene.add(ambientLight);

  // skyLight represents reflection from sky dome
  skyLight = new THREE.HemisphereLight(0xdddddd, 0x222222, 2.0);
  scene.add(skyLight);

  // sunLight represents sunlight/moonlight directional shadows
  sunLight = new THREE.DirectionalLight(0xfffbee, 3.5);
  sunLight.position.set(50, 150, 30);
  scene.add(sunLight);


  // Flashlight attached to camera for immersive direction lighting
  const flashlight = new THREE.SpotLight(0xffffff, config.flashlightIntensity, 32, Math.PI / 4.5, 0.6, 1.25);
  flashlight.name = 'flashlight';
  flashlight.position.set(0, 0, 0);

  const flashlightTarget = new THREE.Object3D();
  flashlightTarget.position.set(0, 0, -1);
  camera.add(flashlightTarget);
  flashlight.target = flashlightTarget;

  camera.add(flashlight);
  scene.add(camera);


  initRain();

  setupPostProcessing();

  loadBlenderOutsideWorld();

  initGraffiti();

  initAudioDrone();

  initMobileControls();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (composer) composer.setSize(window.innerWidth, window.innerHeight);
  });
}

function initRain() {
  rainGeometry = new THREE.BufferGeometry();
  const positions = new Float32Array(rainCount * 3);
  
  // Distribute particles in a 120x80x120 box around camera
  for (let i = 0; i < rainCount; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 120;     // X
    positions[i * 3 + 1] = Math.random() * 80;          // Y
    positions[i * 3 + 2] = (Math.random() - 0.5) * 120; // Z
  }
  
  rainGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  
  const rainMat = new THREE.PointsMaterial({
    color: 0x8899aa,
    size: 0.12,
    transparent: true,
    opacity: 0.55,
  });
  
  rainPoints = new THREE.Points(rainGeometry, rainMat);
  scene.add(rainPoints);
}


/* ═══════════════════════════════════════════
   POST-PROCESSING (CRT + Grain + Vignette)
   ═══════════════════════════════════════════ */
function setupPostProcessing() {
  if ('ontouchstart' in window || isTouchDevice) {
    composer = null; // Disable post-processing on mobile for performance and to fix pitch black screen
    return;
  }

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const crtShader = {
    uniforms: {
      tDiffuse: { value: null },
      time: { value: 0 },
      scanlineIntensity: { value: 0.07 },
      noiseIntensity: { value: 0.05 },
      vignetteIntensity: { value: 0.4 },
      glitchIntensity: { value: 0.0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform float time;
      uniform float scanlineIntensity;
      uniform float noiseIntensity;
      uniform float vignetteIntensity;
      uniform float glitchIntensity;
      varying vec2 vUv;

      float random(vec2 st) {
        return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec2 uv = vUv;
        if (glitchIntensity > 0.0) {
          float gl = step(0.99, random(vec2(floor(uv.y * 30.0), time)));
          uv.x += gl * glitchIntensity * (random(vec2(time, uv.y)) - 0.5) * 0.15;
        }
        vec4 color = texture2D(tDiffuse, uv);
        float gray = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        color.rgb = mix(color.rgb, vec3(gray), 0.35);
        float scanline = sin(uv.y * 800.0) * 0.5 + 0.5;
        color.rgb -= scanlineIntensity * scanline;
        float noise = random(uv + time) * noiseIntensity;
        color.rgb += noise - noiseIntensity * 0.5;
        float dist = distance(uv, vec2(0.5));
        color.rgb *= 1.0 - dist * vignetteIntensity;
        if (glitchIntensity > 0.0) {
          float shift = glitchIntensity * 0.005;
          color.r = texture2D(tDiffuse, uv + vec2(shift, 0.0)).r;
          color.b = texture2D(tDiffuse, uv - vec2(shift, 0.0)).b;
        }
        gl_FragColor = color;
      }
    `,
  };

  if (composer) {
    composer.addPass(new ShaderPass(crtShader));
  }
}

/* ═══════════════════════════════════════════
   GLITCH
   ═══════════════════════════════════════════ */
function triggerGlitch(intensity = 0.5) {
  if (!composer || !composer.passes || composer.passes.length < 2) return;
  const pass = composer.passes[1];
  if (pass?.uniforms) {
    pass.uniforms.glitchIntensity.value = intensity;
    setTimeout(() => { pass.uniforms.glitchIntensity.value = 0; }, 180 + Math.random() * 250);
  }
}

/* ═══════════════════════════════════════════
   CONTROLS & INPUT
   ═══════════════════════════════════════════ */
function setupControls() {
  document.addEventListener('keydown', e => {
    if (state.editorActive) {
      if (e.code === 'KeyW' || e.code === 'ArrowUp') state.flyKeys.w = true;
      if (e.code === 'KeyS' || e.code === 'ArrowDown') state.flyKeys.s = true;
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') state.flyKeys.a = true;
      if (e.code === 'KeyD' || e.code === 'ArrowRight') state.flyKeys.d = true;
      if (e.code === 'KeyE') state.flyKeys.e = true;
      if (e.code === 'KeyQ') state.flyKeys.q = true;
      
      if (e.code === 'F2') {
        e.preventDefault();
        toggleEditorMode();
      }
      return;
    }
    if (state.overlayOpen) {
      if (e.code === 'Escape') closeOverlay(state.overlayOpen);
      return;
    }
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    state.moveForward = true; break;
      case 'KeyS': case 'ArrowDown':  state.moveBackward = true; break;
      case 'KeyA': case 'ArrowLeft':  state.moveLeft = true; break;
      case 'KeyD': case 'ArrowRight': state.moveRight = true; break;
      case 'ShiftLeft': case 'ShiftRight': state.isRunning = true; break;
      case 'Space':
        // Jump only if close to the ground
        const curGround = (config.worldMode === 'outdoor' ? getTerrainHeight(camera.position.x, camera.position.z) : 0) + PLAYER_HEIGHT;
        if (camera.position.y <= curGround + 0.15) {
          state.velocity.y = config.jumpStrength;
        }
        break;
      case 'KeyI':
        openOverlay('overlay-inventory');
        break;
      case 'KeyG':
        toggleGraffitiMode();
        break;
      case 'Digit1':
        if (state.graffitiActive) selectGraffitiBrush('face');
        break;
      case 'Digit2':
        if (state.graffitiActive) selectGraffitiBrush('red');
        break;
      case 'Digit3':
        if (state.graffitiActive) selectGraffitiBrush('black');
        break;
      case 'Digit4':
        if (state.graffitiActive) selectGraffitiBrush('white');
        break;
      case 'F2':
        e.preventDefault();
        toggleEditorMode();
        break;
      case 'Escape':
        if (state.graffitiActive) {
          toggleGraffitiMode();
        } else if (state.paused) {
          resumeGame();
        }
        break;
    }
  });

  document.addEventListener('keyup', e => {
    if (state.editorActive) {
      if (e.code === 'KeyW' || e.code === 'ArrowUp') state.flyKeys.w = false;
      if (e.code === 'KeyS' || e.code === 'ArrowDown') state.flyKeys.s = false;
      if (e.code === 'KeyA' || e.code === 'ArrowLeft') state.flyKeys.a = false;
      if (e.code === 'KeyD' || e.code === 'ArrowRight') state.flyKeys.d = false;
      if (e.code === 'KeyE') state.flyKeys.e = false;
      if (e.code === 'KeyQ') state.flyKeys.q = false;
      return;
    }
    switch (e.code) {
      case 'KeyW': case 'ArrowUp':    state.moveForward = false; break;
      case 'KeyS': case 'ArrowDown':  state.moveBackward = false; break;
      case 'KeyA': case 'ArrowLeft':  state.moveLeft = false; break;
      case 'KeyD': case 'ArrowRight': state.moveRight = false; break;
      case 'ShiftLeft': case 'ShiftRight': state.isRunning = false; break;
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (state.graffitiActive && e.button === 0) {
      isSpraying = true;
      placeGraffitiDecal();
      return;
    }
    if (controls.isLocked && state.interactTarget && e.button === 0) {
      interact(state.interactTarget);
    }
  });

  document.addEventListener('mouseup', (e) => {
    if (e.button === 0) {
      isSpraying = false;
    }
  });

  controls.addEventListener('lock', () => {
    state.paused = false;
    dom.pauseMenu.classList.add('hidden');
  });

  controls.addEventListener('unlock', () => {
    if (state.started && !state.overlayOpen && !state.editorActive) {
      state.paused = true;
      dom.pauseMenu.classList.remove('hidden');
    }
  });

  // Pause menu buttons
  document.querySelectorAll('.pause-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      switch (btn.dataset.action) {
        case 'resume': resumeGame(); break;
        case 'manifesto': openOverlay('overlay-manifesto'); break;
        case 'archive': openOverlay('overlay-archive'); break;
        case 'inventory': openOverlay('overlay-inventory'); break;
      }
    });
  });


  // Close buttons
  document.querySelectorAll('.overlay-close').forEach(btn => {
    btn.addEventListener('click', () => closeOverlay(btn.dataset.close));
  });

  // Question buttons
  document.getElementById('q-yes')?.addEventListener('click', () => closeOverlay('overlay-question'));
  document.getElementById('q-no')?.addEventListener('click', () => {
    closeOverlay('overlay-question');
    dom.fullscreenFace.classList.remove('hidden');
    setTimeout(() => dom.fullscreenFace.classList.add('hidden'), 3000);
  });
  dom.fullscreenFace?.addEventListener('click', () => dom.fullscreenFace.classList.add('hidden'));
}

function resumeGame() { controls.lock(); }

/* ═══════════════════════════════════════════
   OVERLAYS
   ═══════════════════════════════════════════ */
function openOverlay(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('hidden');
  state.overlayOpen = id;
  if (controls.isLocked) controls.unlock();
  if (id === 'overlay-cinema') {
    document.getElementById('cinema-video')?.play().catch(() => {});
  }
}

function closeOverlay(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('hidden');
  state.overlayOpen = null;
  if (id === 'overlay-cinema') document.getElementById('cinema-video')?.pause();
  setTimeout(() => controls.lock(), 100);
}

/* ═══════════════════════════════════════════
   INTERACTION
   ═══════════════════════════════════════════ */
function triggerSusto() {
  document.body.style.filter = 'invert(1) contrast(2)';
  const txt = document.getElementById('susto-text');
  if(txt) txt.style.display = 'block';

  if (humOsc1 && audioCtx) {
    humOsc1.frequency.setValueAtTime(150, audioCtx.currentTime);
  }

  setTimeout(() => {
    document.body.style.filter = 'none';
    if(txt) txt.style.display = 'none';
    if (humOsc1 && audioCtx) {
      humOsc1.frequency.setValueAtTime(60, audioCtx.currentTime);
    }
  }, 300);
}

function interact(obj) {
  triggerSusto();
  const d = obj.userData;
  if (!d?.type) return;

  switch (d.type) {
    case 'paper':
      window.stickerCount += 1;
      const stickerEl = document.getElementById('hud-sticker-count');
      if (stickerEl) stickerEl.textContent = window.stickerCount;

      state.counterValue += 1;
      document.getElementById('hud-counter').textContent = Number(state.counterValue).toLocaleString('pt-BR');
      document.getElementById('counter-value').textContent = Number(state.counterValue).toLocaleString('pt-BR');
      saveIPBankScore();
      
      // Remove from scene (Collectable)
      if (obj.parent) {
        obj.parent.remove(obj);
      }
      
      // Remove from interactables list
      const cx = Math.floor(camera.position.x / CHUNK_SIZE);
      const cz = Math.floor(camera.position.z / CHUNK_SIZE);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const cData = chunks.get(`${cx+dx},${cz+dz}`);
          if (cData) {
            const idx = cData.interactables.indexOf(obj);
            if (idx !== -1) cData.interactables.splice(idx, 1);
          }
        }
      }
      
      if (state.blenderSceneActive) {
        const bIdx = blenderInteractables.indexOf(obj);
        if (bIdx !== -1) blenderInteractables.splice(bIdx, 1);
      }
      break;
    case 'painting':
      document.getElementById('painting-id').textContent = d.id;
      document.getElementById('painting-title').textContent = d.title;
      document.getElementById('painting-meta').textContent = d.meta;
      document.getElementById('painting-desc').textContent = d.desc || 'MEMORIAL TÉCNICO: Sem especificações adicionais.';
      
      const pimg = document.getElementById('painting-img');
      if (obj.material && obj.material.userData && obj.material.userData.canvasDataUrl) {
        pimg.src = obj.material.userData.canvasDataUrl;
      } else if (d.texName) {
        pimg.src = `./assets/${getTexSrc(d.texName)}`;
      } else {
        pimg.src = './assets/face.png';
      }
      openOverlay('overlay-painting');
      break;
    case 'cinema': openOverlay('overlay-cinema'); break;
    case 'cassette': openOverlay('overlay-cassette'); break;
    case 'archive': openOverlay('overlay-archive'); break;
    case 'crt': openOverlay('overlay-crt'); break;
    case 'zine':
      currentZinePage = 0;
      updateZinePage();
      openOverlay('overlay-zine');
      break;
    case 'elevator':
      // Teleport to random distant chunk
      const angle = Math.random() * Math.PI * 2;
      const dist = 80 + Math.random() * 200;
      camera.position.x += Math.cos(angle) * dist;
      camera.position.z += Math.sin(angle) * dist;
      const elevatorGround = (config.worldMode === 'outdoor' ? getTerrainHeight(camera.position.x, camera.position.z) : 0) + PLAYER_HEIGHT;
      camera.position.y = elevatorGround;
      state.playerChunkX = Infinity; // force chunk reload
      triggerGlitch(1.0);
      break;
    case 'portal_blender':
      enterIndoorMode(d.roomType);
      break;
    case 'portal':
      const targetMode = d.targetMode;
      if (targetMode === 'outdoor' && state.blenderSceneActive) {
        enterOutdoorBlenderWorld();
        break;
      }

      triggerGlitch(1.0);
      config.worldMode = targetMode;
      
      const targetColor = targetMode === 'outdoor' ? config.fogColorOutdoor : config.fogColorIndoor;
      const targetDensity = targetMode === 'outdoor' ? config.fogDensityOutdoor : config.fogDensityIndoor;
      scene.background.setHex(targetColor);
      scene.fog.color.setHex(targetColor);
      scene.fog.density = targetDensity;

      // Update UI button if open
      const toggleBtn = document.getElementById('btn-toggle-world');
      if (toggleBtn) {
        toggleBtn.textContent = config.worldMode === 'indoor' ? 'MUDAR PARA OUTDOOR (RUA/PRAÇA)' : 'MUDAR PARA INDOOR (PRÉDIO/BACKROOM)';
      }

      // Teleport forward to clear door
      camera.position.x += 12;
      camera.position.z += 12;
      const portalGround = (config.worldMode === 'outdoor' ? getTerrainHeight(camera.position.x, camera.position.z) : 0) + PLAYER_HEIGHT;
      camera.position.y = portalGround;
      state.playerChunkX = Infinity; // force chunk rebuild

      // Unload active chunks to rebuild
      for (const [key] of chunks) {
        unloadChunk(key);
      }
      updateChunks();
      break;
    case 'question': openOverlay('overlay-question'); break;
  }
}

function getTexSrc(name) {
  return { face: 'face.png', poster: 'poster.png', city: 'city.png', posterRed: 'poster_red.png' }[name] || 'face.png';
}

/* ═══════════════════════════════════════════
   ZINE NAVIGATION
   ═══════════════════════════════════════════ */
let currentZinePage = 0;
const totalZinePages = 4;

function updateZinePage() {
  for (let i = 1; i <= totalZinePages; i++) {
    document.getElementById(`zine-page-${i}`)?.classList.toggle('active', i === currentZinePage + 1);
  }
  document.getElementById('zine-page-indicator').textContent = `${currentZinePage + 1} / ${totalZinePages}`;
}
document.getElementById('zine-prev')?.addEventListener('click', () => { if (currentZinePage > 0) { currentZinePage--; updateZinePage(); } });
document.getElementById('zine-next')?.addEventListener('click', () => { if (currentZinePage < totalZinePages - 1) { currentZinePage++; updateZinePage(); } });

/* ═══════════════════════════════════════════
   CASSETTE PLAYER — SOUNDCLOUD WIDGET API
   ═══════════════════════════════════════════ */
let scWidget = null;
let scIsPlaying = false;

function initSoundCloudWidget() {
  const iframe = document.getElementById('sc-widget');
  if (!iframe || typeof SC === 'undefined') return;
  
  scWidget = SC.Widget(iframe);
  
  scWidget.bind(SC.Widget.Events.READY, () => {
    // Update track name when a new track loads
    scWidget.bind(SC.Widget.Events.PLAY, () => {
      scIsPlaying = true;
      const btn = document.getElementById('tape-play');
      if (btn) { btn.textContent = '⏸'; btn.classList.add('active'); }
      document.getElementById('tape-reel-l')?.classList.add('spinning');
      document.getElementById('tape-reel-r')?.classList.add('spinning');

      scWidget.getCurrentSound((sound) => {
        const nameEl = document.getElementById('tape-track-name');
        if (nameEl && sound) nameEl.textContent = sound.title.toUpperCase();
      });
    });

    scWidget.bind(SC.Widget.Events.PAUSE, () => {
      scIsPlaying = false;
      const btn = document.getElementById('tape-play');
      if (btn) { btn.textContent = '▶'; btn.classList.remove('active'); }
      document.getElementById('tape-reel-l')?.classList.remove('spinning');
      document.getElementById('tape-reel-r')?.classList.remove('spinning');
    });

    scWidget.bind(SC.Widget.Events.FINISH, () => {
      scWidget.next();
    });
  });
}

// Initialize after page load
if (document.readyState === 'complete') {
  initSoundCloudWidget();
} else {
  window.addEventListener('load', initSoundCloudWidget);
}

document.getElementById('tape-play')?.addEventListener('click', function () {
  if (!scWidget) initSoundCloudWidget();
  if (!scWidget) return;
  
  scWidget.isPaused((paused) => {
    if (paused) {
      scWidget.play();
    } else {
      scWidget.pause();
    }
  });
});

document.getElementById('tape-prev')?.addEventListener('click', () => {
  if (scWidget) scWidget.prev();
});

document.getElementById('tape-next')?.addEventListener('click', () => {
  if (scWidget) scWidget.next();
});

/* ═══════════════════════════════════════════
   GAME LOOP
   ═══════════════════════════════════════════ */
function gameLoop() {
  requestAnimationFrame(gameLoop);

  if (!state.started || state.paused || state.overlayOpen) {
    if (state.started) {
      if (composer) composer.render();
      else renderer.render(scene, camera);
    }
    return;
  }

  const delta = Math.min(clock.getDelta(), 0.1);
  const time = clock.getElapsedTime();

  // Update CRT shader
  if (composer && composer.passes && composer.passes.length > 1) {
    const pass = composer.passes[1];
    if (pass?.uniforms) pass.uniforms.time.value = time;
  }

  // Update Blender animations
  if (blenderMixer) blenderMixer.update(delta);

  // Animate water normal maps
  if (mat.ocean && mat.ocean.normalMap) {
    mat.ocean.normalMap.offset.x = (time * 0.012) % 1.0;
    mat.ocean.normalMap.offset.y = (time * 0.009) % 1.0;
  }

  // ── UPDATE GRAFFITI SYSTEM ──
  if (state.graffitiActive) {
    updateGraffitiPreview();
    if (isSpraying && state.graffitiBrush !== 'face') {
      const now = performance.now();
      if (now - lastSprayTime > 50) {
        lastSprayTime = now;
        placeGraffitiDecal();
      }
    }
  }

  // ── UPDATE DAY-NIGHT CYCLE ──
  if (config.autoTimeCycle) {
    // 1 hour every 4 seconds (24 hours = 96 seconds cycle loop)
    config.dayNightTime = (config.dayNightTime + delta * 0.25) % 24;
    
    // Sync UI slider if open
    const timeSlider = document.getElementById('slider-time');
    const timeVal = document.getElementById('val-time');
    if (timeSlider && timeVal) {
      timeSlider.value = config.dayNightTime;
      timeVal.textContent = config.dayNightTime.toFixed(1);
    }
  }

  // Calculate sun angle
  // 12.0 is noon, 0.0 is midnight.
  const timeRad = ((config.dayNightTime - 6.0) / 12.0) * Math.PI;
  const sunElevation = Math.sin(timeRad); // >0 is day, <=0 is night

  let targetBgColor, sunIntensity, skyIntensity;
  
  if (config.worldMode === 'indoor') {
    // Indoor is always dark backrooms/corridors
    targetBgColor = new THREE.Color(0x050505);
    sunIntensity = 0;
    skyIntensity = 0.05;
  } else {
    // Outdoor day/night cycle
    if (sunElevation > 0) {
      // Stark daytime sky (grayish-white)
      const dayFactor = sunElevation; // 0 to 1
      const startColor = new THREE.Color(0x050505);
      const endColor = new THREE.Color(0xcccccc); // stark gray
      targetBgColor = startColor.clone().lerp(endColor, dayFactor);
      
      sunIntensity = dayFactor * 2.0;
      skyIntensity = 0.1 + dayFactor * 1.2;
    } else {
      // Nighttime sky (moonlit dark blue-gray void)
      const nightFactor = Math.abs(sunElevation); // 0 to 1
      const startColor = new THREE.Color(0x050505);
      const endColor = new THREE.Color(0x0a0c16); // cool moonlit dark slate
      targetBgColor = startColor.clone().lerp(endColor, nightFactor);
      
      sunIntensity = nightFactor * 0.9; // globally lit by moon
      skyIntensity = 0.05 + nightFactor * 0.35; // ambient moonlit glow
    }
  }

  // Set colors & intensities
  scene.background = targetBgColor;
  if (scene.fog) scene.fog.color = targetBgColor;

  if (skyLight) {
    skyLight.color.copy(targetBgColor);
    skyLight.groundColor.setHex(0x1a1a1a);
    skyLight.intensity = skyIntensity;
  }

  if (sunLight) {
    const sunAngle = timeRad;
    sunLight.position.set(Math.cos(sunAngle) * 200, Math.max(0.1, sunElevation) * 200, Math.sin(sunAngle) * 50);
    sunLight.intensity = sunIntensity;
    if (sunElevation > 0) {
      sunLight.color.setHex(0xfffbee); // warm daylight
    } else {
      sunLight.color.setHex(0x99bbff); // cool moonlight
    }
  }

  // Flashlight adjust based on sun exposure
  camera.traverse(child => {
    if (child.isSpotLight && child.name === 'flashlight') {
      const dayIntensityFactor = sunElevation > 0 ? (1.0 - sunElevation * 0.85) : 1.0;
      child.intensity = config.flashlightIntensity * dayIntensityFactor;
    }
  });


  // ── UPDATE POOLED LIGHTS ──
  const activeLights = [];
  const activeSpots = [];
  const playerPos = camera.position;

  for (const [key, data] of chunks) {
    if (data.lights) {
      for (const def of data.lights) {
        const distSq = playerPos.distanceToSquared(def.position);
        if (def.type === 'point') {
          activeLights.push({ def, distSq });
        } else if (def.type === 'spot') {
          activeSpots.push({ def, distSq });
        }
      }
    }
  }

  // Sort by proximity
  activeLights.sort((a, b) => a.distSq - b.distSq);
  activeSpots.sort((a, b) => a.distSq - b.distSq);

  // Update PointLights
  for (let i = 0; i < MAX_POI_LIGHTS; i++) {
    const pl = pointLightPool[i];
    if (i < activeLights.length) {
      const { def } = activeLights[i];
      pl.position.copy(def.position);
      pl.color.setHex(def.color);
      pl.distance = def.distance;
      
      let intensity = def.intensity;
      if (def.flicker) {
        const flickerVal = Math.sin(time * 25 + def.seed) * Math.cos(time * 11 + def.seed);
        if (flickerVal > 0.3) {
          intensity *= 0.15;
        }
      }
      pl.intensity = intensity * 120.0; // Scale up for physically correct units
    } else {
      pl.intensity = 0;
    }
  }

  // Update SpotLights
  for (let i = 0; i < MAX_SPOT_LIGHTS; i++) {
    const sl = spotLightPool[i];
    if (i < activeSpots.length) {
      const { def } = activeSpots[i];
      sl.position.copy(def.position);
      sl.color.setHex(def.color);
      sl.distance = def.distance;
      sl.angle = def.angle;
      sl.penumbra = def.penumbra;
      sl.target.position.copy(def.targetPos);
      sl.intensity = def.intensity * 200.0; // Scale up for physically correct units
    } else {
      sl.intensity = 0;
    }
  }

  // ── CHUNK MANAGEMENT ──
  state.lastChunkCheck += delta;
  if (state.lastChunkCheck > CHUNK_CHECK_INTERVAL) {
    state.lastChunkCheck = 0;
    updateChunks();
  }
  
  // --- Sticker Pickups Logic ---
  const now = Date.now();
  if (now - lastStickerSpawn > 10000 && stickerPickups.length < 15) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 10 + Math.random() * 30; // Spawn near player
    const px = camera.position.x + Math.cos(angle) * dist;
    const pz = camera.position.z + Math.sin(angle) * dist;
    const py = config.worldMode === 'outdoor' ? getTerrainHeight(px, pz) : 0;
    
    if (mat.facePaper) {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1.4), mat.facePaper);
      mesh.material.side = THREE.DoubleSide; 
      mesh.position.set(px, py + 1.5, pz);
      mesh.userData = { baseY: py + 1.5 };
      scene.add(mesh);
      stickerPickups.push(mesh);
    }
    lastStickerSpawn = now;
  }
  
  for (let i = stickerPickups.length - 1; i >= 0; i--) {
    const pickup = stickerPickups[i];
    pickup.rotation.y += 0.02;
    pickup.position.y = pickup.userData.baseY + Math.sin(now * 0.005) * 0.2;
    
    // Calculate horizontal distance (ignore Y axis difference)
    const dx = camera.position.x - pickup.position.x;
    const dz = camera.position.z - pickup.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    
    if (dist < 3.0) {
      window.stickerCount += 5; // User requested 5 per floating face
      const stickerEl = document.getElementById('hud-sticker-count');
      if (stickerEl) stickerEl.innerText = window.stickerCount;
      scene.remove(pickup);
      stickerPickups.splice(i, 1);
    }
  }
  // -----------------------------

  // ── CREATOR STUDIO FLY MOVEMENT ──
  if (state.editorActive) {
    const moveDir = new THREE.Vector3();
    if (state.flyKeys.w) moveDir.z -= 1;
    if (state.flyKeys.s) moveDir.z += 1;
    if (state.flyKeys.a) moveDir.x -= 1;
    if (state.flyKeys.d) moveDir.x += 1;
    if (state.flyKeys.e) moveDir.y += 1;
    if (state.flyKeys.q) moveDir.y -= 1;
    
    moveDir.normalize();
    
    const tempCamDir = new THREE.Vector3();
    camera.getWorldDirection(tempCamDir);
    
    const tempCamRight = new THREE.Vector3();
    tempCamRight.crossVectors(tempCamDir, camera.up).normalize();
    
    const translation = new THREE.Vector3();
    translation.addScaledVector(tempCamDir, -moveDir.z); // forward
    translation.addScaledVector(tempCamRight, moveDir.x); // strafe
    translation.y += moveDir.y; // up/down
    
    if (translation.lengthSq() > 0) {
      translation.normalize().multiplyScalar(state.flySpeed * delta);
      camera.position.add(translation);
    }
    
    if (selectionBoxHelper) selectionBoxHelper.update();
  }

  // ── MOVEMENT ──
  const canMove = controls.isLocked || isTouchDevice;

  const nowTime = Date.now();
  if (nowTime - lastFirebaseUpdate > 100) {
    updateLocalPlayer(camera.position.x, camera.position.y - PLAYER_HEIGHT, camera.position.z, camera.rotation.y, state.counterValue);
    lastFirebaseUpdate = nowTime;
  }
  if (canMove) {
    state.velocity.x -= state.velocity.x * 10 * delta;
    state.velocity.z -= state.velocity.z * 10 * delta;
    state.direction.z = Number(state.moveForward) - Number(state.moveBackward);
    state.direction.x = Number(state.moveRight) - Number(state.moveLeft);
    state.direction.normalize();

    let currentSpeed = state.isRunning ? config.runSpeed : config.moveSpeed;
    const isSwimming = config.worldMode === 'outdoor' && camera.position.y < 2.0 + PLAYER_HEIGHT - 1.0;
    if (isSwimming) {
      currentSpeed *= 0.35; // slow down in water
    }
    if (state.moveForward || state.moveBackward) state.velocity.z -= state.direction.z * currentSpeed * delta;
    if (state.moveLeft || state.moveRight) state.velocity.x -= state.direction.x * currentSpeed * delta;

    const oldPos = camera.position.clone();
    controls.moveRight(-state.velocity.x * delta);
    if (checkCollision(camera.position)) camera.position.x = oldPos.x;
    controls.moveForward(-state.velocity.z * delta);
    if (checkCollision(camera.position)) camera.position.z = oldPos.z;

    // Apply gravity and jumping physics
    const oldGroundLevel = (config.worldMode === 'outdoor' ? getTerrainHeight(oldPos.x, oldPos.z) : 0) + PLAYER_HEIGHT;
    const groundLevel = (config.worldMode === 'outdoor' ? getTerrainHeight(camera.position.x, camera.position.z) : 0) + PLAYER_HEIGHT;
    
    if (isSwimming) {
      // Float Y position (clamp) to prevent mergulho!
      camera.position.y = 2.0 + PLAYER_HEIGHT - 1.2;
      state.velocity.y = 0;
      
      // Circular swimming camera bobbing
      camera.position.y += Math.sin(time * 3.0) * 0.12;
      camera.rotation.z += Math.sin(time * 1.5) * 0.03;
    } else {
      // Normal gravity/falling
      const wasOnGround = Math.abs(oldPos.y - oldGroundLevel) < 0.15;
      
      if (camera.position.y > groundLevel) {
        if (wasOnGround && (oldGroundLevel - groundLevel) < 4.0) {
          camera.position.y = groundLevel;
          state.velocity.y = 0;
        } else {
          state.velocity.y -= config.gravity * delta;
        }
      }
      camera.position.y += state.velocity.y * delta;
      if (camera.position.y < groundLevel) {
        // Apply landing shake
        if (state.velocity.y < -5.0) {
          triggerLandingShake(Math.min(0.3, Math.abs(state.velocity.y) * 0.015));
        }
        camera.position.y = groundLevel;
        state.velocity.y = 0;
      }
    }

    // Head bob (only active when walking/running on ground)
    if ((state.moveForward || state.moveBackward || state.moveLeft || state.moveRight) && camera.position.y <= groundLevel + 0.05) {
      state.footstepPhase += delta * (state.isRunning ? 12 : 8);
      camera.position.y += Math.sin(state.footstepPhase) * 0.06;
    }


    // ── INTERACTION RAYCAST ──
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    const targets = getInteractables();
    const hits = raycaster.intersectObjects(targets, false);
    if (hits.length > 0 && hits[0].distance < INTERACT_DISTANCE) {
      state.interactTarget = hits[0].object;
      dom.hudInteract.classList.remove('hidden');
    } else {
      state.interactTarget = null;
      dom.hudInteract.classList.add('hidden');
    }

    // ── ZONE LABEL ──
    if (state.lastChunkCheck === 0) { // only when chunk-check runs
      const zone = detectZone();
      if (zone !== state.locationName) {
        state.locationName = zone;
        dom.hudLocation.textContent = zone;
      }
    }

    // ── RANDOM GLITCH ──
    state.glitchTimer += delta;
    if (state.glitchTimer > state.glitchCooldown) {
      state.glitchTimer = 0;
      state.glitchCooldown = 12 + Math.random() * 40;
      triggerGlitch(0.3 + Math.random() * 0.7);
    }

    // ── COUNTER ──
    if (Math.random() < 0.002) {
      state.counterValue += Math.floor(Math.random() * 5) + 1;
      dom.hudCounter.textContent = state.counterValue.toLocaleString('pt-BR');
    }
    // ── UPDATE RAIN WEATHER CYCLE ──
    rainCycleTimer += delta;
    if (rainCycleTimer > 15.0) { // Toggle every 15 seconds
      isRaining = !isRaining;
      rainCycleTimer = 0;
    }

    if (config.worldMode === 'outdoor' && rainPoints && isRaining) {
      rainPoints.visible = true;
      rainPoints.position.set(camera.position.x, 0, camera.position.z);
      
      const pos = rainGeometry.attributes.position.array;
      for (let i = 0; i < rainCount; i++) {
        pos[i * 3 + 1] -= delta * 48; // speed
        if (pos[i * 3 + 1] < 0) {
          pos[i * 3 + 1] = 75 + Math.random() * 5;
          pos[i * 3] = (Math.random() - 0.5) * 120;
          pos[i * 3 + 2] = (Math.random() - 0.5) * 120;
        }
      }
      rainGeometry.attributes.position.needsUpdate = true;
    } else if (rainPoints) {
      rainPoints.visible = false;
    }

    // ── UPDATE SILHOUETTE NPCs ──
    for (const [key, data] of chunks) {
      if (data.npcs) {
        for (const npc of data.npcs) {
          const ud = npc.userData;
          // Look at player (billboard sprite effect)
          npc.lookAt(camera.position.x, npc.position.y, camera.position.z);

          if (ud.behavior === 'pacing') {
            const offset = Math.sin(time * 0.5 * ud.speed + ud.phase) * ud.range;
            npc.position.x = ud.startX + ud.dir.x * offset;
            npc.position.z = ud.startZ + ud.dir.z * offset;
          } else {
            // Idle breathing animation
            npc.scale.y = 1.0 + Math.sin(time * 2.2 + ud.phase) * 0.02;
          }
        }
      }
    }

    // ── PROCEDURAL AUDIO MODE UPDATE ──
    updateAudioMode();

    // Apply camera landing shake decay
    if (Math.abs(landingShakeOffsetY) > 0.001) {
      camera.position.y += landingShakeOffsetY;
      landingShakeOffsetY *= 0.82; // decay rapidly
    }
  }

  if (composer) composer.render();
  else renderer.render(scene, camera);
}

/* ═══════════════════════════════════════════
   LANDING SETUP
   ═══════════════════════════════════════════ */
function setupLanding() {
  for (let i = 0; i < 25; i++) {
    const s = document.createElement('img');
    s.src = './assets/face.png';
    s.className = 'landing-stamp';
    s.style.width = (30 + Math.random() * 80) + 'px';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.transform = `rotate(${Math.random() * 360}deg)`;
    s.style.opacity = 0.02 + Math.random() * 0.04;
    dom.landingStamps?.appendChild(s);
  }

  // Animate counter
  let cur = 100000;
  const iv = setInterval(() => {
    cur += Math.floor(Math.random() * 500);
    if (cur >= 128442) { cur = 128442; clearInterval(iv); }
    dom.counterValue.textContent = cur.toLocaleString('pt-BR');
  }, 50);

  setInterval(() => {
    state.counterValue += Math.floor(Math.random() * 3);
    dom.counterValue.textContent = state.counterValue.toLocaleString('pt-BR');
    if (dom.hudCounter) dom.hudCounter.textContent = state.counterValue.toLocaleString('pt-BR');
  }, 5000);
}

/* ═══════════════════════════════════════════
   DEVELOPER TOOLS INTERFACE BINDING
   ═══════════════════════════════════════════ */
function setupDevTools() {
  const bindSlider = (id, valId, configKey, onUpdate) => {
    const slider = document.getElementById(id);
    const value = document.getElementById(valId);
    if (!slider || !value) return;

    slider.value = config[configKey];
    value.textContent = config[configKey];

    slider.addEventListener('input', () => {
      let val = parseFloat(slider.value);
      config[configKey] = val;
      value.textContent = val;
      onUpdate?.(val);
    });
  };

  bindSlider('slider-speed', 'val-speed', 'moveSpeed');
  bindSlider('slider-run', 'val-run', 'runSpeed');
  bindSlider('slider-jump', 'val-jump', 'jumpStrength');
  bindSlider('slider-gravity', 'val-gravity', 'gravity');

  bindSlider('slider-ambient', 'val-ambient', 'ambientLightIntensity', (val) => {
    scene.traverse(child => {
      if (child.isAmbientLight) child.intensity = val;
    });
  });

  bindSlider('slider-flash', 'val-flash', 'flashlightIntensity', (val) => {
    camera.traverse(child => {
      if (child.isSpotLight && child.name === 'flashlight') child.intensity = val;
    });
  });

  bindSlider('slider-lights', 'val-lights', 'lightIntensityScale');

  bindSlider('slider-time', 'val-time', 'dayNightTime');

  const cycleCheck = document.getElementById('check-time-cycle');
  if (cycleCheck) {
    cycleCheck.checked = config.autoTimeCycle;
    cycleCheck.addEventListener('change', () => {
      config.autoTimeCycle = cycleCheck.checked;
    });
  }

  bindSlider('slider-fog', 'val-fog', 'fogDensity', (val) => {
    if (scene.fog) scene.fog.density = val;
  });


  bindSlider('slider-scan', 'val-scan', 'scanlineIntensity', (val) => {
    const pass = composer.passes[1];
    if (pass?.uniforms) pass.uniforms.scanlineIntensity.value = val;
  });

  bindSlider('slider-noise', 'val-noise', 'noiseIntensity', (val) => {
    const pass = composer.passes[1];
    if (pass?.uniforms) pass.uniforms.noiseIntensity.value = val;
  });

  // Action buttons
  document.getElementById('btn-toggle-world')?.addEventListener('click', () => {
    const targetMode = config.worldMode === 'indoor' ? 'outdoor' : 'indoor';
    config.worldMode = targetMode;
    document.getElementById('btn-toggle-world').textContent = targetMode === 'indoor' ? 'MUDAR PARA OUTDOOR (RUA/PRAÇA)' : 'MUDAR PARA INDOOR (PRÉDIO/BACKROOM)';
    
    triggerGlitch(1.0);
    for (const [key] of chunks) {
      unloadChunk(key);
    }
    updateChunks();
  });

  document.getElementById('btn-trigger-glitch')?.addEventListener('click', () => {
    triggerGlitch(1.0);
  });

  document.getElementById('btn-teleport-home')?.addEventListener('click', () => {
    camera.position.set(CHUNK_SIZE / 2, PLAYER_HEIGHT, CHUNK_SIZE / 2);
    state.playerChunkX = Infinity;
    triggerGlitch(1.0);
    closeOverlay('overlay-dev');
  });
}

/* ═══════════════════════════════════════════
   PROCEDURAL AUDIO SYNTHESIZER (WEB AUDIO API)
   ═══════════════════════════════════════════ */
function startAmbienceAudio() {
  return; // Disabled continuous ambience per request
  if (audioCtx) return;

  const AudioContext = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContext();

  // 1. Fluorescent Hum (Indoor)
  humOsc1 = audioCtx.createOscillator();
  humOsc1.type = 'sawtooth';
  humOsc1.frequency.setValueAtTime(55, audioCtx.currentTime);

  humNode = audioCtx.createGain();
  humNode.gain.setValueAtTime(0.0, audioCtx.currentTime);

  const lfo = audioCtx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.setValueAtTime(15, audioCtx.currentTime);
  const lfoGain = audioCtx.createGain();
  lfoGain.gain.setValueAtTime(0.02, audioCtx.currentTime);

  lfo.connect(lfoGain);
  lfoGain.connect(humNode.gain);

  humOsc1.connect(humNode);
  humNode.connect(audioCtx.destination);

  humOsc1.start();
  lfo.start();

  // 2. Procedural Rain Noise (Outdoor)
  const bufferSize = audioCtx.sampleRate * 2.0; // 2 seconds loop
  const noiseBuffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = Math.random() * 2.0 - 1.0;
  }

  const noiseSource = audioCtx.createBufferSource();
  noiseSource.buffer = noiseBuffer;
  noiseSource.loop = true;

  // Filter to shape white noise into soft falling rain
  const rainFilter = audioCtx.createBiquadFilter();
  rainFilter.type = 'bandpass';
  rainFilter.frequency.value = 950;
  rainFilter.Q.value = 0.75;

  // Wind modulation oscillator
  const windOsc = audioCtx.createOscillator();
  windOsc.frequency.value = 0.12; // slow wind sweep (8.3 seconds)
  const windGain = audioCtx.createGain();
  windGain.gain.value = 0.06;

  rainNoiseNode = audioCtx.createGain();
  rainNoiseNode.gain.value = 0.0; // start muted

  noiseSource.connect(rainFilter);
  rainFilter.connect(rainNoiseNode);
  
  windOsc.connect(windGain);
  windGain.connect(rainNoiseNode.gain);

  rainNoiseNode.connect(audioCtx.destination);

  windOsc.start();
  noiseSource.start();

  updateAudioMode();
}

function updateAudioMode() {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }

  const now = audioCtx.currentTime;
  if (config.worldMode === 'indoor') {
    // Fade in fluorescent hum, fade out rain noise
    humNode?.gain.setValueAtTime(humNode.gain.value, now);
    humNode?.gain.linearRampToValueAtTime(0.32, now + 1.2);

    rainNoiseNode?.gain.setValueAtTime(rainNoiseNode.gain.value, now);
    rainNoiseNode?.gain.linearRampToValueAtTime(0.0, now + 1.2);
  } else {
    // Fade out fluorescent hum, fade in rain noise
    humNode?.gain.setValueAtTime(humNode.gain.value, now);
    humNode?.gain.linearRampToValueAtTime(0.015, now + 1.2);

    rainNoiseNode?.gain.setValueAtTime(rainNoiseNode.gain.value, now);
    rainNoiseNode?.gain.linearRampToValueAtTime(0.22, now + 1.2);
  }
}

/* ═══════════════════════════════════════════
   START
   ═══════════════════════════════════════════ */
async function startGame() {
  if (document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(e => console.warn("Fullscreen request failed:", e));
  }
  dom.landing.classList.add('hidden');
  dom.loading.classList.remove('hidden');

  const nameInput = document.getElementById('player-name-input');
  const pName = nameInput ? nameInput.value.trim() : "";
  const finalName = pName !== "" ? pName : "AGENTE";
  window.localPlayerName = finalName;
  initMultiplayer(null, finalName);
  listenToPlayers(onPlayersSync);
  listenToGraffiti(onGraffitiSync);
  listenToSaturation(onSaturationSync);

  initThree();
  initGeometries();
  initMaterials();

  await loadTextures(p => {
    dom.loadingBar.style.width = `${p * 50}%`;
    dom.loadingText.textContent = p < 0.5 ? 'CARREGANDO TEXTURAS...' : 'PREPARANDO PROPAGANDAS...';
  });
  initPosterMaterials();

  dom.loadingBar.style.width = '60%';
  dom.loadingText.textContent = 'GERANDO TERRITÓRIO...';

  // Generate initial chunks around spawn
  updateChunks();

  dom.loadingBar.style.width = '85%';
  dom.loadingText.textContent = 'POSICIONANDO ROSTOS...';

  setupControls();


  await new Promise(r => setTimeout(r, 600));
  dom.loadingBar.style.width = '100%';
  dom.loadingText.textContent = 'VOCÊ ESTÁ SENDO OBSERVADO.';
  await new Promise(r => setTimeout(r, 500));

  dom.loading.classList.add('hidden');
  dom.canvas.classList.remove('hidden');
  dom.hud.classList.remove('hidden');

  state.started = true;
  if (!isTouchDevice) {
    controls.lock(); // Only lock pointer on desktop, avoids crash on iOS Safari
  }
  startAmbienceAudio();
  gameLoop();
}

/* ═══════════════════════════════════════════
   ENTRY
   ═══════════════════════════════════════════ */
setupLanding();
dom.enterBtn?.addEventListener('click', startGame);
document.addEventListener('keydown', e => {
  if (e.code === 'Enter' && !state.started) startGame();
});

/* ═══════════════════════════════════════════
   IP BANK & INVENTORY SYSTEM
   ═══════════════════════════════════════════ */
state.clientIP = '127.0.0.1';
state.globalIPLedger = [
  { ip: '198.41.0.4', count: 142, label: 'Nodo Invasor' },
  { ip: '200.19.42.1', count: 88, label: 'Nodo Público' },
  { ip: '8.8.8.8', count: 12, label: 'Nodo Expositor' },
  { ip: '186.204.1.33', count: 4, label: 'Nodo Observador' }
];

async function fetchClientIP() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    const data = await res.json();
    state.clientIP = data.ip;
  } catch (e) {
    let mock = localStorage.getItem('john_melo_mock_ip');
    if (!mock) {
      mock = `189.${Math.floor(Math.random()*254)+1}.${Math.floor(Math.random()*254)+1}.${Math.floor(Math.random()*254)+1}`;
      localStorage.setItem('john_melo_mock_ip', mock);
    }
    state.clientIP = mock;
  }
  
  // Load saved collected count from localStorage for this IP
  const savedVal = localStorage.getItem(`john_melo_bank_${state.clientIP}`);
  if (savedVal !== null) {
    state.counterValue = parseInt(savedVal, 10);
    if (dom.hudCounter) dom.hudCounter.textContent = Number(state.counterValue).toLocaleString('pt-BR');
    const cv = document.getElementById('counter-value');
    if (cv) cv.textContent = Number(state.counterValue).toLocaleString('pt-BR');
  } else {
    localStorage.setItem(`john_melo_bank_${state.clientIP}`, state.counterValue);
  }
  
  document.getElementById('user-ip').textContent = state.clientIP;
  updateInventoryUI();
}

function saveIPBankScore() {
  localStorage.setItem(`john_melo_bank_${state.clientIP}`, state.counterValue);
  updateInventoryUI();
}

function updateInventoryUI() {
  const countEl = document.getElementById('user-collected-count');
  if (countEl) countEl.textContent = state.counterValue;

  const grid = document.getElementById('inventory-grid');
  if (grid) {
    grid.innerHTML = '';
    const showCount = Math.min(state.counterValue, 60);
    for (let i = 0; i < showCount; i++) {
      const slot = document.createElement('div');
      slot.className = 'inventory-slot';
      const img = document.createElement('img');
      img.src = './assets/face.png';
      slot.appendChild(img);
      grid.appendChild(slot);
    }
    if (state.counterValue > 60) {
      const more = document.createElement('div');
      more.className = 'inventory-slot';
      more.style.fontFamily = 'var(--font-mono)';
      more.style.fontSize = '0.65rem';
      more.style.color = '#fff';
      more.style.display = 'flex';
      more.style.alignItems = 'center';
      more.style.justifyContent = 'center';
      more.textContent = `+${state.counterValue - 60}`;
      grid.appendChild(more);
    }
  }

  const list = document.getElementById('ip-ledger-list');
  if (list) {
    list.innerHTML = '';
    const userRow = document.createElement('div');
    userRow.className = 'ip-ledger-row current-user';
    userRow.innerHTML = `
      <span class="ledger-label">${state.clientIP} (VOCÊ)</span>
      <span class="ledger-value">${state.counterValue} ROSTOS</span>
    `;
    list.appendChild(userRow);

    state.globalIPLedger.forEach(node => {
      const row = document.createElement('div');
      row.className = 'ip-ledger-row';
      row.innerHTML = `
        <span class="ledger-label">${node.ip} (${node.label})</span>
        <span class="ledger-value">${node.count} ROSTOS</span>
      `;
      list.appendChild(row);
    });
  }
}

window.addEventListener('load', () => {
  fetchClientIP();
  setupEditor();
});

/* ═══════════════════════════════════════════
   CREATOR STUDIO ENGINE EDITOR & SCRIPTING
   ═══════════════════════════════════════════ */
let selectionBoxHelper = null;
let isEditorDragging = false;
let prevMouseX = 0, prevMouseY = 0;

function toggleEditorMode() {
  state.editorActive = !state.editorActive;
  const panel = document.getElementById('overlay-editor');
  
  if (state.editorActive) {
    panel?.classList.remove('hidden');
    controls.unlock();
    state.paused = false; // keep frame updates running
    
    // Fill JSON config text area on open
    const textarea = document.getElementById('txt-config-json');
    if (textarea) {
      textarea.value = JSON.stringify(config, null, 2);
    }
  } else {
    panel?.classList.add('hidden');
    selectEditorObject(null);
    controls.lock();
  }
}

function selectEditorObject(obj) {
  state.selectedObject = obj;
  
  if (selectionBoxHelper) {
    scene.remove(selectionBoxHelper);
    selectionBoxHelper = null;
  }
  
  const noSelEl = document.getElementById('inspector-no-selection');
  const selEl = document.getElementById('inspector-selected');
  
  if (obj) {
    noSelEl?.classList.add('hidden');
    selEl?.classList.remove('hidden');
    
    selectionBoxHelper = new THREE.BoxHelper(obj, 0xff1a1a);
    scene.add(selectionBoxHelper);
    
    // Fill inputs
    document.getElementById('inspector-obj-name').textContent = obj.name || obj.userData.modelName || `Objeto (${obj.type || 'Mesh'})`;
    document.getElementById('inp-pos-x').value = obj.position.x.toFixed(2);
    document.getElementById('inp-pos-y').value = obj.position.y.toFixed(2);
    document.getElementById('inp-pos-z').value = obj.position.z.toFixed(2);
    
    document.getElementById('inp-scale-x').value = obj.scale.x.toFixed(2);
    document.getElementById('inp-scale-y').value = obj.scale.y.toFixed(2);
    document.getElementById('inp-scale-z').value = obj.scale.z.toFixed(2);
    
    document.getElementById('inp-rot-y').value = Math.round(obj.rotation.y * (180 / Math.PI));
    
    const colorInput = document.getElementById('inp-color');
    if (colorInput) {
      if (obj.material && obj.material.color) {
        colorInput.value = '#' + obj.material.color.getHexString();
      } else {
        colorInput.value = '#ffffff';
      }
    }
  } else {
    noSelEl?.classList.remove('hidden');
    selEl?.classList.add('hidden');
  }
}

function updateSelectedObjectFromUI() {
  const obj = state.selectedObject;
  if (!obj) return;
  
  obj.position.set(
    parseFloat(document.getElementById('inp-pos-x').value) || 0,
    parseFloat(document.getElementById('inp-pos-y').value) || 0,
    parseFloat(document.getElementById('inp-pos-z').value) || 0
  );
  
  obj.scale.set(
    parseFloat(document.getElementById('inp-scale-x').value) || 1,
    parseFloat(document.getElementById('inp-scale-y').value) || 1,
    parseFloat(document.getElementById('inp-scale-z').value) || 1
  );
  
  obj.rotation.y = (parseFloat(document.getElementById('inp-rot-y').value) || 0) * (Math.PI / 180);
  
  const colVal = document.getElementById('inp-color').value;
  if (obj.material) {
    if (Array.isArray(obj.material)) {
      obj.material.forEach(m => m.color?.set(colVal));
    } else if (obj.material.color) {
      obj.material.color.set(colVal);
    }
  }
  
  if (selectionBoxHelper) {
    selectionBoxHelper.update();
  }
}

function rebuildOutdoorMap() {
  for (const [key] of chunks) {
    unloadChunk(key);
  }
  state.playerChunkX = Infinity;
  updateChunks();
}

function setupEditor() {
  // 1. Tab switches
  document.querySelectorAll('.editor-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.editor-tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.editor-tab-pane').forEach(p => p.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab)?.classList.add('active');
    });
  });

  // 2. Flight drag-rotation mouse event listeners
  const canvas = dom.canvas || document.getElementById('game-canvas');
  if (canvas) {
    canvas.addEventListener('mousedown', e => {
      if (!state.editorActive) return;
      isEditorDragging = true;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;
    });

    document.addEventListener('mousemove', e => {
      if (!state.editorActive || !isEditorDragging) return;
      const dx = e.clientX - prevMouseX;
      const dy = e.clientY - prevMouseY;
      prevMouseX = e.clientX;
      prevMouseY = e.clientY;
      
      const sensitivity = 0.003;
      camera.rotation.y -= dx * sensitivity;
      camera.rotation.x -= dy * sensitivity;
      camera.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, camera.rotation.x));
    });

    document.addEventListener('mouseup', () => {
      isEditorDragging = false;
    });

    // Raycast click selection
    canvas.addEventListener('click', e => {
      if (!state.editorActive || isEditorDragging) return;
      
      // Calculate normal mouse coords
      const mouse = new THREE.Vector2(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1
      );
      
      const ray = new THREE.Raycaster();
      ray.setFromCamera(mouse, camera);
      
      const intersects = ray.intersectObjects(scene.children, true);
      if (intersects.length > 0) {
        let obj = intersects[0].object;
        // Traverse up to find top group or building chunk child
        while (obj.parent && obj.parent !== scene && !obj.parent.name.startsWith('chunk_')) {
          obj = obj.parent;
        }
        selectEditorObject(obj);
      } else {
        selectEditorObject(null);
      }
    });
  }

  // 3. Setup form input updates
  ['inp-pos-x', 'inp-pos-y', 'inp-pos-z', 'inp-scale-x', 'inp-scale-y', 'inp-scale-z', 'inp-rot-y', 'inp-color'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateSelectedObjectFromUI);
  });

  // Delete & Duplicate
  document.getElementById('btn-delete-object')?.addEventListener('click', () => {
    if (state.selectedObject) {
      state.selectedObject.parent?.remove(state.selectedObject);
      selectEditorObject(null);
    }
  });
  document.getElementById('btn-duplicate-object')?.addEventListener('click', () => {
    if (state.selectedObject) {
      const clone = state.selectedObject.clone();
      clone.position.x += 3.0; // slight offset
      state.selectedObject.parent?.add(clone);
      selectEditorObject(clone);
    }
  });

  // 4. Biome/Atmosphere Sliders
  const bindEditorSlider = (id, labelId, configKey, isFloat = false) => {
    const slider = document.getElementById(id);
    const label = document.getElementById(labelId);
    if (!slider || !label) return;
    
    slider.addEventListener('input', () => {
      const val = isFloat ? parseFloat(slider.value) : parseFloat(slider.value);
      config[configKey] = val;
      label.textContent = val;
      
      if (configKey === 'fogDensityOutdoor' && scene.fog) {
        scene.fog.density = val;
      }
      if (configKey === 'ambientLightIntensity' && ambientLight) {
        ambientLight.intensity = val;
      }
    });
  };

  bindEditorSlider('sld-island-radius', 'lbl-island-radius', 'islandRadius');
  bindEditorSlider('sld-hill-height', 'lbl-hill-height', 'hillHeight');
  bindEditorSlider('sld-fog-density', 'lbl-fog-density', 'fogDensityOutdoor', true);
  bindEditorSlider('sld-ambient-light', 'lbl-ambient-light', 'ambientLightIntensity', true);
  
  // Water level slider manually updates the active ocean/water meshes
  document.getElementById('sld-water-level')?.addEventListener('input', e => {
    const val = parseFloat(e.target.value);
    document.getElementById('lbl-water-level').textContent = val;
    // Iterate active water objects and offset their Y
    scene.traverse(child => {
      if (child.isMesh && child.material === mat.ocean) {
        child.position.y = val;
      }
    });
  });

  document.getElementById('btn-rebuild-outdoor')?.addEventListener('click', rebuildOutdoorMap);

  // 5. JSON Config Applier
  document.getElementById('btn-apply-config-json')?.addEventListener('click', () => {
    try {
      const raw = document.getElementById('txt-config-json').value;
      const parsed = JSON.parse(raw);
      Object.assign(config, parsed);
      
      if (scene.fog) scene.fog.density = config.fogDensityOutdoor || 0.016;
      if (ambientLight) ambientLight.intensity = config.ambientLightIntensity || 2.5;
      
      rebuildOutdoorMap();
      alert('Configuração JSON aplicada com sucesso!');
    } catch (e) {
      alert('Erro de JSON inválido: ' + e.message);
    }
  });

  // 6. JS Scripting Compiler
  document.getElementById('btn-compile-script')?.addEventListener('click', () => {
    try {
      const scriptText = document.getElementById('txt-generator-script').value;
      // Compile using Function
      const compiled = new Function(`return ${scriptText}`)();
      if (typeof compiled === 'function') {
        state.customScript = compiled;
        rebuildOutdoorMap();
        alert('Script JS compilado e aplicado com sucesso!');
      } else {
        alert('O script deve retornar uma função do tipo: (group, cx, cz, rng, colliders) => { ... }');
      }
    } catch (e) {
      alert('Erro na compilação do script: ' + e.message);
    }
  });

  // 7. GLTF Local Model Importer
  document.getElementById('btn-trigger-upload')?.addEventListener('click', () => {
    document.getElementById('gltf-file-input').click();
  });

  let pendingGLTFData = null;
  document.getElementById('gltf-file-input')?.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(evt) {
      const contents = evt.target.result;
      const loader = new GLTFLoader();
      
      document.getElementById('btn-trigger-upload').textContent = 'CARREGANDO MODELO...';
      
      loader.parse(contents, '', (gltf) => {
        pendingGLTFData = gltf;
        document.getElementById('btn-trigger-upload').textContent = `ARQUIVO: ${file.name}`;
        
        document.getElementById('gltf-rules-panel').classList.remove('hidden');
        document.getElementById('gltf-reg-name').value = file.name.replace(/\.[^/.]+$/, "");
      }, (err) => {
        alert('Erro ao carregar GLTF: ' + err.message);
        document.getElementById('btn-trigger-upload').textContent = 'SELECIONAR ARQUIVO 3D';
      });
    };
    reader.readAsArrayBuffer(file);
  });

  document.getElementById('btn-save-gltf-rule')?.addEventListener('click', () => {
    if (!pendingGLTFData) return;
    
    const name = document.getElementById('gltf-reg-name').value || 'Modelo Custom';
    const room = document.getElementById('gltf-spawn-room').value;
    const placement = document.getElementById('gltf-spawn-placement').value;
    const chance = parseInt(document.getElementById('gltf-spawn-chance').value, 10);
    const scale = parseFloat(document.getElementById('gltf-spawn-scale').value) || 1.0;
    
    state.importedModels.push({
      name,
      scene: pendingGLTFData.scene,
      room,
      placement,
      chance,
      scale
    });
    
    pendingGLTFData = null;
    document.getElementById('gltf-rules-panel').classList.add('hidden');
    document.getElementById('btn-trigger-upload').textContent = 'SELECIONAR ARQUIVO 3D';
    
    updateImportedModelsList();
    rebuildOutdoorMap();
  });
}

function updateImportedModelsList() {
  const container = document.getElementById('gltf-models-list');
  if (!container) return;
  
  if (state.importedModels.length === 0) {
    container.innerHTML = 'Nenhum modelo customizado registrado.';
    return;
  }
  
  container.innerHTML = '';
  state.importedModels.forEach((model, idx) => {
    const item = document.createElement('div');
    item.className = 'gltf-model-item';
    item.innerHTML = `
      <div>
        <strong>${model.name}</strong><br/>
        <span style="font-size:0.55rem; color:#666;">Sala: ${model.room} | Pos: ${model.placement} | Chance: ${model.chance}%</span>
      </div>
      <button class="editor-btn danger" style="padding:2px 6px; font-size:0.55rem;" onclick="removeImportedModel(${idx})">Remover</button>
    `;
    container.appendChild(item);
  });
}

window.removeImportedModel = function(idx) {
  state.importedModels.splice(idx, 1);
  updateImportedModelsList();
  rebuildOutdoorMap();
};

document.getElementById('btn-close-editor')?.addEventListener('click', toggleEditorMode);

/* ═══════════════════════════════════════════
   BLENDER WORLD LOADER & PARSER
   ═══════════════════════════════════════════ */
function loadBlenderOutsideWorld() {
  if (isTouchDevice || ('ontouchstart' in window)) {
    console.warn('[MOBILE] Skipping outside_world.glb load to avoid WebGL memory crash. Using procedural fallback.');
    state.blenderSceneActive = false;
    return;
  }
  
  const loader = new GLTFLoader();
  
  const loadingIndicator = document.createElement('div');
  loadingIndicator.id = 'loader-outside-world';
  loadingIndicator.style = 'position:fixed; bottom:20px; left:20px; color:#ff1a1a; font-family:monospace; font-size:0.8rem; z-index:9999; text-shadow: 0 0 4px rgba(255,26,26,0.6);';
  loadingIndicator.textContent = '> [SISTEMA] BUSCANDO ARQUIVO DA CIDADE (/assets/outside_world.glb)...';
  document.body.appendChild(loadingIndicator);
  
  loader.load('./assets/outside_world.glb', (gltf) => {
    loadingIndicator.textContent = '> [SISTEMA] CIDADE CARREGADA COM SUCESSO.';
    setTimeout(() => loadingIndicator.remove(), 3000);
    parseBlenderOutsideWorld(gltf);
  }, 
  (xhr) => {
    if (xhr.total > 0) {
      const pct = Math.round((xhr.loaded / xhr.total) * 100);
      loadingIndicator.textContent = `> [SISTEMA] BAIXANDO MODELO DA CIDADE: ${pct}%`;
    }
  },
  (err) => {
    console.warn('outside_world.glb não encontrado em /assets/. Usando geração procedural fallback.');
    loadingIndicator.textContent = '> [SISTEMA] ARQUIVO 3D DA CIDADE NÃO ENCONTRADO. USANDO FALLBACK PROCEDURAL.';
    setTimeout(() => loadingIndicator.remove(), 4000);
    state.blenderSceneActive = false;
  });
}

function parseBlenderOutsideWorld(gltf) {
  if (blenderWorldGroup) {
    scene.remove(blenderWorldGroup);
  }
  blenderColliders = [];
  blenderInteractables = [];
  blenderGroundMeshes = [];
  
  blenderWorldGroup = gltf.scene;
  blenderWorldGroup.name = 'blender_outside_world';
  blenderWorldGroup.scale.set(2.8, 2.8, 2.8); // Scale scene up by 2.8x!
  
  blenderWorldGroup.traverse(child => {
    const name = child.name.toLowerCase();
    
    if (child.isLight) {
      child.castShadow = true;
      child.shadow.bias = -0.001;
    }
    
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      
      // Auto-replace water/ocean meshes with animated water material
      if (name.includes('water') || name.includes('ocean') || name.includes('sea')) {
        child.material = mat.ocean;
        child.castShadow = false;
        child.receiveShadow = true;
      }
      
      // Auto-collision check
      const isGround = name.includes('ground') || name.includes('street') || name.includes('road') || name.includes('hill') || name.includes('floor') || name.includes('terrain') || name.includes('pier') || name.includes('dock') || name.includes('sand') || name.includes('walkway');
      
      if (isGround) {
        blenderGroundMeshes.push(child);
      } else if (name.startsWith('col_')) {
        // Solid building wall or barrier: add solid AABB collider
        const box = new THREE.Box3().setFromObject(child);
        blenderColliders.push(box);
      }
      
      // Interactive portal door check
      if (name.startsWith('portal_')) {
        let roomType = 'gallery';
        if (name.includes('backroom')) roomType = 'backroom';
        if (name.includes('void')) roomType = 'void';
        if (name.includes('cinema')) roomType = 'cinema';
        if (name.includes('crt')) roomType = 'crt';
        if (name.includes('zine')) roomType = 'zine';
        if (name.includes('cassette')) roomType = 'cassette';
        
        child.userData = { type: 'portal_blender', roomType: roomType };
        blenderInteractables.push(child);
      }
      
      // Billboard / Poster skinning
      if (name.startsWith('poster_') || name.startsWith('billboard_')) {
        const texName = ['face', 'poster', 'city', 'posterRed'][Math.floor(Math.random() * 4)];
        const randMat = new THREE.MeshBasicMaterial({
          map: new THREE.TextureLoader().load(`./assets/${getTexSrc(texName)}`),
          side: THREE.DoubleSide
        });
        child.material = randMat;
      }
    }
    
    // Player Spawn locator
    if (child.name === 'spawn_player') {
      blenderSpawnPoint.copy(child.position).multiplyScalar(2.8);
    }
  });
  
  // ── PROCEDURAL BUILDING PROPAGANDA ──
  // Scan solid buildings and stick John Melo posters to their walls!
  blenderColliders.forEach(box => {
    const size = new THREE.Vector3();
    box.getSize(size);
    
    // Only wrap reasonably sized building structures
    if (size.y > 6.0 && size.x > 3.0 && size.z > 3.0) {
      const center = new THREE.Vector3();
      box.getCenter(center);
      
      const sides = [
        { dir: new THREE.Vector3(0, 0, 1), rot: 0 },
        { dir: new THREE.Vector3(0, 0, -1), rot: Math.PI },
        { dir: new THREE.Vector3(1, 0, 0), rot: Math.PI / 2 },
        { dir: new THREE.Vector3(-1, 0, 0), rot: -Math.PI / 2 }
      ];
      
      // Pick 2 random sides to attach posters
      const chosenSides = sides.sort(() => 0.5 - Math.random()).slice(0, 2);
      chosenSides.forEach(side => {
        const pY = box.min.y + Math.random() * (size.y * 0.6) + 1.5;
        const pX = center.x + side.dir.x * (size.x / 2 + 0.05);
        const pZ = center.z + side.dir.z * (size.z / 2 + 0.05);
        
        const pWidth = 2.0 + Math.random() * 3.5;
        const pHeight = 2.8 + Math.random() * 4.0;
        const posterGeo = new THREE.PlaneGeometry(pWidth, pHeight);
        
        const texName = ['face', 'poster', 'city', 'posterRed'][Math.floor(Math.random() * 4)];
        const posterMat = new THREE.MeshBasicMaterial({
          map: new THREE.TextureLoader().load(`./assets/${getTexSrc(texName)}`),
          side: THREE.DoubleSide
        });
        
        const posterMesh = new THREE.Mesh(posterGeo, posterMat);
        posterMesh.position.set(pX, pY, pZ);
        posterMesh.rotation.y = side.rot;
        
        blenderWorldGroup.add(posterMesh);
      });
    }
  });
  
  // ── PROCEDURAL OUTDOOR INJECTORS ──
  // Inject portal doors, papers, streetlights, and dead trees on the Blender terrain
  spawnProceduralPortalsOnTerrain();
  spawnProceduralPapersOnTerrain();
  spawnProceduralStreetlightsOnTerrain();
  spawnProceduralTreesOnTerrain();
  
  // Animation mixer setup
  if (gltf.animations && gltf.animations.length > 0) {
    blenderMixer = new THREE.AnimationMixer(blenderWorldGroup);
    gltf.animations.forEach(clip => {
      blenderMixer.clipAction(clip).play();
    });
  }
  
  scene.add(blenderWorldGroup);
  state.blenderSceneActive = true;
  
  if (config.worldMode === 'outdoor') {
    enterOutdoorBlenderWorld();
  } else {
    blenderWorldGroup.visible = false;
  }
}

function enterOutdoorBlenderWorld() {
  triggerGlitch(1.0);
  config.worldMode = 'outdoor';
  
  // Set wide-angle fisheye view for outdoors
  camera.fov = 92;
  camera.updateProjectionMatrix();
  
  // Hide active procedural chunks
  for (const [key] of chunks) {
    unloadChunk(key);
  }
  
  const targetColor = config.fogColorOutdoor;
  const targetDensity = config.fogDensityOutdoor;
  scene.background.setHex(targetColor);
  if (scene.fog) {
    scene.fog.color.setHex(targetColor);
    scene.fog.density = targetDensity;
  }
  
  if (blenderWorldGroup) {
    blenderWorldGroup.visible = true;
    camera.position.copy(blenderSpawnPoint);
    const snapY = getTerrainHeight(camera.position.x, camera.position.z);
    if (snapY > -2.0) {
      camera.position.y = snapY + PLAYER_HEIGHT;
    }
  }
}

function enterIndoorMode(roomType) {
  triggerGlitch(1.0);
  config.worldMode = 'indoor';
  
  // Restore standard view for indoors
  camera.fov = 70;
  camera.updateProjectionMatrix();
  
  if (blenderWorldGroup) {
    blenderWorldGroup.visible = false;
  }
  
  const targetColor = config.fogColorIndoor;
  const targetDensity = config.fogDensityIndoor;
  scene.background.setHex(targetColor);
  if (scene.fog) {
    scene.fog.color.setHex(targetColor);
    scene.fog.density = targetDensity;
  }
  
  // Start inside first room (gallery or backroom)
  camera.position.set(0, PLAYER_HEIGHT, 0);
  state.playerChunkX = Infinity;
  updateChunks();
}

/* ═══════════════════════════════════════════
   GRAFFITI & TAGGING SYSTEM
   ═══════════════════════════════════════════ */
function createAirbrushTexture(colorHex) {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  
  let cStart = 'rgba(255,26,26,1.0)';
  let cMid = 'rgba(255,26,26,0.35)';
  let cEnd = 'rgba(255,26,26,0.0)';
  if (colorHex === '#050505') {
    cStart = 'rgba(5,5,5,1.0)'; cMid = 'rgba(5,5,5,0.35)'; cEnd = 'rgba(5,5,5,0.0)';
  } else if (colorHex === '#f0f0e8') {
    cStart = 'rgba(240,240,232,1.0)'; cMid = 'rgba(240,240,232,0.35)'; cEnd = 'rgba(240,240,232,0.0)';
  }
  
  const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, cStart);
  grad.addColorStop(0.2, cStart);
  grad.addColorStop(0.6, cMid);
  grad.addColorStop(1.0, cEnd);
  
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function initGraffiti() {
  brushTextures['red'] = createAirbrushTexture('#ff1a1a');
  brushTextures['black'] = createAirbrushTexture('#050505');
  brushTextures['white'] = createAirbrushTexture('#f0f0e8');
  
  brushMaterials['red'] = new THREE.MeshBasicMaterial({
    map: brushTextures['red'],
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4
  });
  brushMaterials['black'] = new THREE.MeshBasicMaterial({
    map: brushTextures['black'],
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4
  });
  brushMaterials['white'] = new THREE.MeshBasicMaterial({
    map: brushTextures['white'],
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4
  });
  
  // Use existing loaded face texture
  brushMaterials['face'] = new THREE.MeshBasicMaterial({
    map: textures['face'] || new THREE.TextureLoader().load('./assets/face.png'),
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4
  });
  
  // Preview quad
  const previewGeo = new THREE.PlaneGeometry(1, 1);
  const previewMat = new THREE.MeshBasicMaterial({
    color: 0xff0000,
    transparent: true,
    opacity: 0.4,
    wireframe: true,
    depthWrite: false
  });
  graffitiPreviewMesh = new THREE.Mesh(previewGeo, previewMat);
  graffitiPreviewMesh.visible = false;
  graffitiPreviewMesh.name = 'graffiti_preview_mesh';
  scene.add(graffitiPreviewMesh);
  
  loadSavedDecals();
  
  ['face', 'red', 'black', 'white'].forEach(type => {
    document.getElementById(`g-slot-${type}`)?.addEventListener('click', () => {
      selectGraffitiBrush(type);
    });
  });
  
  // Bind Clear button
  document.getElementById('btn-clear-graffiti')?.addEventListener('click', () => {
    if (confirm('Deseja limpar todas as pixações e cartazes colados?')) {
      const toRemove = [];
      scene.traverse(child => {
        if (child.userData && child.userData.type === 'decal_mesh') {
          toRemove.push(child);
        }
      });
      toRemove.forEach(m => scene.remove(m));
      
      placedDecals = [];
      saveDecalsToLocalStorage();
    }
  });
  
  window.addEventListener('wheel', e => {
    if (!state.graffitiActive) return;
    state.graffitiSize = Math.max(0.2, Math.min(5.0, state.graffitiSize - e.deltaY * 0.002));
    const sizeDisplay = document.getElementById('graffiti-brush-size');
    if (sizeDisplay) {
      sizeDisplay.textContent = `${state.graffitiSize.toFixed(1)}m`;
    }
  });
}

// ── MULTIPLAYER VARIABLES & SYNC FUNCTIONS ──
let lastFirebaseUpdate = 0;
const remotePlayers = {};

function onPlayersSync(playersData, myId) {
  if (!playersData) return;
  
  const listEl = document.getElementById('online-players-list');
  const countEl = document.getElementById('online-count');
  let html = `<li><span style="color:var(--yellow)">▶</span> ${(window.localPlayerName || 'AGENTE').toUpperCase()} (VOCÊ)</li>`;
  let onlineCount = 1;

  for (const id in playersData) {
    if (id === myId) continue;
    const p = playersData[id];
    
    if (Date.now() - p.lastUpdate <= 10000) {
      html += `<li>${p.name ? p.name.toUpperCase() : 'AGENTE'}</li>`;
      onlineCount++;
    }
    
    if (Date.now() - p.lastUpdate > 10000) {
      if (remotePlayers[id]) {
        scene.remove(remotePlayers[id]);
        delete remotePlayers[id];
      }
      continue;
    }

    if (!remotePlayers[id]) {
      const geo = new THREE.BoxGeometry(1.5, 3, 1.5);
      const mat = new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true, transparent: true, opacity: 0.3 }); 
      const mesh = new THREE.Mesh(geo, mat);
      scene.add(mesh);
      remotePlayers[id] = mesh;
    }

    remotePlayers[id].position.lerp(new THREE.Vector3(p.x, p.y + 1.5, p.z), 0.2); // y + 1.5 to center the 3m box
    remotePlayers[id].rotation.y = p.rotY;
  }
}

const networkGraffitiIds = new Set();
function onGraffitiSync(grafData) {
  if (grafData.owner === getPlayerId()) return;
  
  const key = `${grafData.x},${grafData.y},${grafData.z}_${grafData.timestamp}`;
  if (networkGraffitiIds.has(key)) return;
  networkGraffitiIds.add(key);

  const pos = new THREE.Vector3(grafData.x, grafData.y, grafData.z);
  const normal = new THREE.Vector3(grafData.nx, grafData.ny, grafData.nz);
  spawnDecalMesh(pos, normal, grafData.brush, grafData.size, placedDecals.length, grafData.targetId);
  placedDecals.push({
    pos: [pos.x, pos.y, pos.z],
    normal: [normal.x, normal.y, normal.z],
    type: grafData.brush,
    size: grafData.size,
    targetId: grafData.targetId
  });
}

let currentSaturation = 0;
function onSaturationSync(val) {
  currentSaturation = val;
  const satText = document.getElementById('saturation-text');
  const satFill = document.getElementById('saturation-bar-fill');
  if (satText) satText.textContent = val.toFixed(1) + '%';
  if (satFill) satFill.style.width = val + '%';
  
  if (val >= 100) {
    triggerManifestoEvent();
  }
}

function triggerManifestoEvent() {
  // Simples evento visual para 100% de saturação
  scene.fog.color.setHex(0xff0000);
  scene.fog.density = 0.1;
  document.body.style.filter = 'hue-rotate(90deg) contrast(1.5)';
}

function selectGraffitiBrush(type) {
  state.graffitiBrush = type;
  
  document.querySelectorAll('.graffiti-hud-slot').forEach(s => s.classList.remove('active'));
  document.getElementById(`g-slot-${type}`)?.classList.add('active');
  
  if (graffitiPreviewMesh) {
    if (type === 'face') {
      graffitiPreviewMesh.material.color.setHex(0xff0033);
    } else if (type === 'red') {
      graffitiPreviewMesh.material.color.setHex(0xff1a1a);
    } else if (type === 'black') {
      graffitiPreviewMesh.material.color.setHex(0x111111);
    } else if (type === 'white') {
      graffitiPreviewMesh.material.color.setHex(0xffffff);
    }
  }
}

function toggleGraffitiMode() {
  if (state.editorActive || state.paused || state.overlayOpen) return;
  
  state.graffitiActive = !state.graffitiActive;
  const hud = document.getElementById('hud-graffiti');
  
  if (state.graffitiActive) {
    hud?.classList.remove('hidden');
    selectGraffitiBrush(state.graffitiBrush);
    if (graffitiPreviewMesh) graffitiPreviewMesh.visible = true;
  } else {
    hud?.classList.add('hidden');
    if (graffitiPreviewMesh) graffitiPreviewMesh.visible = false;
    isSpraying = false;
  }
}

function updateGraffitiPreview() {
  if (!state.graffitiActive || !graffitiPreviewMesh) return;
  
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  
  const targets = [];
  for (const [key, data] of chunks) {
    if (data.group) targets.push(data.group);
  }
  if (state.blenderSceneActive && blenderWorldGroup) {
    targets.push(blenderWorldGroup);
  }
  targets.push(...Object.values(remotePlayers));
  
  const intersects = raycaster.intersectObjects(targets, true);
  
  if (intersects.length > 0 && intersects[0].distance < 8.0 && intersects[0].face) {
    const hit = intersects[0];
    graffitiPreviewMesh.visible = true;
    
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const pos = hit.point.clone().addScaledVector(normal, 0.015);
    graffitiPreviewMesh.position.copy(pos);
    
    graffitiPreviewMesh.scale.set(state.graffitiSize, state.graffitiSize, 1.0);
    
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(normal.y) > 0.99) {
      up.set(0, 0, 1);
    }
    const matrix = new THREE.Matrix4().lookAt(
      new THREE.Vector3(0, 0, 0),
      normal,
      up
    );
    graffitiPreviewMesh.rotation.setFromRotationMatrix(matrix);
  } else {
    graffitiPreviewMesh.visible = false;
  }
}

function placeGraffitiDecal() {
  if (!state.graffitiActive || !graffitiPreviewMesh || !graffitiPreviewMesh.visible) return;
  
  raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
  
  const targets = [];
  for (const [key, data] of chunks) {
    if (data.group) targets.push(data.group);
  }
  if (state.blenderSceneActive && blenderWorldGroup) {
    targets.push(blenderWorldGroup);
  }
  targets.push(...Object.values(remotePlayers));
  
  const intersects = raycaster.intersectObjects(targets, true);
  if (intersects.length === 0 || intersects[0].distance >= 8.0 || !intersects[0].face) return;
  
  const hit = intersects[0];
  const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  const pos = hit.point.clone().addScaledVector(normal, 0.015);
  
  const brush = state.graffitiBrush;
  
  if (brush === 'face') {
    if (window.stickerCount <= 0) {
      const stickerEl = document.getElementById('hud-sticker-count');
      if (stickerEl) {
        stickerEl.style.color = 'red';
        setTimeout(() => stickerEl.style.color = 'white', 1000);
      }
      isSpraying = false;
      return;
    }
    window.stickerCount -= 1;
    document.getElementById('hud-sticker-count').textContent = window.stickerCount;
    
    state.counterValue += 1;
    document.getElementById('hud-counter').textContent = Number(state.counterValue).toLocaleString('pt-BR');
    document.getElementById('counter-value').textContent = Number(state.counterValue).toLocaleString('pt-BR');
    saveIPBankScore();
    incrementGlobalSaturation(0.2); // Colar rosto dá 0.2%
  } else {
    // Sprays
    if (currentSaturation < 40) {
      alert('SATURAÇÃO MUITO BAIXA. CONTINUE COLANDO ROSTOS PARA DESBLOQUEAR A TINTA (REQUER 40%).');
      isSpraying = false;
      return;
    }
    incrementGlobalSaturation(0.05); // Tinta dá 0.05%
  }
  
  let targetId = null;
  if (hit.object && hit.object.userData && hit.object.userData.isPlayer) {
    targetId = hit.object.userData.remotePlayerId;
  }
  
  spawnDecalMesh(pos, normal, brush, state.graffitiSize, placedDecals.length, targetId);
  
  placedDecals.push({
    pos: [pos.x, pos.y, pos.z],
    normal: [normal.x, normal.y, normal.z],
    type: brush,
    size: state.graffitiSize,
    targetId: targetId
  });
  
  broadcastGraffiti(pos.x, pos.y, pos.z, normal.x, normal.y, normal.z, brush, state.graffitiSize, targetId);
  saveDecalsToLocalStorage();
}

function spawnDecalMesh(pos, normal, brush, size, indexOffset = 0, targetId = null) {
  const geometry = new THREE.PlaneGeometry(size, size);
  const mat = brushMaterials[brush];
  
  const mesh = new THREE.Mesh(geometry, mat);
  
  // Apply a tiny progressive offset along normal to stack them cleanly on top of each other
  const offsetPos = pos.clone().addScaledVector(normal, indexOffset * 0.0002);
  mesh.position.copy(offsetPos);
  
  mesh.userData = { type: 'decal_mesh' }; // tag for clearing later
  
  const up = new THREE.Vector3(0, 1, 0);
  if (Math.abs(normal.y) > 0.99) {
    up.set(0, 0, 1);
  }
  const matrix = new THREE.Matrix4().lookAt(
    new THREE.Vector3(0, 0, 0),
    normal,
    up
  );
  mesh.rotation.setFromRotationMatrix(matrix);
  
  if (targetId && remotePlayers[targetId]) {
    remotePlayers[targetId].attach(mesh);
  } else {
    scene.add(mesh);
  }
}

function saveDecalsToLocalStorage() {
  if (placedDecals.length > 300) {
    placedDecals.shift();
  }
  localStorage.setItem('john_melo_graffiti', JSON.stringify(placedDecals));
}

function loadSavedDecals() {
  try {
    const raw = localStorage.getItem('john_melo_graffiti');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      parsed.forEach((d, idx) => {
        const pos = new THREE.Vector3(...d.pos);
        const normal = new THREE.Vector3(...d.normal);
        spawnDecalMesh(pos, normal, d.type, d.size, idx);
        placedDecals.push(d);
      });
    }
  } catch (e) {
    console.error('Error loading saved decals:', e);
  }
}

/* ═══════════════════════════════════════════
   PROCEDURAL OUTDOOR ELEMENT SPANWERS & AUDIO DRONE
   ═══════════════════════════════════════════ */
let landingShakeOffsetY = 0;
function triggerLandingShake(intensity) {
  landingShakeOffsetY = -intensity;
}

function spawnProceduralPortalsOnTerrain() {
  const modeledPortals = [];
  blenderWorldGroup.traverse(child => {
    if (child.name && child.name.toLowerCase().startsWith('portal_')) {
      modeledPortals.push(child);
    }
  });
  if (modeledPortals.length > 0) return;
  
  const portalsToCreate = [
    { type: 'gallery', name: 'EXPOSIÇÃO FIGURA PÚBLICA', color: 0xff1a1a, offset: new THREE.Vector3(-15, 0, -15) },
    { type: 'backroom', name: 'SALA LIMITROFE (BACKROOM)', color: 0xe6d5a3, offset: new THREE.Vector3(15, 0, 15) },
    { type: 'cinema', name: 'SALA DE TRANSMISSÃO', color: 0x151515, offset: new THREE.Vector3(-15, 0, 15) },
    { type: 'cassette', name: 'FONTE DE AUDIO', color: 0xff6600, offset: new THREE.Vector3(15, 0, -15) }
  ];
  
  portalsToCreate.forEach(pData => {
    const px = blenderSpawnPoint.x + pData.offset.x;
    const pz = blenderSpawnPoint.z + pData.offset.z;
    const py = getTerrainHeight(px, pz);
    
    const doorGroup = new THREE.Group();
    doorGroup.position.set(px, py + 1.6, pz);
    
    const pGeo = new THREE.BoxGeometry(0.3, 3.2, 0.3);
    const pMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.95 });
    
    const leftPillar = new THREE.Mesh(pGeo, pMat);
    leftPillar.position.set(-1.0, 0, 0);
    doorGroup.add(leftPillar);
    
    const rightPillar = new THREE.Mesh(pGeo, pMat);
    rightPillar.position.set(1.0, 0, 0);
    doorGroup.add(rightPillar);
    
    const topPillar = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.3, 0.3), pMat);
    topPillar.position.set(0, 1.6, 0);
    doorGroup.add(topPillar);
    
    const portalPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(1.7, 3.0),
      new THREE.MeshStandardMaterial({
        color: pData.color,
        emissive: pData.color,
        emissiveIntensity: 2.0,
        transparent: true,
        opacity: 0.8,
        roughness: 0.1,
        metalness: 0.9
      })
    );
    portalPlane.name = `portal_${pData.type}`;
    portalPlane.userData = { type: 'portal_blender', roomType: pData.type };
    doorGroup.add(portalPlane);
    
    blenderInteractables.push(portalPlane);
    blenderWorldGroup.add(doorGroup);
  });
}

function spawnProceduralPapersOnTerrain() {
  // Scatter 60 collectible papers
  for (let i = 0; i < 60; i++) {
    const rx = blenderSpawnPoint.x + (Math.random() - 0.5) * 350;
    const rz = blenderSpawnPoint.z + (Math.random() - 0.5) * 350;
    const ry = getTerrainHeight(rx, rz);
    
    if (ry > -5.0) {
      const geo = new THREE.PlaneGeometry(0.5, 0.7);
      const pMesh = new THREE.Mesh(geo, mat.facePaper);
      pMesh.position.set(rx, ry + 0.1, rz);
      
      pMesh.rotation.x = -Math.PI / 2 + (Math.random() - 0.5) * 0.15;
      pMesh.rotation.y = (Math.random() - 0.5) * 0.15;
      pMesh.rotation.z = Math.random() * Math.PI;
      
      pMesh.userData = { type: 'paper' };
      
      blenderInteractables.push(pMesh);
      blenderWorldGroup.add(pMesh);
    }
  }
}

// ── PROCEDURAL WEB AUDIO INDUSTRIAL DRONE ──
let droneOsc1 = null, droneOsc2 = null;
let droneGain = null;

function initAudioDrone() {
  const startAudio = () => {
    if (audioCtx) return;
    
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    
    droneOsc1 = audioCtx.createOscillator();
    droneOsc2 = audioCtx.createOscillator();
    
    droneOsc1.type = 'sawtooth';
    droneOsc1.frequency.setValueAtTime(55, audioCtx.currentTime); // A1 note
    
    droneOsc2.type = 'sawtooth';
    droneOsc2.frequency.setValueAtTime(55.4, audioCtx.currentTime); // Chorus detune
    
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(110, audioCtx.currentTime);
    
    droneGain = audioCtx.createGain();
    droneGain.gain.setValueAtTime(0.09, audioCtx.currentTime); // deep subtle background
    
    const lfo = audioCtx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(0.08, audioCtx.currentTime); // very slow breathing LFO
    
    const lfoGain = audioCtx.createGain();
    lfoGain.gain.setValueAtTime(35, audioCtx.currentTime);
    
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    
    droneOsc1.connect(filter);
    droneOsc2.connect(filter);
    filter.connect(droneGain);
    droneGain.connect(audioCtx.destination);
    
    droneOsc1.start();
    droneOsc2.start();
    lfo.start();
    
    document.removeEventListener('mousedown', startAudio);
    document.removeEventListener('keydown', startAudio);
  };
  
  document.addEventListener('mousedown', startAudio);
  document.addEventListener('keydown', startAudio);
}

function spawnProceduralStreetlightsOnTerrain() {
  // Scatter 20 streetlights along the terrain streets/ground
  for (let i = 0; i < 20; i++) {
    const rx = blenderSpawnPoint.x + (Math.random() - 0.5) * 350;
    const rz = blenderSpawnPoint.z + (Math.random() - 0.5) * 350;
    const ry = getTerrainHeight(rx, rz);
    
    if (ry > -5.0) {
      const poleGroup = new THREE.Group();
      poleGroup.position.set(rx, ry, rz);
      
      // Thin black metal pole
      const poleGeo = new THREE.CylinderGeometry(0.12, 0.12, 10.0);
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
      const poleMesh = new THREE.Mesh(poleGeo, poleMat);
      poleMesh.position.y = 5.0;
      poleGroup.add(poleMesh);
      
      // Horizontal arm
      const armGeo = new THREE.CylinderGeometry(0.08, 0.08, 2.5);
      const armMesh = new THREE.Mesh(armGeo, poleMat);
      armMesh.position.set(0.8, 9.8, 0);
      armMesh.rotation.z = Math.PI / 2;
      poleGroup.add(armMesh);
      
      // Glowing bulb sphere
      const bulbGeo = new THREE.SphereGeometry(0.4, 16, 16);
      const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const bulbMesh = new THREE.Mesh(bulbGeo, bulbMat);
      bulbMesh.position.set(1.8, 9.5, 0);
      poleGroup.add(bulbMesh);
      
      // Real spot light casting down
      const light = new THREE.SpotLight(0xfff5dd, 25.0, 35, Math.PI / 4, 0.5, 1.0);
      light.position.set(1.8, 9.4, 0);
      const targetObj = new THREE.Object3D();
      targetObj.position.set(1.8, 0, 0);
      poleGroup.add(targetObj);
      light.target = targetObj;
      poleGroup.add(light);
      
      blenderWorldGroup.add(poleGroup);
    }
  }
}

function spawnProceduralTreesOnTerrain() {
  // Scatter 35 stylized dark winter trees (dead trees)
  for (let i = 0; i < 35; i++) {
    const rx = blenderSpawnPoint.x + (Math.random() - 0.5) * 450;
    const rz = blenderSpawnPoint.z + (Math.random() - 0.5) * 450;
    const ry = getTerrainHeight(rx, rz);
    
    // Only place on actual ground, not in deep water
    if (ry > 2.5) {
      const treeGroup = new THREE.Group();
      treeGroup.position.set(rx, ry, rz);
      
      // Crooked trunk
      const trunkGeo = new THREE.CylinderGeometry(0.2, 0.4, 7.0, 8);
      const woodMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.95 });
      const trunkMesh = new THREE.Mesh(trunkGeo, woodMat);
      trunkMesh.position.y = 3.5;
      trunkMesh.rotation.z = (Math.random() - 0.5) * 0.15; // crooked
      treeGroup.add(trunkMesh);
      
      // 3 crooked branches
      for (let j = 0; j < 3; j++) {
        const branchGeo = new THREE.CylinderGeometry(0.08, 0.15, 3.5, 6);
        const branchMesh = new THREE.Mesh(branchGeo, woodMat);
        branchMesh.position.set(
          (Math.random() - 0.5) * 0.8,
          5.0 + Math.random() * 2.0,
          (Math.random() - 0.5) * 0.8
        );
        branchMesh.rotation.set(
          (Math.random() - 0.5) * 0.8 + Math.PI / 4,
          Math.random() * Math.PI,
          (Math.random() - 0.5) * 0.8
        );
        treeGroup.add(branchMesh);
      }
      
      blenderWorldGroup.add(treeGroup);
    }
  }
}

function initMobileControls() {
  if (!isTouchDevice) return;
  
  // Show mobile controls panel and hide desktop legend
  document.getElementById('mobile-controls')?.classList.remove('hidden');
  document.getElementById('hud-controls-legend')?.classList.add('hidden');
  
  const handle = document.getElementById('joystick-handle');
  const ring = document.getElementById('joystick-ring');
  let joystickActive = false;
  let joystickStartPos = { x: 0, y: 0 };
  const joystickLimit = 35;
  
  let joystickTouchId = null;
  
  if (ring && handle) {
    ring.addEventListener('touchstart', e => {
      e.preventDefault();
      joystickActive = true;
      const touch = e.changedTouches[0];
      joystickTouchId = touch.identifier;
      const rect = ring.getBoundingClientRect();
      joystickStartPos = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
      e.stopPropagation();
    }, { passive: false });
    
    window.addEventListener('touchmove', e => {
      if (!joystickActive || joystickTouchId === null) return;
      
      let touch = null;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === joystickTouchId) {
          touch = e.changedTouches[i];
          break;
        }
      }
      if (!touch) return;
      
      let dx = touch.clientX - joystickStartPos.x;
      let dy = touch.clientY - joystickStartPos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist > joystickLimit) {
        dx = (dx / dist) * joystickLimit;
        dy = (dy / dist) * joystickLimit;
      }
      
      handle.style.transform = `translate(${dx}px, ${dy}px)`;
      
      state.moveForward = dy < -8;
      state.moveBackward = dy > 8;
      state.moveLeft = dx < -8;
      state.moveRight = dx > 8;
    }, { passive: true });
    
    const resetJoystick = (e) => {
      if (!joystickActive) return;
      
      if (e) {
        let touchFound = false;
        for (let i = 0; i < e.changedTouches.length; i++) {
          if (e.changedTouches[i].identifier === joystickTouchId) {
            touchFound = true;
            break;
          }
        }
        if (!touchFound) return;
      }
      
      joystickActive = false;
      joystickTouchId = null;
      handle.style.transform = 'translate(0px, 0px)';
      state.moveForward = false;
      state.moveBackward = false;
      state.moveLeft = false;
      state.moveRight = false;
    };
    
    window.addEventListener('touchend', resetJoystick);
    window.addEventListener('touchcancel', resetJoystick);
  }
  
  let touchStartLookId = null;
  let touchStartLookX = 0, touchStartLookY = 0;
  let touchStartEuler = new THREE.Euler(0, 0, 0, 'YXZ');
  
  window.addEventListener('touchstart', e => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.clientX > window.innerWidth * 0.4 && touchStartLookId === null) {
        touchStartLookId = touch.identifier;
        touchStartLookX = touch.clientX;
        touchStartLookY = touch.clientY;
        touchStartEuler.copy(camera.rotation);
      }
    }
  }, { passive: true });
  
  window.addEventListener('touchmove', e => {
    if (touchStartLookId === null) return;
    
    for (let i = 0; i < e.changedTouches.length; i++) {
      const touch = e.changedTouches[i];
      if (touch.identifier === touchStartLookId) {
        const dx = touch.clientX - touchStartLookX;
        const dy = touch.clientY - touchStartLookY;
        
        const sensitivity = 0.0035;
        camera.rotation.y = touchStartEuler.y - dx * sensitivity;
        camera.rotation.x = Math.max(-Math.PI / 2.2, Math.min(Math.PI / 2.2, touchStartEuler.x - dy * sensitivity));
        camera.rotation.z = 0;
      }
    }
  }, { passive: true });
  
  window.addEventListener('touchend', e => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touchStartLookId) {
        touchStartLookId = null;
        touchStartLookX = 0;
      }
    }
  });
  
  window.addEventListener('touchcancel', e => {
    for (let i = 0; i < e.changedTouches.length; i++) {
      if (e.changedTouches[i].identifier === touchStartLookId) {
        touchStartLookId = null;
        touchStartLookX = 0;
      }
    }
  });
  
  document.getElementById('m-btn-jump')?.addEventListener('touchstart', e => {
    e.preventDefault();
    const curGround = (config.worldMode === 'outdoor' ? getTerrainHeight(camera.position.x, camera.position.z) : 0) + PLAYER_HEIGHT;
    if (camera.position.y <= curGround + 0.25) {
      state.velocity.y = config.jumpStrength;
    }
  });
  
  document.getElementById('m-btn-graffiti')?.addEventListener('touchstart', e => {
    e.preventDefault();
    toggleGraffitiMode();
  });
  
  document.getElementById('m-btn-inventory')?.addEventListener('touchstart', e => {
    e.preventDefault();
    if (state.overlayOpen) {
      closeOverlay(state.overlayOpen);
    } else {
      openOverlay('overlay-inventory');
    }
  });
}
