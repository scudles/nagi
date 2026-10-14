// src/main/paths.js
// 统一的路径解析。
//   dev：主进程代码在 out/main 下运行，项目根为 ../..（源码目录）。
//   打包：代码被压进 app.asar，模型/资源由 electron-builder 的 extraResources
//         释放到 process.resourcesPath（app.asar 的同级），必须分开解析——
//         否则模型会被解析到 app.asar 内部，nagi-local 协议读不到、Live2D 加载失败。
import { app } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const packaged = app.isPackaged

export const projectRoot = packaged ? app.getAppPath() : join(__dirname, '..', '..')
export const modelsDir = packaged ? join(process.resourcesPath, 'models') : join(projectRoot, 'models')
export const resourcesDir = packaged ? join(process.resourcesPath, 'resources') : join(projectRoot, 'resources')
