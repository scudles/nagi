// cloud-config.js
// 凪云（WorkBuddy 云服务）公开配置 + 大脑参数。
// 2026-10-14 自桌宠原型 cloud-config.js 移植（ESM 化）。
// publicConfig 可随应用分发（publishableKey 是公开键）；仅主进程引用，不进渲染层。

export const publicConfig = {
  endpoint: 'https://nagi-desktop-pet.app.workbuddy.host',
  publishableKey: 'wbpk_Nqto8rzQAZikxS6S5YAYJK_0tVrAfhaAbtHjpeYWnnhNum9ES7A6G4I'
};

export const BRAIN = {
  model: 'hunyuan-chat' // 混元 Turbos：非推理模型延迟低（实测 1.7~1.9s/轮）、中文语感贴人设
};

export default { publicConfig, BRAIN };
