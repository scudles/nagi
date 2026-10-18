// src/core/persist-io.js
// 原子落盘的纯逻辑：写临时文件 → rename 一次性替换。fs 由调用方注入，可单测。
//
// 背景（B01）：旧实现是「写 tmp → unlink 原文件 → rename」，两步之间任何中断
// （崩溃/断电/杀进程）都会让原文件已经没了、tmp 还没上位——用户的记忆/历史/
// 情绪/关系/RAG 档案直接归零。POSIX rename(2) 与 Windows MoveFileExW
// (MOVEFILE_REPLACE_EXISTING) 本身就是单次原子操作，先删那一步纯属自找窗口。
//
// 本模块只做决策与执行，不引 electron、不引 node:path（分隔符由调用方的路径负责）。

/** 取错误消息（不吞异常类型，方便日志判断） */
function msg(err) {
  return err && err.message ? err.message : String(err)
}

/**
 * 原子写入（同步）。payload 为 string 或 Buffer。
 *
 * 调用序列恒为：writeFileSync(tmp) → renameSync(tmp, file)。
 * 任何失败路径都**不碰原文件**——失败的结果是"停留在上一版"，而不是空。
 *
 * @param {object} fs node:fs 子集：{ writeFileSync, renameSync, existsSync, unlinkSync }
 * @param {string} file 目标文件绝对路径
 * @param {string|Buffer} payload 已序列化的内容
 * @returns {{ok:true} | {ok:false, stage:'write'|'rename', error:string, tmpCleaned?:boolean}}
 */
export function atomicWriteSync(fs, file, payload) {
  const tmp = `${file}.tmp`
  try {
    fs.writeFileSync(tmp, payload)
  } catch (err) {
    return { ok: false, stage: 'write', error: `临时文件写入失败：${msg(err)}` }
  }
  try {
    fs.renameSync(tmp, file)
    return { ok: true }
  } catch (err) {
    // rename 失败：原文件保持上一版完好（原子写的全部意义就在这），顺手清掉半截 tmp
    let tmpCleaned = false
    try {
      if (fs.existsSync(tmp)) {
        fs.unlinkSync(tmp)
        tmpCleaned = true
      }
    } catch{ /* B8:degrade — 临时文件清理失败，原始错误会照常抛出 */ }
    return { ok: false, stage: 'rename', error: `替换失败：${msg(err)}`, tmpCleaned }
  }
}

/**
 * 原子写 JSON。序列化失败与落盘失败都走返回值，绝不抛。
 * @returns {{ok:true} | {ok:false, stage:'json'|'write'|'rename', error:string, tmpCleaned?:boolean}}
 */
export function atomicWriteJsonSync(fs, file, data, indent = 2) {
  let payload
  try {
    payload = JSON.stringify(data, null, indent)
  } catch (err) {
    return { ok: false, stage: 'json', error: `序列化失败：${msg(err)}` }
  }
  return atomicWriteSync(fs, file, payload)
}
