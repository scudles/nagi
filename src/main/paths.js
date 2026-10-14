// src/main/paths.js
// 统一的路径解析。主进程代码在 out/main 下运行，项目根为 ../..
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const projectRoot = join(__dirname, '..', '..')
export const modelsDir = join(projectRoot, 'models')
export const resourcesDir = join(projectRoot, 'resources')
