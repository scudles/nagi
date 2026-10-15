// src/core/rag/wordpiece.js
// BERT WordPiece 分词器的纯 JS 实现（零依赖，可单测）。
//
// 为什么不用 @huggingface/tokenizers：那个包现在的版本是纯 JS 重写版（无 fromFile、
// 覆盖度存疑），而老的 WASM 版已不再发布。BERT 的 BasicTokenizer + WordPieceTokenizer
// 是 HuggingFace 源码里不到 150 行、规则完全确定的逻辑，自己实现反而更可控——
// 能拿真实 vocab 做逐 token 断言，也不引入任何原生/WASM 依赖。
//
// 实现对齐 HF transformers 的 tokenization_bert.py（bge-small-zh-v1.5 的
// tokenizer.json 配置：BertNormalizer{clean_text, handle_chinese_chars,
// lowercase=false} + BertPreTokenizer + WordPiece{##, [UNK], 100}）。

const PAD_TOKEN = '[PAD]'
const UNK_TOKEN = '[UNK]'
const CLS_TOKEN = '[CLS]'
const SEP_TOKEN = '[SEP]'

/** CJK 统一表意文字各区段（HF _is_chinese_char 的判定） */
function isChineseChar(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

/**
 * 标点判定：ASCII 标点四段 + 中日韩标点/全角区段。
 * （HF 用 unicodedata.category 的 P*；JS 没有内置，这两段覆盖了中文文本的绝大多数情形；
 *  其余的（如拉丁扩展标点）不拆也不会影响中文检索。）
 */
export function isPunctuation(cp) {
  if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) {
    return true
  }
  return (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0xff00 && cp <= 0xffef)
}

/** 清掉控制字符（保留 \t \n \r），其余空白归一为空格（HF _clean_text） */
export function cleanText(text) {
  let out = ''
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0)
    if (cp === 0 || cp === 0xfffd) continue
    if (cp < 32 && cp !== 9 && cp !== 10 && cp !== 13) continue // C0 控制符（保留 \t \n \r）
    if (cp === 127 || (cp >= 0x80 && cp <= 0x9f)) continue // DEL 与 C1 控制符
    out += cp === 32 || (cp >= 9 && cp <= 13) ? ' ' : ch
  }
  return out
}

/** 把每个 CJK 字用空格包起来（「你好」→「你 好」）——中文按字切的前提 */
export function tokenizeChineseChars(text) {
  let out = ''
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0)
    if (isChineseChar(cp)) out += ' ' + ch + ' '
    else out += ch
  }
  return out
}

/** 在标点两侧加空格后按空白切（HF _run_split_on_punc） */
export function splitOnPunctuation(text) {
  const chars = Array.from(String(text))
  const out = []
  let cur = ''
  const flush = () => {
    if (cur) out.push(cur)
    cur = ''
  }
  for (const ch of chars) {
    if (isPunctuation(ch.codePointAt(0))) {
      flush()
      out.push(ch)
    } else {
      cur += ch
    }
  }
  flush()
  return out
}

/**
 * BasicTokenizer：清洗 → 中文分字 → 空白切 → 标点切 → （可选）小写。
 * @returns {string[]}
 */
export function basicTokenize(text, { lowercase = false } = {}) {
  let t = cleanText(text)
  t = tokenizeChineseChars(t)
  const tokens = []
  for (const piece of t.split(/\s+/)) {
    if (!piece) continue
    for (const sub of splitOnPunctuation(piece)) {
      if (!sub) continue
      tokens.push(lowercase ? sub.toLowerCase() : sub)
    }
  }
  return tokens
}

/**
 * WordPiece 贪心最长匹配（HF wordpiece_tokenize）。
 * @param {string} token 单个 basic token
 * @param {(s:string)=>number|undefined} vocabGet 词表查询（查不到返回 undefined）
 * @param {{unkToken?:string, maxInputChars?:number, prefix?:string}} [opts]
 * @returns {string[]}
 */
