import { initializeApp } from "firebase/app";
import { getDatabase, ref as dbRef, get } from "firebase/database";
import { firebaseConfig } from "./firebase-multiplayer.js";

// Initialize Firebase for read-only access
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

// DOM Elements
const modal = document.getElementById('gallery-modal');
const closeBtn = document.getElementById('gallery-close');
const title = document.getElementById('gallery-title');
const content = document.getElementById('gallery-content');
const cards = document.querySelectorAll('.nav-card[data-category]');

// SoundCloud Widget
const scIframe = document.getElementById('sc-widget');
let scWidget = null;
let currentPlayingIndex = -1;

// Setup SoundCloud
if (window.SC) {
  scWidget = SC.Widget(scIframe);
  scWidget.bind(SC.Widget.Events.PLAY, () => {
    updateAudioButtons(true);
  });
  scWidget.bind(SC.Widget.Events.PAUSE, () => {
    updateAudioButtons(false);
  });
}

// Event Listeners
closeBtn.addEventListener('click', () => {
  modal.classList.add('hidden');
  document.body.style.overflow = '';
  // Pause audio if modal is closed
  if (scWidget) scWidget.pause();
});

cards.forEach(card => {
  card.addEventListener('click', async (e) => {
    const isExperience = card.classList.contains('experience-card');
    if (isExperience) return; // let the standard link handle it

    e.preventDefault();
    const category = card.getAttribute('data-category');
    if (category === 'audios') {
      window.location.href = './audios.html';
      return;
    }

    title.textContent = category;
    
    // Reset state
    content.innerHTML = '<p style="grid-column: 1/-1; text-align:center;">Carregando...</p>';
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';

    await loadFirebaseCategory(category);
  });
});

// Load from Firebase Realtime Database
async function loadFirebaseCategory(category) {
  try {
    const categoryRef = dbRef(db, `portfolio_works/${category}`);
    const snapshot = await get(categoryRef);
    
    content.innerHTML = '';
    
    if (!snapshot.exists()) {
      content.innerHTML = '<p style="grid-column: 1/-1; text-align:center;">Nenhuma obra encontrada nesta categoria.</p>';
      return;
    }

    const data = snapshot.val();
    const items = Object.values(data).sort((a, b) => b.timestamp - a.timestamp); // newest first

    items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'work-card';
      
      let mediaHtml = '';
      if (category === 'videos') {
        mediaHtml = `<video class="work-media" src="${item.url}" controls playsinline></video>`;
      } else {
        mediaHtml = `<img class="work-media" src="${item.url}" alt="${item.title}" loading="lazy" />`;
      }

      card.innerHTML = `
        ${mediaHtml}
        <div class="work-info">
          <h3>${item.title}</h3>
          ${item.description ? `<p>${item.description}</p>` : ''}
        </div>
      `;
      content.appendChild(card);
    });

  } catch (error) {
    console.error(error);
    content.innerHTML = '<p style="grid-column: 1/-1; text-align:center; color: #ff3333;">Erro ao carregar dados.</p>';
  }
}

