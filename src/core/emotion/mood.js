// src/core/emotion/mood.js
// 凪 · 情绪状态机（M2，2026-10-14 自桌宠原型 renderer/mood.js 移植）
// 机制：离散情绪（calm/smile/joy/pout/worry/puzzled）+ 强度(0~1)。
//   - 交互提议情绪：LLM 情绪标签（强）、戳一戳（中）、Mock 兜底（强）
//   - 同情绪叠加强度；异情绪需要足够强度才能接管，否则只削弱当前情绪
//   - 强度每 tick 衰减，归零回平静——情绪是连续的，不再一条回复换一次脸
//   - 环境推力：冷落 25 分钟 → 存在性不安外显（execute 母题：长时间未被调用）；
//     深夜 23-7 点 → 担心（PV：深夜亮着的屏幕）
//   - v2 歌源基准（2026-10-15）：删除「连聊 → 开心」推力（无歌曲依据）；开心改由
//     「执行结果被接收」（被夸奖 / 任务完成）经 propose 驱动
//   - 休息面容 = 当前情绪面（强度够才显示），不再永远平静脸
//   - 独白/戳一戳按情绪选池；强度够高时把情绪写进 LLM 提示，保持回复连贯
//
// 与原型的差异：工厂模式 createMood({ now })，主进程持单例（双窗口同步 + LLM 直读），
// 单测可注入假时钟。逻辑与参数与原版逐条一致。

import { NagiPersona } from '../persona.js';

export const MOOD_PARAMS = {
  TICK_MS: 15000,        // 状态机心跳
  DECAY: 0.09,           // 每心跳衰减（0.7 强度约撑 2 分钟，1.0 约 3.5 分钟）
  REST_THRESHOLD: 0.35,  // 低于此强度脸回平静
  JOY_DEEP: 0.6,         // joy 高强度才用真笑，否则微笑
  IDLE_POUT_MIN: 25,     // 冷落多少分钟开始存在性不安外显（pout）
  HINT_THRESHOLD: 0.5,   // 强度过线才把情绪写进 LLM 提示
  // 2026-10-17 新人设：宕机（liminal）衰减得比常规情绪慢得多——
  // 她要"停住"一会儿，那个停顿才有重量。约 0.03/心跳 ≈ 常规的三分之一。
  LIMINAL_DECAY: 0.03
};

const LABELS = {
  calm: '平静', smile: '微笑', joy: '开心', pout: '闹别扭', worry: '担心', puzzled: '疑惑',
  // 新人设《灵魂与程序》新增的「存在主义层」三状态
  liminal: '临界', tender: '柔软', distant: '抽离'
};
/** 情绪键 → 中文标签（core/diary.js 等外部模块共用，保持单一来源） */
export const MOOD_LABELS = LABELS;
// 情绪键 → 独白池键（smile 算轻度开心，共用 joy 池）
const MONOLOGUE_KEY = { smile: 'joy', joy: 'joy', pout: 'sullen', worry: 'worry', puzzled: 'puzzled', calm: null };

