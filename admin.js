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

// ═══════════════════════════════════════════
// SMART CLIENT-SIDE IMAGE COMPRESSION
// ═══════════════════════════════════════════
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

async function compressImageFile(file, maxDimension = 2560, quality = 0.86) {
  // If not an image (e.g. video), return untouched
  if (!file.type.startsWith('image/')) {
    return { blob: file, originalSize: file.size, compressedSize: file.size, isCompressed: false, ext: file.name.split('.').pop() };
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let width = img.width;
        let height = img.height;

        // Proportional scale to max dimension (maintains razor sharp details up to 2.5K)
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        // Convert to high-efficiency WebP
        canvas.toBlob((blob) => {
          if (!blob || blob.size >= file.size) {
            // Keep original if somehow larger
            resolve({ blob: file, originalSize: file.size, compressedSize: file.size, isCompressed: false, ext: file.name.split('.').pop() });
          } else {
            resolve({
              blob: blob,
              originalSize: file.size,
              compressedSize: blob.size,
              isCompressed: true,
              ext: 'webp'
            });
          }
        }, 'image/webp', quality);
      };

      img.onerror = () => resolve({ blob: file, originalSize: file.size, compressedSize: file.size, isCompressed: false, ext: file.name.split('.').pop() });
      img.src = e.target.result;
    };
    reader.onerror = () => resolve({ blob: file, originalSize: file.size, compressedSize: file.size, isCompressed: false, ext: file.name.split('.').pop() });
    reader.readAsDataURL(file);
  });
}

// ═══════════════════════════════════════════
// FORM SUBMISSION
// ═══════════════════════════════════════════
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
      const rawFile = fileInput.files[0];
      if (!rawFile) {
        showStatus('Nenhum arquivo selecionado.', 'error');
        submitBtn.disabled = false;
        return;
      }

      let uploadBlob = rawFile;
      let fileExt = rawFile.name.split('.').pop().toLowerCase();

      // Compress if it's an image
      if (rawFile.type.startsWith('image/')) {
        showStatus('Comprimindo imagem sem perda de qualidade...', '');
        const compression = await compressImageFile(rawFile);
        uploadBlob = compression.blob;
        fileExt = compression.ext;

        if (compression.isCompressed) {
          const reduction = Math.round((1 - compression.compressedSize / compression.originalSize) * 100);
          showStatus(`Otimizado: ${formatBytes(compression.originalSize)} ➔ ${formatBytes(compression.compressedSize)} (-${reduction}%). Enviando...`, '');
        } else {
          showStatus('Iniciando upload do arquivo...', '');
        }
      } else {
        showStatus('Iniciando upload do arquivo...', '');
      }

      const baseName = rawFile.name.replace(/\.[^/.]+$/, "").replace(/[^a-z0-9]/gi, '_').toLowerCase();
      const filePath = `portfolio_works/${category}/${Date.now()}_${baseName}.${fileExt}`;
      const fileRef = storageRef(storage, filePath);

      const uploadTask = uploadBytesResumable(fileRef, uploadBlob, {
        contentType: uploadBlob.type || (fileExt === 'webp' ? 'image/webp' : undefined)
      });

      await new Promise((resolve, reject) => {
        uploadTask.on('state_changed',
          (snapshot) => {
            const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
            showStatus(`Enviando: ${Math.round(progress)}% (${formatBytes(snapshot.bytesTransferred)} / ${formatBytes(snapshot.totalBytes)})`, '');
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

    showStatus('SUCESSO! Obra adicionada com alta performance.', 'success');
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
