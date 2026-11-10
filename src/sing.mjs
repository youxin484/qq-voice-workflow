#!/usr/bin/env node
// 点歌 → 真的唱：搜索 → 试几个候选 → 下载 → 截段 → 分离人声/伴奏 → RVC 换成指定音色 → 混伴奏 → 发 QQ 语音
//
// 硬规矩：唱歌必须「人声 + 伴奏」一起发；分离不出伴奏就换下一个候选，绝不发干声。
//
// 用法：
//   node sing.mjs --song "朋友的酒" [--start 50] [--dur 30] [--target private:675173024] [--model 模型.pth] [--no-send]
//
// 依赖：bili-cli（搜索）、yt-dlp（下载）、RVC 包（ffmpeg / UVR5 / 变声）
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// 数据根目录（参考音频 ref/、产物 audio/generated/ 都在它下面）。
// 默认取本仓库的上一级目录，可用 QQ_BRIDGE_ROOT 覆盖。
const BRIDGE = process.env.QQ_BRIDGE_ROOT ?? path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const RVC = process.env.RVC_ROOT ?? 'D:\\RVC\\RVC1006Nvidia'
const PY = path.join(RVC, 'runtime', 'python.exe')
const FFMPEG = path.join(RVC, 'ffmpeg.exe')
const FFPROBE = path.join(RVC, 'ffprobe.exe')
const YTDLP = process.env.YTDLP_PATH ?? 'C:\\yt-dlp\\yt-dlp.exe'
const BILI = process.env.BILI_PATH ?? path.join(os.homedir(), '.bili-cli', 'venv2', 'Scripts', 'bili.exe')
const BILI_HOME = process.env.BILI_CLI_HOME ?? path.join(os.homedir(), '.bili-cli', 'home')
const MODEL = process.env.RVC_MODEL ?? 'Roxy.pth'
const INDEX = process.env.RVC_INDEX
  ?? path.join(RVC, 'assets', 'indices', 'Roxy.index')
const GEN = path.join(BRIDGE, 'audio', 'generated')
const WORK = path.join(RVC, 'song')

const argv = process.argv.slice(2)
const arg = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback }
const has = (name) => argv.includes(name)

const song = arg('--song', '')
const target = arg('--target', 'private:675173024')
const dur = Math.max(10, Math.min(58, Number(arg('--dur', '30')) || 30))
const noSend = has('--no-send')
const model = arg('--model', MODEL)
// 人声引擎：rvc = 直接在原唱人声上换声（保旋律，默认）；gsv = 用 GPT-SoVITS v2ProPlus 念唱歌词
const engine = String(arg('--engine', process.env.SING_ENGINE ?? 'rvc')).toLowerCase()
const ASR_PY = process.env.ASR_PY ?? 'D:\\asr\\venv\\Scripts\\python.exe'
const TTS_URL = process.env.GPT_SOVITS_URL ?? 'http://127.0.0.1:9880'
if (!song) { console.error('用法: node sing.mjs --song "歌名" [--start 50] [--dur 45] [--target private:QQ] [--no-send]'); process.exit(2) }

const log = (m) => console.log(`[sing] ${m}`)
const run = (file, args, opts = {}) => {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 900_000, ...opts })
  if (r.status !== 0) throw new Error(`${path.basename(file)} 失败: ${String(r.stderr ?? '').slice(-300)}`)
  return r
}
const probe = (file) => {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], { encoding: 'utf8', windowsHide: true })
  const first = String(r.stdout ?? '').split(String.fromCharCode(10))[0]
  const v = Number(first.trim())
  return Number.isFinite(v) && v > 0 ? v : 0
}


const refText = () => {
  try { return fs.readFileSync(path.join(BRIDGE, 'ref', 'REF_TEXT.txt'), 'utf8').trim() } catch { return '' }
}
const refLang = () => {
  try {
    const v = fs.readFileSync(path.join(BRIDGE, 'ref', 'REF_LANG.txt'), 'utf8').trim().toLowerCase()
    return /^[a-z_]{2,8}$/.test(v) ? v : 'zh'
  } catch { return 'zh' }
}