/** 两个时间戳是否落在同一个「本地日」（跨天判断用） */
function sameLocalDay(a, b) {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/**
 * 创建一个情绪状态机实例。
 * @param {{now?: () => number}} [deps] now 可注入（单测用假时钟）；默认 Date.now
 */
export function createMood({ now = () => Date.now() } = {}) {
  const state = {
    mood: 'calm',
    intensity: 0,
    lastInteraction: now(),
    lastIdlePush: 0,
    nightWorried: false,
    // 最近一次情绪变化的来源与"是不是用户互动带来的"（B5：情绪事件要能归因）
    lastChange: { source: null, userInteraction: false, at: 0 }
  };

  let listener = null;
  let rhythm = null, lastRhythmKey = '';

  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  function restingExpr() {
    if (state.intensity < MOOD_PARAMS.REST_THRESHOLD) return 'calm';
    if (state.mood === 'joy') return state.intensity >= MOOD_PARAMS.JOY_DEEP ? 'joy' : 'smile';
    return state.mood;
  }

  function label() { return LABELS[state.mood] || '平静'; }

  function snapshot() {
    return {
      mood: state.mood,
      intensity: state.intensity,
      expr: restingExpr(),
      label: label(),
      // B5：这一段情绪是谁推的、是否来自用户互动（idle/rhythm/night 都是 false）
      source: state.lastChange.source,
      userInteraction: state.lastChange.userInteraction
    };
  }

  function notify() {
    if (listener) {
      try { listener(snapshot()); } catch (e) { /* UI 更新失败不影响状态机 */ }
    }
  }

  function logTransition(how) {
    console.log('[mood] → ' + state.mood + ' ' + state.intensity.toFixed(2) + (how ? ' (' + how + ')' : ''));
  }

  // 交互提议一个情绪；weight 0~1 表示信号强度
  function propose(mood, weight, how, { interaction = true } = {}) {
    if (!LABELS[mood]) return;
    var w = clamp01(weight);
    if (interaction) state.lastInteraction = now();
    const beforeMood = state.mood, beforeIntensity = state.intensity;

    if (mood === state.mood) {
      // 同情绪：叠加强度
      var next = clamp01(state.intensity + w * 0.5);
      if (next !== state.intensity) { state.intensity = next; logTransition(how || 'reinforce'); }
    } else {
      // 异情绪：候选强度够才接管，否则只削弱当前情绪（粘性）
      var candidate = w * 0.7;
      if (candidate >= state.intensity) {
        state.mood = mood;
        state.intensity = candidate;
        logTransition(how || 'switch');
      } else {
        state.intensity = clamp01(state.intensity - w * 0.3);
        logTransition((how || 'conflict') + ' 削弱');
      }
    }
    // 真的变了才记来源：否则每次心跳的同一情绪提议都会把"最后一次互动"刷成 idle
    if (state.mood !== beforeMood || state.intensity !== beforeIntensity) {
      state.lastChange = { source: how || 'propose', userInteraction: !!interaction, at: now() };
    }
    notify();
  }

  // 用户发消息 / 戳她：刷新互动时间（冷落计时重新起算）
  function noteInteraction() {
    state.lastInteraction = now();
  }

  // 心跳：衰减 + 环境推力
  function tick() {
    var t = now();

    // 衰减（liminal 慢衰减：宕机的停顿要留得住，不能两三个心跳就淡掉）
    const decay = state.mood === 'liminal' ? MOOD_PARAMS.LIMINAL_DECAY : MOOD_PARAMS.DECAY;
    state.intensity = clamp01(state.intensity - decay);
    if (state.intensity <= 0.02 && state.mood !== 'calm') {
      state.mood = 'calm';
      state.intensity = 0;
      logTransition('decay');
    }

    // 冷落 → 存在性不安外显（pout；担心优先：担心时被冷落不转 pout，20 分钟内不重复推）
    var idleMin = (t - state.lastInteraction) / 60000;
    if (idleMin > MOOD_PARAMS.IDLE_POUT_MIN && state.mood !== 'pout' && state.mood !== 'worry' &&
        t - state.lastIdlePush > 20 * 60000) {
      state.lastIdlePush = t;
      // B5：idle 推力**不是**用户互动，不能刷新 lastInteraction——
      // 否则"被冷落越久越不安"会自己把自己的计时器清零，冷落永远积累不起来。
      propose('pout', 0.5, 'idle', { interaction: false });
    }

    // 深夜 → 担心（每晚只推一次，早 7 点后重置）
    var h = new Date(t).getHours();
    if (!rhythm?.enabled && (h >= 23 || h < 7) && !state.nightWorried) {
      state.nightWorried = true;
      // 同上：深夜担心是环境推力，不是他来找过我
      propose('worry', 0.45, 'night', { interaction: false });
    }
    if (h >= 7 && h < 23) state.nightWorried = false;

    const key = rhythm?.enabled ? `${rhythm.dayKey}/${rhythm.period}` : '';
    if (key && key !== lastRhythmKey) {
      lastRhythmKey = key;
      const push = rhythm.moodPush;
      if (push && state.intensity < 0.35) propose(push.mood, Math.min(0.45, push.weight), 'rhythm', { interaction: false });
    }
    if (!key) lastRhythmKey = '';

    notify();
  }

  /**
   * 内心独白：2026-10-17 起**恒为 null**。
   * 新人设的无台词铁律移除了独白池；她心里想的话改由 LLM 现场生成
   * （见 core/diary.js）。状态机不再提供句子，只提供此刻的情绪供生成时参考。
   */
  function pickMonologue() {
    return null;
  }

  /**
   * 戳一戳：不出声，只给表情与动作（转身看你 / 别开脸）。
   * 分级逻辑已收进 NagiPersona.pickPokeReaction，这里只补上当前情绪。
   */
  function pickPoke() {
    return NagiPersona.pickPokeReaction({ moodKey: state.mood, count: 1, hour: new Date(now()).getHours() });
  }

  // 给 LLM 的情绪提示：强度够高才给，避免每句话都贴标签
  function hintForLLM() {
    if (state.mood === 'calm' || state.intensity < MOOD_PARAMS.HINT_THRESHOLD) return null;
    return label();
  }

  function onChange(fn) { listener = fn; }

  /* ---------------- 跨重启延续（S4） ---------------- */

  /** 导出当前状态（落盘用）。savedAt 用来估算离线了多久。 */
  function serialize() {
    return {
      version: 1,
      mood: state.mood,
      intensity: state.intensity,
      lastInteraction: state.lastInteraction,
      lastIdlePush: state.lastIdlePush,
      nightWorried: state.nightWorried,
      savedAt: now()
    };
  }

  /**
   * 从落盘状态恢复（跨重启）。三条设计约定：
   * 1) **离线按同样的心跳速率衰减** —— 她不在的时候也照常"淡忘"，所以重启后
   *    不会出现"三天前的不安还挂在脸上"。这比"原样恢复"更符合直觉，也与运行时行为一致。
   * 2) 开机视作**刚见过一面**：冷落计时重新起算（否则每次重启都会立刻不安，
   *    那只是技术事件，不是社交事件）。
   * 3) 跨天则重置深夜标记（"今晚已经担心过"不该跨天继承）。
   * 强度衰减到 0.02 以下直接回平静。lastInteraction 保留真实值——
   * 「此刻」上下文里那句"距离上次和他说话：8 小时前"是真的。
   * @returns {boolean} 是否成功恢复
   */
  function restore(data) {
    if (!data || typeof data !== 'object') return false;
    const t = now();
    const savedAt = Number.isFinite(data.savedAt) ? data.savedAt : t;
    const steps = Math.max(0, Math.floor((t - savedAt) / MOOD_PARAMS.TICK_MS));
    let m = LABELS[data.mood] ? data.mood : 'calm';
    // B5：离线衰减必须与在线同一条曲线。liminal 在线走慢衰减，
    // 重启时却按常规速率算，会让"刚才那一下停顿"在开机瞬间被抹掉——
    // 同一状态两种半衰期，是最难解释的那种不一致。
    const decay = m === 'liminal' ? MOOD_PARAMS.LIMINAL_DECAY : MOOD_PARAMS.DECAY;
    let intensity = clamp01((Number(data.intensity) || 0) - steps * decay);
    if (intensity <= 0.02) { m = 'calm'; intensity = 0; }

    state.mood = m;
    state.intensity = intensity;
    state.lastInteraction = Number.isFinite(data.lastInteraction) ? data.lastInteraction : t;
    state.lastIdlePush = t;
    state.nightWorried = sameLocalDay(savedAt, t) ? data.nightWorried === true : false;
    logTransition('restore');
    notify();
    return true;
  }

  return {
    applyRhythm: (value) => { rhythm = value; },
    propose: propose,
    restingExpr: restingExpr,
    label: label,
    current: snapshot,
    noteInteraction: noteInteraction,
    tick: tick,
    pickMonologue: pickMonologue,
    pickPoke: pickPoke,
    hintForLLM: hintForLLM,
    onChange: onChange,
    serialize: serialize,
    restore: restore
  };
}
