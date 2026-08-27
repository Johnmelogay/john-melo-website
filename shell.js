const iframe = document.getElementById('main-frame');
const scIframe = document.getElementById('sc-widget');
const playerBar = document.getElementById('player-bar');

// Player Elements
const playerArtwork = document.getElementById('player-artwork');
const playerTitle = document.getElementById('player-title');
const playerArtist = document.getElementById('player-artist');
const btnPlayPause = document.getElementById('btn-play-pause');
const iconPlay = document.getElementById('icon-play');
const iconPause = document.getElementById('icon-pause');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const progressBg = document.getElementById('progress-bg');
const progressFill = document.getElementById('progress-fill');

let scWidget = null;
let tracksData = [];
let currentIndex = -1;
let isPlaying = false;
let currentDuration = 0;

// Mobile Menu Toggle
const hamburgerBtn = document.getElementById('hamburger-btn');
const navLinks = document.getElementById('nav-links');

if (hamburgerBtn) {
  hamburgerBtn.addEventListener('click', () => {
    hamburgerBtn.classList.toggle('active');
    navLinks.classList.toggle('mobile-open');
  });
}

// Forward any parent interaction to cancel iframe autoplay
const parentInteractionEvents = ['touchstart', 'touchmove', 'touchend', 'pointerdown', 'wheel', 'mousedown'];
parentInteractionEvents.forEach(evt => {
  window.addEventListener(evt, () => {
    try {
      if (iframe.contentWindow && iframe.contentWindow.stopAutoPlay) {
        iframe.contentWindow.stopAutoPlay();
      }
    } catch (e) {}
  }, { passive: true });
});

// Global Navigate Function
window.navigate = function(url) {
  // Close mobile menu if open
  if (hamburgerBtn && hamburgerBtn.classList.contains('active')) {
    hamburgerBtn.classList.remove('active');
    navLinks.classList.remove('mobile-open');
  }

  iframe.src = url;
  
  // If navigating to 3D experience, pause 2D audio to prevent clash with 3D cassette player
  if (url.includes('experience.html') && isPlaying && scWidget) {
    scWidget.pause();
  }
};

window.navigateCategory = function(category) {
  // Close mobile menu if open
  if (hamburgerBtn && hamburgerBtn.classList.contains('active')) {
    hamburgerBtn.classList.remove('active');
    navLinks.classList.remove('mobile-open');
  }

  try {
    const iframeUrl = iframe.contentWindow.location.href;
    if (iframeUrl.includes('home.html')) {
      if (iframe.contentWindow.openCategory) {
        iframe.contentWindow.openCategory(category);
        return;
      }
    }
  } catch (e) {}

  iframe.src = `./home.html?cat=${category}`;
};

function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function initShellPlayer() {
  if (!window.SC) return;

  scWidget = SC.Widget(scIframe);

  scWidget.bind(SC.Widget.Events.READY, () => {
    scWidget.getSounds((sounds) => {
      tracksData = sounds || [];
      // If the iframe is currently audios.html, tell it we have tracks
      notifyIframeTracksLoaded();
    });
  });

  scWidget.bind(SC.Widget.Events.PLAY, () => {
    isPlaying = true;
    updatePlayState();
    scWidget.getCurrentSoundIndex((index) => {
      if (index !== currentIndex) {
        currentIndex = index;
        updatePlayerUI();
      }
    });
  });

  scWidget.bind(SC.Widget.Events.PAUSE, () => {
    isPlaying = false;
    updatePlayState();
  });

  scWidget.bind(SC.Widget.Events.FINISH, () => {
    if (currentIndex < tracksData.length - 1) {
      window.playTrack(currentIndex + 1);
    } else {
      isPlaying = false;
      updatePlayState();
    }
  });

  scWidget.bind(SC.Widget.Events.PLAY_PROGRESS, (progress) => {
    const currentMs = progress.currentPosition;
    timeCurrent.textContent = formatTime(currentMs);
    if (currentDuration > 0) {
      const percent = (currentMs / currentDuration) * 100;
      progressFill.style.width = `${percent}%`;
    }
  });
}

// Global API for the iframe (audios.html) to call
window.getTracksData = function() {
  return tracksData;
};

window.playTrack = function(index) {
  if (index < 0 || index >= tracksData.length) return;
  currentIndex = index;
  scWidget.skip(index);
  scWidget.play();
  playerBar.classList.remove('hidden');
  document.body.classList.add('has-player');
  updatePlayerUI();
  notifyIframeTrackChanged();
};

window.togglePlay = function() {
  if (scWidget) scWidget.toggle();
};

window.getCurrentIndex = function() {
  return currentIndex;
};

function notifyIframeTracksLoaded() {
  try {
    const iframeWindow = iframe.contentWindow;
    if (iframeWindow && iframeWindow.renderTrackList) {
      iframeWindow.renderTrackList();
    }
  } catch (e) {}
}

function notifyIframeTrackChanged() {
  try {
    const iframeWindow = iframe.contentWindow;
    if (iframeWindow && iframeWindow.highlightActiveTrack) {
      iframeWindow.highlightActiveTrack();
    }
  } catch (e) {}
}

iframe.addEventListener('load', () => {
  notifyIframeTracksLoaded();
  notifyIframeTrackChanged();
});

function updatePlayerUI() {
  if (currentIndex === -1 || !tracksData[currentIndex]) return;
  const track = tracksData[currentIndex];

  const artworkUrl = track.artwork_url ? track.artwork_url.replace('large', 't500x500') : './assets/face.png';
  playerArtwork.src = artworkUrl;
  playerTitle.textContent = track.title;
  playerArtist.textContent = track.user ? track.user.username : 'JOHN MELO';
  
  currentDuration = track.duration || 0;
  timeTotal.textContent = formatTime(currentDuration);
  timeCurrent.textContent = '0:00';
  progressFill.style.width = '0%';
}

function updatePlayState() {
  if (isPlaying) {
    iconPlay.style.display = 'none';
    iconPause.style.display = 'block';
  } else {
    iconPlay.style.display = 'block';
    iconPause.style.display = 'none';
  }
}

// Controls
btnPlayPause.addEventListener('click', () => {
  if (currentIndex === -1 && tracksData.length > 0) {
    window.playTrack(0);
  } else if (scWidget) {
    scWidget.toggle();
  }
});

btnPrev.addEventListener('click', () => {
  if (currentIndex > 0) window.playTrack(currentIndex - 1);
});

btnNext.addEventListener('click', () => {
  if (currentIndex < tracksData.length - 1) window.playTrack(currentIndex + 1);
});

progressBg.addEventListener('click', (e) => {
  if (currentDuration === 0 || !scWidget) return;
  const rect = progressBg.getBoundingClientRect();
  const percent = (e.clientX - rect.left) / rect.width;
  const seekToMs = percent * currentDuration;
  scWidget.seekTo(seekToMs);
});

window.addEventListener('load', initShellPlayer);
