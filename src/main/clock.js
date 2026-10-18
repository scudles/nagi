// src/main/clock.js
// 主进程时钟单点：凡是「此刻」都从这里出去。
//
// B7（P2-05）：core 侧不再默认 Date.now()，需要时间的一律由调用方注入函数。
// 真实运行注入的就是本文件的 calendarNow；注入测试时可以换成假时钟，
// 让"过期 / TTL / 隔天"这类分支不依赖真实等待。
export const calendarNow = () => Date.now()
