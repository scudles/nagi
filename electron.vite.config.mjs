import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.js') },
        // playwright 是 devDependency，externalizeDepsPlugin 不处理；保持运行时 require
        external: ['playwright', 'playwright-core']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.js') },
        output: { format: 'cjs', entryFileNames: 'index.cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    optimizeDeps: {
      include: ['pixi.js', 'pixi-live2d-display']
    }
  }
})
