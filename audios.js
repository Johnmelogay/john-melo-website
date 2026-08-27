// audios.js - Runs inside the iframe, communicates with shell.js in parent
// Also fetches individual tracks uploaded via CMS from Firebase

import { initializeApp } from "firebase/app";
import { getDatabase, ref as dbRef, get } from "firebase/database";
import { firebaseConfig } from "./firebase-multiplayer.js";

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

const trackListContainer = document.getElementById('track-list');
const bgBlur = document.getElementById('bg-blur');

// Section for CMS-uploaded tracks
let cmsTracksData = [];

// Render tracks from the parent SoundCloud widget
window.renderTrackList = function() {
  if (!window.parent || !window.parent.getTracksData) return;
  
  const tracksData = window.parent.getTracksData();
  
  // Clear and rebuild
  trackListContainer.innerHTML = '';

  // First: render CMS tracks (uploaded via SYS_UPLOAD)
  if (cmsTracksData.length > 0) {
    const cmsHeader = document.createElement('h2');
    cmsHeader.className = 'section-header';
    cmsHeader.textContent = 'UPLOADED TRACKS';
    trackListContainer.appendChild(cmsHeader);

    cmsTracksData.forEach((track, index) => {
      const item = document.createElement('div');
      item.className = 'audio-grid-item cms-track';
      item.id = `cms-track-${index}`;

      item.innerHTML = `
        <div class="audio-grid-artwork cms-artwork">
          <svg viewBox="0 0 24 24" fill="white" width="40" height="40"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55C7.79 13 6 14.79 6 17s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
        </div>
        <div class="audio-grid-info">
          <h3>${track.title}</h3>
          <p>${track.year || 'JOHN MELO'}</p>
        </div>
      `;

      item.addEventListener('click', () => {
        // Open the SoundCloud link in the parent's widget
        if (window.parent && window.parent.loadSoundCloudUrl) {
          window.parent.loadSoundCloudUrl(track.url);
        } else {
          // Fallback: open in new tab
          window.open(track.url, '_blank');
        }
      });

      trackListContainer.appendChild(item);
    });
  }

  // Second: render SoundCloud playlist tracks
  if (tracksData.length > 0) {
    if (cmsTracksData.length > 0) {
      const scHeader = document.createElement('h2');
      scHeader.className = 'section-header';
      scHeader.textContent = 'PERPETUALIZATION';
      trackListContainer.appendChild(scHeader);
    }

    tracksData.forEach((track, index) => {
      const artworkUrl = track.artwork_url ? track.artwork_url.replace('large', 't500x500') : './assets/face.png';
      const artist = track.user ? track.user.username : 'JOHN MELO';

      const item = document.createElement('div');
      item.className = 'audio-grid-item';
      item.id = `track-${index}`;
      
      item.innerHTML = `
        <img src="${artworkUrl}" alt="Artwork" class="audio-grid-artwork" loading="lazy" />
        <div class="audio-grid-info">
          <h3>${track.title}</h3>
          <p>${artist}</p>
        </div>
      `;

      item.addEventListener('click', () => {
        const currentIndex = window.parent.getCurrentIndex();
        if (currentIndex === index) {
          window.parent.togglePlay();
        } else {
          window.parent.playTrack(index);
        }
      });

      trackListContainer.appendChild(item);
    });
  }

  if (tracksData.length === 0 && cmsTracksData.length === 0) {
    trackListContainer.innerHTML = '<div class="loading-state">NENHUMA FAIXA ENCONTRADA.</div>';
  }

  window.highlightActiveTrack();
};

window.highlightActiveTrack = function() {
  if (!window.parent || !window.parent.getCurrentIndex) return;
  
  const currentIndex = window.parent.getCurrentIndex();
  const tracksData = window.parent.getTracksData();

  document.querySelectorAll('.audio-grid-item').forEach(el => el.classList.remove('playing'));
  
  if (currentIndex !== -1 && tracksData[currentIndex]) {
    const activeItem = document.getElementById(`track-${currentIndex}`);
    if (activeItem) activeItem.classList.add('playing');
    
    const track = tracksData[currentIndex];
    const artworkUrl = track.artwork_url ? track.artwork_url.replace('large', 't500x500') : './assets/face.png';
    bgBlur.style.backgroundImage = `url(${artworkUrl})`;
  }
};

// Fetch CMS audio tracks from Firebase
async function loadCMSAudios() {
  try {
    const audiosRef = dbRef(db, 'portfolio_works/audios');
    const snapshot = await get(audiosRef);
    
    if (snapshot.exists()) {
      const data = snapshot.val();
      cmsTracksData = Object.values(data).sort((a, b) => b.timestamp - a.timestamp);
    }
  } catch (err) {
    console.warn('Could not load CMS audios:', err);
  }
}

// Initial render
window.addEventListener('load', async () => {
  await loadCMSAudios();
  
  if (window.parent && window.parent.getTracksData) {
    if (window.parent.getTracksData().length > 0 || cmsTracksData.length > 0) {
      window.renderTrackList();
    }
  } else if (cmsTracksData.length > 0) {
    window.renderTrackList();
  }
});
