export const PRESENCE_IPC = { STATUS: 'presence:get', CLEAR: 'presence:clear' }
export const PRESENCE_EVENT = 'presence:changed'
export const PERIODS = ['night', 'morning', 'noon', 'afternoon', 'evening']
export const ACTIVITY_TYPES = ['simulated-reading', 'simulated-reflection', 'quiet-wait']
export const PRESENCE_DEFAULTS = {
  enabled: true, rhythmEnabled: true, awayEnabled: true, reunionEnabled: true,
  // persistActivities 保持 false：独处活动默认只留内存，落盘属隐私向，需用户主动开（D49）
  persistActivities: false, voiceProfileEnabled: true,
  idleAfterMs: 120000, activitySliceMs: 300000,
  reunionMinMs: 300000, reunionLongMs: 1800000, reunionHoursMs: 5400000,
  reunionCooldownMs: 1800000, dailyReunionLimit: 3,
  retainDays: 7, maxActivities: 96,
  weekdaySchedule: [[0,420,'night'],[420,720,'morning'],[720,780,'noon'],[780,1020,'afternoon'],[1020,1380,'evening'],[1380,1440,'night']],
  weekendSchedule: [[0,480,'night'],[480,720,'morning'],[720,780,'noon'],[780,1020,'afternoon'],[1020,1380,'evening'],[1380,1440,'night']],
  // 活人感默认全开（D49）。externalNotesEnabled 是唯一例外：必须用户亲自选目录，不能默认开。
  notesEnabled: true, externalNotesEnabled: false, tracesEnabled: true, anchorsEnabled: true,
  /** 外部便签目录：**必须由用户亲自用系统目录选择器选出来**，不接受手填路径 */
  notesExternalDir: '',
  haRules: { enabled: false, rules: [] },
  // forgetProbability 默认 2%：绝不能默认 0 —— 开关勾着而概率为 0，界面显示「已开启」
  // 却一次都不生效，这是 D49 修掉的「假开」。
  imperfection: { enabled: true, forgetProbability: 0.02, lowPressureEnabled: true, repairEnabled: true }
}
