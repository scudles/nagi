export const PRESENCE_IPC = { STATUS: 'presence:get', CLEAR: 'presence:clear' }
export const PRESENCE_EVENT = 'presence:changed'
export const PERIODS = ['night', 'morning', 'noon', 'afternoon', 'evening']
export const ACTIVITY_TYPES = ['simulated-reading', 'simulated-reflection', 'quiet-wait']
export const PRESENCE_DEFAULTS = {
  enabled: true, rhythmEnabled: true, awayEnabled: true, reunionEnabled: true,
  persistActivities: false, voiceProfileEnabled: false,
  idleAfterMs: 120000, activitySliceMs: 300000,
  reunionMinMs: 300000, reunionLongMs: 1800000, reunionHoursMs: 5400000,
  reunionCooldownMs: 1800000, dailyReunionLimit: 3,
  retainDays: 7, maxActivities: 96,
  weekdaySchedule: [[0,420,'night'],[420,720,'morning'],[720,780,'noon'],[780,1020,'afternoon'],[1020,1380,'evening'],[1380,1440,'night']],
  weekendSchedule: [[0,480,'night'],[480,720,'morning'],[720,780,'noon'],[780,1020,'afternoon'],[1020,1380,'evening'],[1380,1440,'night']],
  notesEnabled: false, externalNotesEnabled: false, tracesEnabled: false, anchorsEnabled: false,
  /** 外部便签目录：**必须由用户亲自用系统目录选择器选出来**，不接受手填路径 */
  notesExternalDir: '',
  haRules: { enabled: false, rules: [] },
  imperfection: { enabled: false, forgetProbability: 0, lowPressureEnabled: false, repairEnabled: false }
}
