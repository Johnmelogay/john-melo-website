import { initializeApp } from "firebase/app";
import { getDatabase, ref, set, onValue, onChildAdded, onDisconnect, remove, runTransaction } from "firebase/database";

// ==========================================
// CONFIGURAÇÃO DO FIREBASE (VEM DO USUÁRIO)
// ==========================================
// Você precisará substituir estes valores pelas credenciais do seu projeto Firebase!
// No Console do Firebase: Project Settings > General > Your apps (Web)
export let firebaseConfig = {
  apiKey: "AIzaSyA4aDjt43x-QK4-816Zitv_1uX4lemhXOw",
  authDomain: "perpetualization.firebaseapp.com",
  databaseURL: "https://perpetualization-default-rtdb.firebaseio.com",
  projectId: "perpetualization",
  storageBucket: "perpetualization.firebasestorage.app",
  messagingSenderId: "851261654834",
  appId: "1:851261654834:web:8829ad95626414224fb92b",
  measurementId: "G-CT64RQFG5T"
};

let app;
let db;
let playerId;
let isInitialized = false;

let playerName = "AGENTE";

// Gera um ID único aleatório para esta sessão
function generateId() {
  return Math.random().toString(36).substring(2, 9);
}

export function initMultiplayer(config, name = "AGENTE") {
  if (config) {
    firebaseConfig = config;
  }
  playerName = name;
  
  if (firebaseConfig.apiKey.includes("COLE_AQUI")) {
    console.warn("Multiplayer desativado: Configuração do Firebase não encontrada. Edite firebase-multiplayer.js ou chame initMultiplayer com as credenciais reais.");
    return false;
  }

  try {
    app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    playerId = 'player_' + generateId();
    isInitialized = true;
    console.log("Firebase Multiplayer Iniciado. ID:", playerId);

    // Quando o jogador fechar a aba, remova-o do banco de dados automaticamente
    const playerRef = ref(db, `players/${playerId}`);
    onDisconnect(playerRef).remove();
    
    // Adiciona o jogador inicialmente
    set(playerRef, {
      x: 0, y: 0, z: 0, rotY: 0, lastUpdate: Date.now(), name: playerName
    });

    return true;
  } catch (e) {
    console.error("Erro ao inicializar Firebase:", e);
    return false;
  }
}

export function updateLocalPlayer(x, y, z, rotY, score = 0) {
  if (!isInitialized) return;
  const playerRef = ref(db, `players/${playerId}`);
  set(playerRef, {
    x: x,
    y: y,
    z: z,
    rotY: rotY,
    lastUpdate: Date.now(),
    name: playerName,
    score: score
  });
}

export function listenToPlayers(callback) {
  if (!isInitialized) return;
  const playersRef = ref(db, 'players');
  onValue(playersRef, (snapshot) => {
    const data = snapshot.val();
    callback(data, playerId);
  });
}

export function broadcastGraffiti(x, y, z, nx, ny, nz, brush, size, targetId = null) {
  if (!isInitialized) return;
  const grafId = 'graf_' + generateId() + '_' + Date.now();
  const grafRef = ref(db, `graffiti/${grafId}`);
  
  set(grafRef, {
    x, y, z, nx, ny, nz, brush, size,
    owner: playerId,
    targetId: targetId,
    timestamp: Date.now()
  });
}

export function listenToGraffiti(callback) {
  if (!isInitialized) return;
  const grafRef = ref(db, 'graffiti');
  onChildAdded(grafRef, (snapshot) => {
    const data = snapshot.val();
    callback(data);
  });
}

export function listenToSaturation(callback) {
  if (!isInitialized) return;
  const satRef = ref(db, 'global_saturation');
  onValue(satRef, (snapshot) => {
    let val = snapshot.val();
    if (val === null) val = 0;
    callback(val);
  });
}

export function incrementGlobalSaturation(amount = 0.5) {
  if (!isInitialized) return;
  const satRef = ref(db, 'global_saturation');
  runTransaction(satRef, (currentVal) => {
    if (currentVal === null) currentVal = 0;
    let newVal = currentVal + amount;
    if (newVal > 100) newVal = 100;
    return newVal;
  });
}

export function getPlayerId() {
  return playerId;
}