export function wordpieceTokenize(token, vocabGet, opts = {}) {
  const unk = opts.unkToken || UNK_TOKEN
  const maxChars = opts.maxInputChars || 100
  const prefix = opts.prefix || '##'
  const chars = Array.from(token)
  if (chars.length === 0) return []
  if (chars.length > maxChars) return [unk]
  const out = []
  let start = 0
  while (start < chars.length) {
    let end = chars.length
    let cur = null
    while (start < end) {
      let sub = chars.slice(start, end).join('')
      if (start > 0) sub = prefix + sub
      if (vocabGet(sub) !== undefined) {
        cur = sub
        break
      }
      end -= 1
    }
    if (cur === null) return [unk] // 有一个片段对不上，整词判 UNK
    out.push(cur)
    start = end
  }
  return out
}

export class WordPieceTokenizer {
  /**
   * @param {{vocab:Object, unkToken?:string, clsToken?:string, sepToken?:string, padToken?:string, lowercase?:boolean, maxInputChars?:number}} cfg
   */
  constructor(cfg) {
    this.vocab = cfg.vocab || {}
    this.unkToken = cfg.unkToken || UNK_TOKEN
    this.clsToken = cfg.clsToken || CLS_TOKEN
    this.sepToken = cfg.sepToken || SEP_TOKEN
    this.padToken = cfg.padToken || PAD_TOKEN
    this.lowercase = cfg.lowercase === true
    this.maxInputChars = cfg.maxInputChars || 100
    this.prefix = '##'
  }

  /** 从 tokenizer.json（HF 1.0 格式）构造 */
  static fromJSON(json) {
    const model = json?.model || {}
    const vocab = model.vocab || {}
    const norm = json?.normalizer || {}
    return new WordPieceTokenizer({
      vocab,
      unkToken: model.unk_token || UNK_TOKEN,
      clsToken: '[CLS]',
      sepToken: '[SEP]',
      lowercase: norm.lowercase === true,
      maxInputChars: model.max_input_chars_per_word || 100
    })
  }

  lookup(token) {
    const id = this.vocab[token]
    return typeof id === 'number' ? id : undefined
  }

  /** 不带特殊符号的 token id 序列 */
  tokenIds(text) {
    const ids = []
    for (const tok of basicTokenize(text, { lowercase: this.lowercase })) {
      for (const piece of wordpieceTokenize(tok, (s) => this.lookup(s), {
        unkToken: this.unkToken,
        maxInputChars: this.maxInputChars,
        prefix: this.prefix
      })) {
        const id = this.lookup(piece)
        ids.push(id === undefined ? this.lookup(this.unkToken) ?? 100 : id)
      }
    }
    return ids
  }

  /**
   * 编码成 ONNX 三件套：[CLS] … [SEP]，type_ids 全 0，mask 全 1。
   * @param {string} text
   * @param {{maxLength?:number, addSpecial?:boolean}} [opts]
   * @returns {{ids:number[], typeIds:number[], attentionMask:number[]}}
   */
  encode(text, opts = {}) {
    const maxLength = opts.maxLength || 512
    const addSpecial = opts.addSpecial !== false
    const cls = this.lookup(this.clsToken) ?? 101
    const sep = this.lookup(this.sepToken) ?? 102
    let body = this.tokenIds(text)
    const limit = addSpecial ? maxLength - 2 : maxLength
    if (body.length > limit) body = body.slice(0, limit)
    const ids = addSpecial ? [cls, ...body, sep] : body
    return {
      ids,
      typeIds: ids.map(() => 0),
      attentionMask: ids.map(() => 1)
    }
  }

  /** 反查（调试用）：去掉 ## 连回去 */
  decode(ids) {
    const pieces = []
    for (const id of ids) {
      const tok = Object.keys(this.vocab).find((k) => this.vocab[k] === id)
      if (!tok) continue
      if (tok === this.clsToken || tok === this.sepToken || tok === this.padToken) continue
      pieces.push(tok.startsWith(this.prefix) ? tok.slice(this.prefix.length) : ' ' + tok)
    }
    return pieces.join('').replace(/^ /, '')
  }
}
