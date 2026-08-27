// audios.js - Runs inside the iframe, communicates with shell.js in parent

const trackListContainer = document.getElementById('track-list');
const bgBlur = document.getElementById('bg-blur');

window.renderTrackList = function() {
  if (!window.parent || !window.parent.getTracksData) return;
  
  const tracksData = window.parent.getTracksData();
  trackListContainer.innerHTML = '';
  
  if (tracksData.length === 0) {
    trackListContainer.innerHTML = '<div class="loading-state">NENHUMA FAIXA ENCONTRADA NA PLAYLIST.</div>';
    return;
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

// Initial render if tracks are already loaded in parent
window.addEventListener('load', () => {
  if (window.parent && window.parent.getTracksData) {
    if (window.parent.getTracksData().length > 0) {
      window.renderTrackList();
    }
  }
});
