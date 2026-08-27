import { initializeApp } from "firebase/app";
import { getDatabase, ref as dbRef, push, set } from "firebase/database";
import { getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { firebaseConfig } from "./firebase-multiplayer.js";

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getDatabase(app);
const storage = getStorage(app);

// DOM Elements
const form = document.getElementById('upload-form');
const submitBtn = document.getElementById('submit-btn');
const statusDiv = document.getElementById('status');
const categorySelect = document.getElementById('category');

// Dynamic form groups
const groupSoundcloud = document.getElementById('group-soundcloud');
const groupMediaToggle = document.getElementById('group-media-toggle');
const groupFile = document.getElementById('group-file');
const groupLink = document.getElementById('group-link');

// Toggle buttons
const toggleUpload = document.getElementById('toggle-upload');
const toggleLink = document.getElementById('toggle-link');

let mediaMode = 'upload'; // 'upload' or 'link'

// Toggle media source
toggleUpload.addEventListener('click', () => {
  mediaMode = 'upload';
  toggleUpload.classList.add('active');
  toggleLink.classList.remove('active');
  groupFile.classList.remove('hidden');
  groupLink.classList.add('hidden');
});

toggleLink.addEventListener('click', () => {
  mediaMode = 'link';
  toggleLink.classList.add('active');
  toggleUpload.classList.remove('active');
  groupLink.classList.remove('hidden');
  groupFile.classList.add('hidden');
});

// Category change handler
categorySelect.addEventListener('change', updateFormUI);
updateFormUI(); // Initialize on load

function updateFormUI() {
  const cat = categorySelect.value;

  if (cat === 'audios') {
    // Audio: show SoundCloud link, hide file/link toggle
    groupSoundcloud.classList.remove('hidden');
    groupMediaToggle.classList.add('hidden');
    groupFile.classList.add('hidden');
    groupLink.classList.add('hidden');
  } else {
    // Non-audio: show file/link toggle
    groupSoundcloud.classList.add('hidden');
    groupMediaToggle.classList.remove('hidden');
    
    if (mediaMode === 'upload') {
      groupFile.classList.remove('hidden');
      groupLink.classList.add('hidden');
    } else {
      groupFile.classList.add('hidden');
      groupLink.classList.remove('hidden');
    }

    // Update hint text for videos
    const linkHint = document.getElementById('link-hint');
    if (cat === 'videos') {
      linkHint.textContent = 'Cole o link do YouTube ou URL direta do vídeo.';
    } else {
      linkHint.textContent = 'Cole o link público da imagem.';
    }
  }
}

// Form submission
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const category = categorySelect.value;
  const title = document.getElementById('title').value;
  const year = document.getElementById('year').value;
  const description = document.getElementById('description').value;

  submitBtn.disabled = true;

  try {
    let url = '';
    let sourceType = '';

    if (category === 'audios') {
      // Audio: use SoundCloud link directly
      url = document.getElementById('soundcloud-link').value;
      if (!url) {
        showStatus('Cole o link do SoundCloud.', 'error');
        submitBtn.disabled = false;
        return;
      }
      sourceType = 'soundcloud';
      showStatus('Salvando dados...', '');

    } else if (mediaMode === 'link') {
      // Public link mode
      url = document.getElementById('public-link').value;
      if (!url) {
        showStatus('Cole o link público.', 'error');
        submitBtn.disabled = false;
        return;
      }
      sourceType = 'link';
      showStatus('Salvando dados...', '');

    } else {
      // File upload mode
      const fileInput = document.getElementById('file');
      const file = fileInput.files[0];
      if (!file) {
        showStatus('Nenhum arquivo selecionado.', 'error');
        submitBtn.disabled = false;
        return;
      }

      showStatus('Iniciando upload do arquivo...', '');

      const safeName = file.name.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
      const filePath = `portfolio_works/${category}/${Date.now()}_${safeName}`;
      const fileRef = storageRef(storage, filePath);

      const uploadTask = uploadBytesResumable(fileRef, file);

      await new Promise((resolve, reject) => {
        uploadTask.on('state_changed',
          (snapshot) => {
            const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            showStatus(`Enviando arquivo: ${Math.round(progress)}%`, '');
          },
          (error) => {
            console.error("Erro no upload:", error);
            showStatus('Erro no upload. Verifique as regras do Storage no Firebase.', 'error');
            reject(error);
          },
          async () => {
            url = await getDownloadURL(uploadTask.snapshot.ref);
            sourceType = 'file';
            resolve();
          }
        );
      });
    }

    // Save to Realtime Database
    showStatus('Salvando no banco de dados...', '');
    const categoryRef = dbRef(db, `portfolio_works/${category}`);
    const newWorkRef = push(categoryRef);

    const entry = {
      title: title,
      year: year || '',
      description: description,
      url: url,
      sourceType: sourceType,
      timestamp: Date.now()
    };

    await set(newWorkRef, entry);

    showStatus('SUCESSO! A obra foi adicionada ao sistema.', 'success');
    form.reset();
    updateFormUI();
    submitBtn.disabled = false;

  } catch (err) {
    console.error(err);
    showStatus('Erro desconhecido. Verifique o console.', 'error');
    submitBtn.disabled = false;
  }
});

function showStatus(msg, type) {
  statusDiv.textContent = msg;
  statusDiv.className = type;
}
