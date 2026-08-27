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

    // Store items for lightbox navigation
    lightboxItems = items;
    currentCategory = category;

    items.forEach((item, index) => {
      const card = document.createElement('div');
      card.className = 'work-card';
      
      let mediaHtml = '';
      if (category === 'videos') {
        // Show thumbnail or first frame
        mediaHtml = `<video class="work-media" src="${item.url}" preload="metadata" muted playsinline></video>`;
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

      // Click to open fullscreen lightbox
      card.addEventListener('click', () => openLightbox(index));

      content.appendChild(card);
    });

  } catch (error) {
    console.error(error);
    content.innerHTML = '<p style="grid-column: 1/-1; text-align:center; color: #ff3333;">Erro ao carregar dados.</p>';
  }
}

// ═══════════════════════════════════════════
// FULLSCREEN LIGHTBOX
// ═══════════════════════════════════════════
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxVideo = document.getElementById('lightbox-video');
const lightboxTitle = document.getElementById('lightbox-title');
const lightboxDesc = document.getElementById('lightbox-desc');
const lightboxClose = document.getElementById('lightbox-close');
const lightboxPrev = document.getElementById('lightbox-prev');
const lightboxNext = document.getElementById('lightbox-next');

let lightboxItems = [];
let lightboxIndex = 0;
let currentCategory = '';

function openLightbox(index) {
  if (index < 0 || index >= lightboxItems.length) return;
  lightboxIndex = index;
  const item = lightboxItems[index];

  // Show/hide img vs video
  if (currentCategory === 'videos') {
    lightboxImg.style.display = 'none';
    lightboxVideo.style.display = 'block';
    lightboxVideo.src = item.url;
    lightboxVideo.play();
  } else {
    lightboxVideo.style.display = 'none';
    lightboxVideo.pause();
    lightboxImg.style.display = 'block';
    lightboxImg.src = item.url;
    lightboxImg.alt = item.title;
  }

  lightboxTitle.textContent = item.title || '';
  lightboxDesc.textContent = item.description || '';

  lightbox.classList.remove('hidden');

  // Hide nav arrows at edges
  lightboxPrev.style.display = index > 0 ? 'block' : 'none';
  lightboxNext.style.display = index < lightboxItems.length - 1 ? 'block' : 'none';
}

function closeLightbox() {
  lightbox.classList.add('hidden');
  lightboxVideo.pause();
  lightboxVideo.src = '';
}

lightboxClose.addEventListener('click', closeLightbox);
lightboxPrev.addEventListener('click', () => openLightbox(lightboxIndex - 1));
lightboxNext.addEventListener('click', () => openLightbox(lightboxIndex + 1));

// Click outside media to close
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox || e.target.classList.contains('lightbox-media-container')) {
    closeLightbox();
  }
});

// Keyboard navigation
document.addEventListener('keydown', (e) => {
  if (lightbox.classList.contains('hidden')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') openLightbox(lightboxIndex - 1);
  if (e.key === 'ArrowRight') openLightbox(lightboxIndex + 1);
});
