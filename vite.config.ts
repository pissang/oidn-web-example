import { defineConfig } from 'vite';
import * as path from 'path';

export default defineConfig({
  server: {
    host: true,
    hmr: false
  },
  plugins: [],

  build: {
    index: path.resolve(__dirname, 'index.html')
  }
});
