import { defineConfig } from 'vite'

export default defineConfig({
  clearScreen: false,
  build: {
    target: 'esnext',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
