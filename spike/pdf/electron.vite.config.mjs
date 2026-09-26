import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: { build: { lib: { entry: 'src/main.js' } }, plugins: [externalizeDepsPlugin()] },
  preload: { build: { lib: { entry: 'src/preload.js' } }, plugins: [externalizeDepsPlugin()] },
  renderer: {
    root: 'src/renderer',
    build: { outDir: '../../out/renderer', emptyOutDir: true, rollupOptions: { input: 'src/renderer/index.html' }, assetsInlineLimit: 0 },
    publicDir: false
  }
})
