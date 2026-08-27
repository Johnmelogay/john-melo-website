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

// Open Category Modal Function
window.openCategory = async function(category) {
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
};

// Check query param or hash on initial load
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const cat = params.get('cat');
  if (cat) {
    setTimeout(() => {
      window.openCategory(cat);
    }, 100);
  }
});

cards.forEach(card => {
  card.addEventListener('click', async (e) => {
    const isExperience = card.classList.contains('experience-card');
    if (isExperience) return; // let the standard link handle it

    const isAbout = card.getAttribute('data-category') === 'about';
    if (isAbout) return; // let standard link handle it

    e.preventDefault();
    const category = card.getAttribute('data-category');
    window.openCategory(category);
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
        if (isYouTubeUrl(item.url)) {
          // YouTube: use thumbnail image
          const thumb = getYouTubeThumbnail(item.url);
          mediaHtml = `<img class="work-media" src="${thumb}" alt="${item.title}" loading="lazy" />`;
        } else {
          // Direct video: autoplay muted loop
          mediaHtml = `<video class="work-media" src="${item.url}" autoplay muted loop playsinline></video>`;
        }
      } else {
        mediaHtml = `<img class="work-media" src="${item.url}" alt="${item.title}" loading="lazy" decoding="async" />`;
      }

      card.innerHTML = `
        ${mediaHtml}
        <div class="work-info">
          <h3>${item.title}</h3>
          ${item.year ? `<p>${item.year}</p>` : ''}
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
// YOUTUBE HELPERS
// ═══════════════════════════════════════════
function getYouTubeId(url) {
  if (!url) return null;
  const regExp = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
  const match = url.match(regExp);
  return match ? match[1] : null;
}

function isYouTubeUrl(url) {
  return getYouTubeId(url) !== null;
}

function getYouTubeThumbnail(url) {
  const id = getYouTubeId(url);
  return id ? `https://img.youtube.com/vi/${id}/hqdefault.jpg` : null;
}

// ═══════════════════════════════════════════
// FULLSCREEN LIGHTBOX
// ═══════════════════════════════════════════
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxVideo = document.getElementById('lightbox-video');
const lightboxYt = document.getElementById('lightbox-yt');
const lightboxTitle = document.getElementById('lightbox-title');
const lightboxDesc = document.getElementById('lightbox-desc');
const lightboxClose = document.getElementById('lightbox-close');
const lightboxPrev = document.getElementById('lightbox-prev');
const lightboxNext = document.getElementById('lightbox-next');

let lightboxItems = [];
let lightboxIndex = 0;
let currentCategory = '';

function hideAllMedia() {
  lightboxImg.style.display = 'none';
  lightboxVideo.style.display = 'none';
  lightboxVideo.pause();
  lightboxYt.style.display = 'none';
  lightboxYt.src = '';
}

function openLightbox(index) {
  if (index < 0 || index >= lightboxItems.length) return;
  lightboxIndex = index;
  const item = lightboxItems[index];

  hideAllMedia();

  if (currentCategory === 'videos') {
    if (isYouTubeUrl(item.url)) {
      // YouTube embed
      const ytId = getYouTubeId(item.url);
      lightboxYt.src = `https://www.youtube.com/embed/${ytId}?autoplay=1&rel=0`;
      lightboxYt.style.display = 'block';
    } else {
      // Direct video file
      lightboxVideo.src = item.url;
      lightboxVideo.style.display = 'block';
      lightboxVideo.play();
    }
  } else {
    lightboxImg.src = item.url;
    lightboxImg.alt = item.title;
    lightboxImg.style.display = 'block';
  }

  lightboxTitle.textContent = item.title || '';
  const descParts = [];
  if (item.year) descParts.push(item.year);
  if (item.description) descParts.push(item.description);
  lightboxDesc.textContent = descParts.join(' — ');

  lightbox.classList.remove('hidden');

  // Hide nav arrows at edges
  lightboxPrev.style.display = index > 0 ? 'block' : 'none';
  lightboxNext.style.display = index < lightboxItems.length - 1 ? 'block' : 'none';
}

function closeLightbox() {
  lightbox.classList.add('hidden');
  hideAllMedia();
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

