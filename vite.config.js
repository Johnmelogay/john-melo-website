import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './', // Use relative paths for static assets so it deploys seamlessly on GitHub Pages
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        home: resolve(__dirname, 'home.html'),
        experience: resolve(__dirname, 'experience.html'),
        admin: resolve(__dirname, 'admin.html'),
        audios: resolve(__dirname, 'audios.html'),
        about: resolve(__dirname, 'about.html')
      }
    }
  }
});