/**
 * 用 GPT-SoVITS 唱：先把原唱人声转写成逐句歌词（带时间戳），
 * 再让 GSV 按洛琪希的音色逐句念唱，拉伸/平移贴回原曲的时间点，最后交给外层混伴奏。
 * 说明：GSV 是 TTS，没有音高控制，所以这是「念唱」——旋律由伴奏决定，人声只负责音色和字。
 */
async function renderGsvVocal(vocalPath, outPath) {
  const asrScript = path.join(BRIDGE, 'scripts', 'asr.py')
  log('识别歌词与时间点（faster-whisper）…')
  const rr = spawnSync(ASR_PY, [asrScript, vocalPath, '--segments', '--max-chars', '0', '--language', 'zh'], {
    encoding: 'utf8', windowsHide: true, timeout: 900_000,
  })
  const line = String(rr.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  let asr = null
  try { asr = JSON.parse(line) } catch { /* 下面统一报错 */ }
  if (!asr?.ok) throw new Error(`歌词识别失败：${asr?.error ?? String(rr.stderr ?? '').slice(-200)}`)
  const segs = (asr.segments ?? []).filter((x) => String(x.text ?? '').trim())
  if (!segs.length) throw new Error('没识别出歌词（可能是纯音乐）')

  // 合并成 ≤14 段，每段 2~4 秒，避免一句一次 HTTP 把点歌拖到几分钟
  const chunks = []
  for (const seg of segs) {
    const text = String(seg.text).trim()
    const last = chunks[chunks.length - 1]
    const longEnough = last && (last.end - last.start) >= 2.4 && last.text.length >= 8
    if (last && !longEnough && chunks.length <= 14) {
      last.text += text
      last.end = seg.end
    } else {
      chunks.push({ start: seg.start, end: seg.end, text })
    }
  }
  if (chunks.length > 14) chunks.length = 14

  log(`逐句合成（${chunks.length} 段，GSV ${TTS_URL}）…`)
  const lineDir = path.join(WORK, 'gsv-lines')
  fs.mkdirSync(lineDir, { recursive: true })
  for (const f of fs.readdirSync(lineDir)) fs.rmSync(path.join(lineDir, f), { force: true })

  const files = []
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]
    const res = await fetch(`${TTS_URL}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: chunk.text,
        text_lang: 'zh',
        ref_audio_path: path.join(BRIDGE, 'ref', 'reference.wav'),
        prompt_text: refText(),
        prompt_lang: refLang(),
        media_type: 'wav',
        streaming_mode: false,
      }),
      signal: AbortSignal.timeout(180_000),
    })
    if (!res.ok) throw new Error(`GSV 合成失败 HTTP ${res.status}：${(await res.text()).slice(0, 160)}`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 2000) throw new Error(`GSV 返回过小（${buf.length} 字节）`)
    const f = path.join(lineDir, `line-${i}.wav`)
    fs.writeFileSync(f, buf)
    files.push({ file: f, ...chunk })
  }

  // 逐句拉伸到原曲该句的时长，再按原始起点平移
  const total = Math.max(...chunks.map((c) => c.end), 1)
  const parts = []
  const inputs = []
  files.forEach((item, i) => {
    const srcDur = probe(item.file) || 1
    const targetDur = Math.max(0.4, item.end - item.start)
    const tempo = Math.max(0.8, Math.min(1.3, srcDur / targetDur))
    const delayMs = Math.round(item.start * 1000)
    inputs.push('-i', item.file)
    parts.push(`[${i}:a]atempo=${tempo.toFixed(3)},adelay=${delayMs}|${delayMs}[a${i}]`)
  })
  if (files.length === 1) {
    // 只有一句时不用 amix（这个 ffmpeg 构建的 amix 还带不了 normalize 参数）
    parts.push(`[a0]atrim=0:${total.toFixed(2)},apad=whole_dur=${total.toFixed(2)}[v]`)
  } else {
    const mixIn = files.map((_, i) => `[a${i}]`).join('')
    parts.push(`${mixIn}amix=inputs=${files.length}:duration=longest,atrim=0:${total.toFixed(2)},apad=whole_dur=${total.toFixed(2)}[v]`)
  }

  log('把歌词贴回原曲时间轴…')
  run(FFMPEG, ['-y', ...inputs, '-filter_complex', parts.join(';'), '-map', '[v]', '-ac', '1', '-ar', '44100', outPath])
  if (!fs.existsSync(outPath)) throw new Error('GSV 人声轨生成失败')
  return outPath
}

fs.mkdirSync(WORK, { recursive: true })
fs.mkdirSync(GEN, { recursive: true })

// ── 1) 搜索 ────────────────────────────────────────────────────────────────
log(`搜索「${song}」…`)
const s = spawnSync(BILI, ['search', 'video', song], {
  encoding: 'utf8', windowsHide: true, timeout: 120_000,
  env: { ...process.env, BILI_CLI_HOME: BILI_HOME },
})
if (s.status !== 0) throw new Error(`bili 搜索失败: ${String(s.stderr ?? s.stdout ?? '').slice(-200)}`)
const line = String(s.stdout ?? '').split(/\r?\n/).find((l) => l.trim().startsWith('{'))
if (!line) throw new Error('bili 搜索没有返回 JSON')
const parsed = JSON.parse(line)
if (!parsed.ok) throw new Error(`bili 搜索出错: ${parsed.error?.message ?? parsed.error?.code}`)
const items = parsed.data?.items ?? []
if (!items.length) throw new Error(`没搜到「${song}」`)

// 筛掉 DJ/循环/歌单/合集/伴奏 这类（时长离谱、没人声），限制 90–480 秒
const BAD = /DJ|循环|歌单|合集|串烧|伴奏|纯音乐|remix|mix|翻唱|cover|教学|reaction/i
const durSec = (v) => {
  const p = String(v ?? '').split(':').map(Number)
  if (p.some((n) => !Number.isFinite(n))) return 0
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0] || 0
}
const scored = items.map((i) => ({ ...i, sec: durSec(i.duration) }))
const usable = scored.filter((i) => !BAD.test(String(i.title)) && i.sec >= 90 && i.sec <= 480)
const pool = (usable.length ? usable : scored.filter((i) => i.sec >= 60 && i.sec <= 600))
  .sort((a, b) => (String(b.title).includes(song) ? 1 : 0) - (String(a.title).includes(song) ? 1 : 0) || (b.play ?? 0) - (a.play ?? 0))
if (!pool.length) throw new Error(`「${song}」没搜到合适的原曲（都是 DJ/合集/太长）`)
log(`候选 ${Math.min(3, pool.length)} 个：${pool.slice(0, 3).map((i) => String(i.title).slice(0, 20)).join(' | ')}`)

// ── 2) 逐个候选尝试（失败就换下一个，保证"点歌就能唱"）──────────────────────
let lastError = null
for (const cand of pool.slice(0, 3)) {
  const bvid = cand.bvid
  const url = `https://www.bilibili.com/video/${bvid}`
  try {
    log(`尝试：${cand.title}（${bvid}，${cand.duration}）`)

    // 下载
    const raw = path.join(WORK, `${bvid}.wav`)
    if (!fs.existsSync(raw)) {
      log('下载音频…')
      run(YTDLP, ['-f', 'bestaudio', '-x', '--audio-format', 'wav', '--ffmpeg-location', RVC, '--no-playlist', '-o', `${WORK}\\${bvid}.%(ext)s`, url])
    }

    // 先截段（45 秒），再分离 —— 整首分离太慢
    const total = probe(raw)
    const start = arg('--start', '') !== '' ? Number(arg('--start')) : Math.max(0, Math.min(90, Math.round(total * 0.25)))
    const segMix = path.join(WORK, `seg-mix-${bvid}.wav`)
    log(`截取 ${start}s 起 ${dur}s（原长 ${total.toFixed(1)}s）`)
    run(FFMPEG, ['-y', '-ss', String(start), '-t', String(dur), '-i', raw, '-ac', '2', '-ar', '44100', '-sample_fmt', 's16', segMix])

    // 分离（uvr() 会扫描整个输入目录，必须用只放这一首的独立目录）
    // 分离和变声都吃显卡，先把本地聊天模型请出显存（40k 上下文的 8B 要 8 GB，叠上去必 OOM）。
    // 关掉：OLLAMA_UNLOAD=0。
    if (process.env.OLLAMA_UNLOAD !== '0') {
      const ollamaUrl = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
      const chatModel = process.env.OLLAMA_CHAT_MODEL ?? 'qq-local:8b'
      // 显存够 UVR5 + RVC 用（约 6 GB）就别卸载了：卸载 + 轮询最多白等 18 秒。
      const freeMiB = (() => {
        try {
          const r = spawnSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 4000, windowsHide: true })
          const first = String(r.stdout ?? '').split(String.fromCharCode(10))[0]
          const v = Number(first.trim())
          return Number.isFinite(v) ? v : null
        } catch { return null }
      })()
      if (freeMiB !== null && freeMiB >= Number(process.env.SING_MIN_FREE_MIB ?? 6000)) {
        log(`显存充足（${freeMiB} MiB），不打扰本地聊天模型`)
      } else try {
        await fetch(`${ollamaUrl}/api/generate`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: chatModel, keep_alive: 0 }),
          signal: AbortSignal.timeout(5000),
        })
        for (let i = 0; i < 12; i += 1) {
          const ps = await fetch(`${ollamaUrl}/api/ps`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null)
          if (!(ps?.models ?? []).some((m) => String(m.name ?? m.model ?? '').startsWith(chatModel))) break
          await new Promise((r) => setTimeout(r, 1500))
        }
        log('已把本地聊天模型请出显存')
      } catch { log('（Ollama 未运行，跳过显存清理）') }
    }

    const vocalDir = path.join(WORK, 'vocal')
    const instrDir = path.join(WORK, 'instr')
    const inDir = path.join(WORK, 'in', bvid)
    fs.mkdirSync(inDir, { recursive: true })
    for (const f of fs.readdirSync(inDir)) fs.rmSync(path.join(inDir, f), { force: true })
    for (const d of [vocalDir, instrDir]) {
      try { for (const f of fs.readdirSync(d)) { if (f.includes(bvid)) fs.rmSync(path.join(d, f), { force: true }) } } catch {}
    }
    fs.copyFileSync(segMix, path.join(inDir, `${bvid}.wav`))
    log('分离人声 / 伴奏（UVR5）…')
    run(PY, ['tools\\uvr_cli.py', inDir, `${bvid}.wav`, vocalDir, instrDir, 'HP2_all_vocals', '10'], { cwd: RVC })

    const vocal = fs.readdirSync(vocalDir).filter((f) => f.startsWith(`vocal_${bvid}`) && f.endsWith('.wav')).sort().pop()
    const instr = fs.readdirSync(instrDir).filter((f) => f.startsWith(`instrument_${bvid}`) && f.endsWith('.wav')).sort().pop()
    if (!vocal) throw new Error('没分离出人声')
    if (!instr) throw new Error('没分离出伴奏（可能是清唱/纯人声视频）')

    // 变声：先测源人声的基频，再决定升/降几个半音
    // （固定 +12 会把女声原曲顶到 900Hz 以上，模型直接破音 —— 这就是"高音上不去"）
    const f0info = (() => {
      try {
        const rr = spawnSync(PY, [path.join(RVC, 'tools', 'f0probe.py'), path.join(vocalDir, vocal)], { encoding: 'utf8', windowsHide: true, timeout: 180_000 })
        const last = String(rr.stdout ?? '').trim().split(/\r?\n/).pop()
        return JSON.parse(last)
      } catch { return null }
    })()
    let f0up
    const explicitF0 = arg('--f0up', '')
    if (explicitF0 !== '') f0up = Number(explicitF0)
    else if (Number.isFinite(Number(process.env.RVC_F0UP)) && process.env.RVC_F0UP !== '') f0up = Number(process.env.RVC_F0UP)
    else if (f0info?.ok) {
      // 自动定调：中位音高拉到目标附近，同时把 p95 压在模型上限以内
      const numOr = (v, d) => { const n = Number(v); return Number.isFinite(n) && String(v ?? '') !== '' ? n : d }
      const TARGET = numOr(process.env.RVC_TARGET_F0, 325)   // 想要的输出中位音高（Hz）
      const CAP = numOr(process.env.RVC_MAX_F0, 640)         // 模型能稳的上限（Hz）
      const MIN_K = numOr(process.env.RVC_MIN_SHIFT, -6)     // 最多降几个半音
      const MAX_K = numOr(process.env.RVC_MAX_SHIFT, 12)     // 最多升几个半音
      let k = Math.round(12 * Math.log2(TARGET / f0info.p50))
      k = Math.max(MIN_K, Math.min(MAX_K, k))
      while (k > MIN_K && f0info.p95 * Math.pow(2, k / 12) > CAP) k -= 1
      f0up = k
      log(`音高自适应：源 p50=${f0info.p50.toFixed(0)}Hz p95=${f0info.p95.toFixed(0)}Hz，目标 ${TARGET}Hz/上限 ${CAP}Hz → f0up=${k}`)
    } else {
      f0up = 0
      log('音高自适应：没测出基频（可能是清唱/器乐），按原调处理')
    }
    const outName = `sing-${bvid}-${Date.now()}.wav`
    const outPath = path.join(GEN, outName)
    if (engine === 'gsv') {
      log('人声引擎：GPT-SoVITS v2ProPlus（念唱）')
      await renderGsvVocal(path.join(vocalDir, vocal), outPath)
    } else {
      log(`变声（${model}，f0up=${f0up}）…`)
      run(PY, ['tools\\infer_cli.py',
        '--input_path', path.join(vocalDir, vocal), '--opt_path', outPath,
        '--model_name', model, '--index_path', INDEX,
        '--f0up_key', String(f0up),
        '--device', 'cuda:0', '--is_half', 'True', '--f0method', 'rmvpe',
      ], { cwd: RVC, env: { ...process.env, weight_root: path.join(RVC, 'assets', 'weights') } })
    }
    if (!fs.existsSync(outPath)) throw new Error('RVC 没有产出文件')

    // 混伴奏（唱歌必须带伴奏）
    const finalName = `sing-${bvid}-${Date.now()}-mix.wav`
    const mixed = path.join(GEN, finalName)
    log(`混入伴奏（${instr}）…`)
    run(FFMPEG, ['-y', '-i', outPath, '-i', path.join(instrDir, instr),
      '-filter_complex', '[0:a]volume=2.0[v];[1:a]volume=0.9[m];[v][m]amix=inputs=2:duration=first',
      '-ac', '2', '-ar', '44100', mixed])
    if (!fs.existsSync(mixed)) throw new Error('混音失败')
    try { fs.rmSync(outPath, { force: true }) } catch {}

    // 发送
    let sent = false, detail = ''
    if (!noSend) {
      log(`发送到 ${target}…`)
      const r = run(process.execPath, [path.join(BRIDGE, 'scripts', 'send-voice.mjs'), 'send', `generated/${finalName}`, target], { cwd: BRIDGE })
      detail = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
      sent = true
    }

    console.log(JSON.stringify({ ok: true, song, bvid, title: cand.title, file: `generated/${finalName}`, seconds: dur, engine, f0up: engine === 'gsv' ? null : f0up, mixed: true, sent, detail: detail.slice(-300) }))
    process.exit(0)
  } catch (error) {
    lastError = error
    log(`候选失败：${String(cand.title).slice(0, 28)} → ${error.message}`)
  }
}

throw new Error(`「${song}」三个候选都没成功（最后一个：${lastError?.message ?? '未知'}）——换首歌，或者稍后再试`)
