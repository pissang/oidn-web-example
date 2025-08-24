import { defineConfig } from 'vite';
import * as path from 'path';

export default defineConfig({
  server: {
    host: true,
    hmr: false
  },
  plugins: [],

  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        webgpu: path.resolve(__dirname, 'webgpu.html'),
        'three-gpu-pathtracer': path.resolve(
          __dirname,
          'three-gpu-pathtracer.html'
        )
      }
    }
  }
});
