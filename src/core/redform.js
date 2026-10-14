// src/core/redform.js
// 「去掉红色形态」的纯逻辑：判断某模型是否要裁掉红色辉光，以及从参数表里挑出红色参数。
// 抽成纯函数是为了能单测——渲染层（live2d.js）只负责在正确的时刻调用它。
//
// 背景：该模型的"红色形态"（闹别扭 / 生气 / 狂暴 / 红眼发光 / 扔剪刀 时整屏泛红）
// 完全由 ParamRed* 一族参数驱动——偏离 0 就发红（正值亮红、负值暗红）。
// 裁剪它不需要删任何模型资源，逐帧把这些参数压回 0 即可。

/**
 * 该模型是否要裁掉红色形态。
 * 默认**开启**（这样即使模型配置缺失也符合"不要红色形态"的既定要求）；
 * 模型目录的 nagi-emotion.json 里写 `"removeRedGlow": false` 可单独放行。
 * @param {object|null|undefined} overrideMap nagi-emotion.json 的内容（可能不存在）
 */
export function shouldRemoveRedGlow(overrideMap) {
  return overrideMap?.removeRedGlow !== false
}

/**
 * 从参数名列表里挑出红色形态相关参数。
 * 用 /Red/i 匹配即可覆盖整族：ParamRedGlow / RedGlowMove / RedGlowSway /
 * RedGlowSway2 / RedGlowPhysics(2/3) / RedHighlight。
 * @param {Iterable<string>} ids
 * @returns {string[]}
 */
export function pickRedParams(ids) {
  try {
    return Array.from(ids || []).filter((id) => /Red/i.test(String(id)))
  } catch {
    return []
  }
}
