// audios.js - Runs inside the iframe, communicates with shell.js in parent
// Fetches CMS tracks from Firebase and merges with SoundCloud playlist

import { initializeApp } from "firebase/app";
import { getDatabase, ref as dbRef, get } from "firebase/database";
import { firebaseConfig } from "./firebase-multiplayer.js";

const firebaseApp = initializeApp(firebaseConfig);
const db = getDatabase(firebaseApp);

const trackListContainer = document.getElementById('track-list');
const bgBlur = document.getElementById('bg-blur');

let cmsTracksData = [];

// Fetch artwork from SoundCloud oEmbed API
async function fetchSCArtwork(scUrl) {
  try {
    const resp = await fetch(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(scUrl)}`);
    if (resp.ok) {
      const data = await resp.json();
      return data.thumbnail_url || './assets/face.png';
    }
  } catch (e) {}
  return './assets/face.png';
}

window.renderTrackList = function() {
  const scTracks = (window.parent && window.parent.getTracksData) ? window.parent.getTracksData() : [];
  
  trackListContainer.innerHTML = '';

  if (scTracks.length === 0 && cmsTracksData.length === 0) {
    trackListContainer.innerHTML = '<div class="loading-state">NENHUMA FAIXA ENCONTRADA.</div>';
    return;
  }

  // Render CMS tracks first (these are individual SoundCloud links uploaded via CMS)
  cmsTracksData.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = 'audio-grid-item cms-track';
    item.id = `cms-track-${index}`;
    item.dataset.scUrl = track.url;

    // Placeholder artwork, will be replaced async
    item.innerHTML = `
      <img src="./assets/face.png" alt="Artwork" class="audio-grid-artwork" loading="lazy" data-cms-art="${index}" />
      <div class="audio-grid-info">
        <h3>${track.title}</h3>
        <p>${track.year || 'JOHN MELO'}</p>
      </div>
    `;

    // Fetch real artwork async
    fetchSCArtwork(track.url).then(artUrl => {
      const img = item.querySelector(`[data-cms-art="${index}"]`);
      if (img) img.src = artUrl;
    });

    item.addEventListener('click', () => {
      if (window.parent && window.parent.loadSoundCloudUrl) {
        window.parent.loadSoundCloudUrl(track.url);
      } else {
        window.open(track.url, '_blank');
      }
    });

    trackListContainer.appendChild(item);
  });

  // Render SoundCloud playlist tracks
  scTracks.forEach((track, index) => {
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
