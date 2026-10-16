import { createPresenceHooks } from '../core/presence/hooks.js'
export const presenceHooks=createPresenceHooks()
export const {registerVoiceParamsProvider,registerProactiveProvider,subscribePresenceEvents,subscribeActionTraces}=presenceHooks
