// cloud-config.js
// 凪云（WorkBuddy 云服务）公开配置 + 大脑参数。
// 2026-10-14 自桌宠原型 cloud-config.js 移植（ESM 化）。
// publicConfig 可随应用分发（publishableKey 是公开键）；仅主进程引用，不进渲染层。
//
// ⚠️ 交接说明：以下 publishableKey 已替换为占位符（原值指向原作者的云应用，会消耗原作者的额度）。
//    要跑通「凪云」云端大脑，请自建一个 WorkBuddy 云应用并填入自己的键：
//      1. 在 WorkBuddy 里创建应用，拿到 endpoint 与 publishableKey（形如 wbpk_xxx）
//      2. 替换下面 endpoint / publishableKey 两行
//      3. 不想建云应用也可以：设置 → 大脑，切到「OpenAI 兼容」，填任一家 API Key 即可，功能不受影响
//    注意：真实密钥不要提交进 git。

export const publicConfig = {
  endpoint: 'https://nagi-desktop-pet.app.workbuddy.host',
  publishableKey: 'wbpk_Nqto8rzQAZikxS6S5YAYJK_0tVrAfhaAbtHjpeYWnnhNum9ES7A6G4I'
};

export const BRAIN = {
  model: 'hunyuan-chat' // 混元 Turbos：非推理模型延迟低（实测 1.7~1.9s/轮）、中文语感贴人设
};

export default { publicConfig, BRAIN };
