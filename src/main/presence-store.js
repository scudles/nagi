// 独立的 opt-in 状态文件；无 timer、无导入时 IO，不删除原文件再替换。
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
export function createPresenceStore(directory) {
  const file=join(directory,'presence.json'), temp=file+'.tmp'
  return {
    load() {
      if(!existsSync(file))return null
      if(statSync(file).size>512*1024)throw new Error('模拟活动文件超出上限')
      const data=JSON.parse(readFileSync(file,'utf8'))
      if(data?.version!==1)throw new Error('不支持的模拟活动数据版本')
      return data
    },
    save(data) {
      const text=JSON.stringify(data)
      if(Buffer.byteLength(text)>512*1024)throw new Error('模拟活动数据超出上限')
      mkdirSync(directory,{recursive:true})
      try {writeFileSync(temp,text,'utf8');renameSync(temp,file)}
      finally {if(existsSync(temp))unlinkSync(temp)}
    },
    clear() {for(const target of [file,temp])if(existsSync(target))unlinkSync(target)}
  }
}
