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

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  
  const category = document.getElementById('category').value;
  const title = document.getElementById('title').value;
  const description = document.getElementById('description').value;
  const fileInput = document.getElementById('file');
  const file = fileInput.files[0];

  if (!file) {
    showStatus('Nenhum arquivo selecionado.', 'error');
    return;
  }

  submitBtn.disabled = true;
  showStatus('Iniciando upload do arquivo...', '');

  try {
    // 1. Criar referência no Storage
    // Exemplo: portfolio_works/artworks/16900000_nome-do-arquivo.jpg
    const safeName = file.name.replace(/[^a-z0-9.]/gi, '_').toLowerCase();
    const filePath = `portfolio_works/${category}/${Date.now()}_${safeName}`;
    const fileRef = storageRef(storage, filePath);

    // 2. Fazer o Upload
    const uploadTask = uploadBytesResumable(fileRef, file);

    uploadTask.on('state_changed', 
      (snapshot) => {
        const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
        showStatus(`Enviando arquivo: ${Math.round(progress)}%`, '');
      }, 
      (error) => {
        console.error("Erro no upload:", error);
        showStatus('Erro no upload. Verifique as regras do Storage no Firebase.', 'error');
        submitBtn.disabled = false;
      }, 
      async () => {
        // Upload completou com sucesso!
        showStatus('Upload concluído! Salvando dados...', '');
        
        // 3. Pegar URL pública do arquivo
        const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);

        // 4. Salvar no Realtime Database
        const categoryRef = dbRef(db, `portfolio_works/${category}`);
        const newWorkRef = push(categoryRef); // Cria um ID único automaticamente
        
        await set(newWorkRef, {
          title: title,
          description: description,
          url: downloadURL,
          fileName: file.name,
          timestamp: Date.now()
        });

        showStatus('SUCESSO! A obra foi adicionada ao sistema.', 'success');
        form.reset();
        submitBtn.disabled = false;
      }
    );

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
