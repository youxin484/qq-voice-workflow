// AI 语音 MCP server（stdio）：把文字用 GPT-SoVITS 合成，再交给桥接发成 QQ 语音条。
//
// 工具：qq_say_voice(text, target?)
//   1. POST http://127.0.0.1:9880/tts 合成 wav
//   2. 落到 audio/generated/（桥接语音库目录内，避免越权路径）
//   3. spawn node scripts/send-voice.mjs send <file> <target>
//      —— 复用桥接自己那套白名单/限流/审计，不另开一条发送通道
//
// 安全边界：只发到白名单群/私聊；text 长度上限 80 字；单次合成超时 60 秒。

import path from 'node:path'
import { openSync, closeSync, readFileSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { spawnSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

function projectRoot() {
  try {
    const entry = String(process.argv[1] ?? '')
    if (entry) {
      const dir = path.dirname(path.resolve(entry))
      if (path.basename(dir) === 'src') return path.dirname(dir)
    }
  } catch { /* 忽略 */ }
  return process.cwd()
}

const ROOT = projectRoot()
const CONFIG_PATH = path.join(ROOT, 'config.json')
const AUDIO_DIR = path.join(ROOT, 'audio')
const GEN_DIR = path.join(AUDIO_DIR, 'generated')
const TTS_URL = process.env.GPT_SOVITS_URL ?? 'http://127.0.0.1:9880'
// 参考音频：优先环境变量，其次 <桥接目录>/ref/reference.wav。
// prompt_text 必须与该音频内容逐字一致。
const REF_AUDIO = process.env.GPT_SOVITS_REF ?? path.join(ROOT, 'ref', 'reference.wav')
const REF_TEXT = process.env.GPT_SOVITS_REF_TEXT
  ?? readRefTextFile()
  ?? '大家好，我是小鲸鱼，平时就在群里闲聊。今天天气还不错，等会儿准备去吃个饭，顺便看看有没有什么新消息。'

/** 参考文本也可以写在 ref/REF_TEXT.txt，换参考音频时不必改环境变量。 */
function readRefTextFile() {
  try {
    const file = path.join(ROOT, 'ref', 'REF_TEXT.txt')
    if (!existsSync(file)) return undefined
    const text = readFileSync(file, 'utf8').trim()
    return text || undefined
  } catch {
    return undefined
  }
}

/** 参考音频的语种写在 ref/REF_LANG.txt（默认 zh）。洛琪希参考音频是日文，必须写 ja，
 *  否则 GPT-SoVITS 会用中文 G2P 去解析日文，音色和发音都会崩。 */
function readRefLangFile() {
  try {
    const file = path.join(ROOT, 'ref', 'REF_LANG.txt')
    if (!existsSync(file)) return undefined
    const lang = readFileSync(file, 'utf8').trim().toLowerCase()
    return /^[a-z_]{2,8}$/.test(lang) ? lang : undefined
  } catch {
    return undefined
  }
}
const REF_LANG = process.env.GPT_SOVITS_REF_LANG ?? readRefLangFile() ?? 'zh'
/**
 * 从 PCM WAV 头算时长（秒）；不是标准 PCM WAV 时返回 null。
 * 用来识别「合成器返回一整段静音」这种体积达标但内容为空的失败。
 */
function wavDurationSeconds(buf) {
  try {
    if (buf.length < 44) return null
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
    let off = 12
    let byteRate = 0
    let dataSize = 0
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16)
      if (id === 'data') { dataSize = Math.min(size, buf.length - off - 8); break }
      off += 8 + size + (size % 2)
    }
    if (!byteRate || !dataSize) return null
    return dataSize / byteRate
  } catch {
    return null
  }
}

const MAX_CHARS = 80

// 语音合成后端：优先 GPT-SoVITS（本机 9880，需装模型），不可用时退回 edge-tts。
// edge-tts = 微软在线神经语音合成，免 GPU、几十 KB 安装，音色 zh-CN-XiaoyiNeural 与
// ref/reference.wav 的来源一致（见 ref/README.txt），所以退化时音色不会突变。
const EDGE_EXE = process.env.EDGE_TTS_EXE
  ?? path.join(process.env.LOCALAPPDATA ?? '', 'edge-tts', 'venv', 'Scripts', 'edge-tts.exe')
const EDGE_VOICE = process.env.EDGE_TTS_VOICE ?? 'zh-CN-XiaoyiNeural'

// 本地 Piper（纯 CPU，22.05 kHz，实测 RTF≈0.05）：中文音色 zh_CN-huayan-medium。
// 合成完还会过 RVC 换成诗歌剧音色，所以 Piper 只负责"把字念对"，音色由 RVC 决定。
// 关掉：PIPER_ENABLED=0；换音色：PIPER_MODEL / PIPER_EXE。
const PIPER_ENABLED = process.env.PIPER_ENABLED === '1'
const PIPER_EXE = process.env.PIPER_EXE ?? 'D:\\piper\\piper\\piper.exe'
const PIPER_MODEL = process.env.PIPER_MODEL ?? 'D:\\piper\\voices\\zh_CN-huayan-medium.onnx'

// 语音合成必须由**本地软件**完成（GPT-SoVITS / Piper + RVC）；云端只负责“决定说什么”。
// 因此 edge-tts（微软在线合成）默认**关闭**，只有显式 ALLOW_CLOUD_TTS=1 才允许它兜底。
const ALLOW_CLOUD_TTS = process.env.ALLOW_CLOUD_TTS === '1'

/** 读当前显卡剩余显存（MiB）；读不到返回 null。用于判断要不要卸载本地聊天模型。 */
function gpuFreeMiB() {
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], {
      encoding: 'utf8', timeout: 4000, windowsHide: true,
    })
    const first = String(r.stdout ?? '').trim().split(/\r?\n/)[0]
    const v = Number(first)
    return Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}


// 本地聊天模型（Ollama）：发语音/唱歌前先把它踢出显存，避免和 RVC 抢 12 GB。
const OLLAMA_URL = (process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
const OLLAMA_CHAT_MODEL = process.env.OLLAMA_CHAT_MODEL ?? 'qq-local:8b'

// RVC 变声（可选）：合成完再用 RVC 把音色换成指定模型（默认诗歌剧）。
// 关掉：RVC_ENABLED=0；换模型：RVC_MODEL / RVC_INDEX / RVC_F0UP。
const RVC_ROOT = process.env.RVC_ROOT ?? 'D:\\RVC\\RVC1006Nvidia'
const RVC_PY = path.join(RVC_ROOT, 'runtime', 'python.exe')
const RVC_FFMPEG = path.join(RVC_ROOT, 'ffmpeg.exe')
const RVC_MODEL = process.env.RVC_ENABLED === '0' ? '' : (process.env.RVC_MODEL ?? 'Roxy.pth')
const RVC_INDEX = process.env.RVC_INDEX
  ?? path.join(RVC_ROOT, 'assets', 'indices', 'Roxy.index')
const RVC_F0UP = Number(process.env.RVC_F0UP ?? 0)

const server = new McpServer({ name: 'qq-voice', version: '1.0.0' })

server.tool(
  'qq_say_voice',
  '把一句话合成成语音，并以 QQ 语音条发到指定群/私聊。合成完全由本地软件完成：本机 GPT-SoVITS（127.0.0.1:9880）→ 本地 Piper（离线 CPU），再过本地 RVC 换音色；不会调用任何在线合成服务（edge-tts 需显式 ALLOW_CLOUD_TTS=1 才启用）；合成后默认再用 RVC 换成「诗歌剧」音色（RVC 不可用时自动跳过）。只用于短句（不超过 80 字），适合语气词、吐槽、一句话回应。发送仍然受桥接白名单与限流约束。',
  {
    text: z.string().describe('要说的内容，短句，不超过 80 字'),
    target: z.string().optional().describe('目标，格式 group:群号 或 private:QQ号；省略则发到配置里第一个白名单群'),
  },
  async ({ text, target }) => {
    const say = String(text ?? '').trim()
    if (!say) return { content: [{ type: 'text', text: 'text 为空' }], isError: true }
    if (say.length > MAX_CHARS) {
      return { content: [{ type: 'text', text: `太长（${say.length} 字），上限 ${MAX_CHARS}` }], isError: true }
    }

    let cfg
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch (e) {
      return { content: [{ type: 'text', text: `读 config.json 失败：${e.message}` }], isError: true }
    }

    let dest = String(target ?? '').trim()
    if (!dest) {
      const first = (cfg.allow?.groups ?? [])[0]
      if (!first) return { content: [{ type: 'text', text: '没有指定 target，且白名单为空' }], isError: true }
      dest = `group:${first}`
    }

    if (!existsSync(REF_AUDIO)) {
      return { content: [{ type: 'text', text: `参考音频缺失：${REF_AUDIO}` }], isError: true }
    }

    // 1) 合成：本地优先 —— GPT-SoVITS → Piper（纯本地 CPU）→ edge-tts（联网兜底）
    let audio
    let ext = 'wav'
    let backend = 'gpt-sovits'
    let gptError = null
    try {
      const res = await fetch(`${TTS_URL}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: say,
          text_lang: 'zh',
          ref_audio_path: REF_AUDIO,
          prompt_text: REF_TEXT,
          prompt_lang: REF_LANG,
          media_type: 'wav',
          streaming_mode: false,
        }),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
      audio = Buffer.from(await res.arrayBuffer())
      if (audio.length < 1000) throw new Error(`返回数据过小（${audio.length} 字节）`)

      // 静音守卫：模型/配置不对时 GPT-SoVITS 会返回「1 秒、16 kHz、全是 0」的 WAV，
      // 体积达标所以以前能蒙混过关，最后发出去是一条无声语音。
      // 这里按 WAV 头算真实时长，明显短于文本长度应有值就当成失败，走兜底/报错。
      const wavDur = wavDurationSeconds(audio)
      const minDur = Math.max(0.4, say.replace(/\s/g, '').length * 0.08)
      if (wavDur !== null && wavDur < minDur) {
        throw new Error(`合成结果异常：时长 ${wavDur.toFixed(2)}s < 期望 ${minDur.toFixed(2)}s（可能是空模型/静音输出）`)
      }
    } catch (error) {
      gptError = error
    }

    // 1.2) 本地 Piper：几十毫秒就能合成，完全离线（音色 zh_CN-huayan-medium）
    if (audio === undefined && PIPER_ENABLED && existsSync(PIPER_EXE) && existsSync(PIPER_MODEL)) {
      try {
        mkdirSync(GEN_DIR, { recursive: true })
        const tmp = path.join(GEN_DIR, `.piper-${Date.now()}.wav`)
        const run = spawnSync(PIPER_EXE, ['-m', PIPER_MODEL, '-f', tmp], {
          input: say,
          encoding: 'utf8',
          timeout: 120_000,
          windowsHide: true,
          cwd: path.dirname(PIPER_EXE),
        })
        if (run.status !== 0 || !existsSync(tmp)) throw new Error(`piper 退出码 ${run.status}：${String(run.stderr ?? '').slice(-200)}`)
        audio = readFileSync(tmp)
        rmSync(tmp, { force: true })
        ext = 'wav'
        backend = 'piper(本地)'
      } catch (error) {
        backend = `piper 失败（${error.message}）`
      }
    }

    // 1.3) edge-tts（微软在线）：默认不启用 —— 渲染只走本地。
    //      需要云端兜底时设 ALLOW_CLOUD_TTS=1。
    if (audio === undefined && ALLOW_CLOUD_TTS) {
      const why = gptError ? `GPT-SoVITS 不可用（${gptError.message}）` : 'GPT-SoVITS 未启用'
      if (!existsSync(EDGE_EXE)) {
        return {
          content: [{ type: 'text', text: `合成失败：${why}；本地 Piper 也不可用（${PIPER_EXE} / ${PIPER_MODEL}）；且没找到 edge-tts（${EDGE_EXE}）` }],
          isError: true,
        }
      }
      mkdirSync(GEN_DIR, { recursive: true })
      const tmp = path.join(GEN_DIR, `.edge-${Date.now()}.mp3`)
      const run = spawnSync(EDGE_EXE, ['--voice', EDGE_VOICE, '--text', say, '--write-media', tmp], {
        encoding: 'utf8', timeout: 60_000, windowsHide: true,
      })
      if (run.status !== 0 || !existsSync(tmp)) {
        return {
          content: [{ type: 'text', text: `合成失败：${why}；${backend}；edge-tts（${String(run.stderr ?? '').slice(-300)}）` }],
          isError: true,
        }
      }
      audio = readFileSync(tmp)
      rmSync(tmp, { force: true })
      ext = 'mp3'
      backend = 'edge-tts'
    }

    // 本地渲染失败且未允许云端兜底：直接报错，绝不偷偷用在线合成。
    if (audio === undefined) {
      const why = gptError ? `GPT-SoVITS 不可用（${gptError.message}）` : 'GPT-SoVITS 未启用'
      return {
        content: [{
          type: 'text',
          text: `本地语音渲染失败，已拒绝改用在线合成：${why}；Piper（${PIPER_EXE} / ${PIPER_MODEL}）${backend.startsWith('piper 失败') ? backend : '不可用'}。` + '\n修复本地 TTS 后重试，或显式设置 ALLOW_CLOUD_TTS=1 允许 edge-tts 兜底。'
        }],
        isError: true,
      }
    }

    // 1.5) 可选：RVC 变声 —— 把合成音换成指定音色（默认诗歌剧）
    //      用环境变量关掉：RVC_MODEL=""（或 RVC_ENABLED=0）
    //      跑 RVC 前先把本地聊天模型从显存里请出去：qq-local:8b 在 40k 上下文时占 ~8 GB，
    //      12 GB 卡上再叠 RVC 的 ~2.5 GB 会直接 OOM。卸载后下一次聊天会重新预填充（约 40 s），
    //      但语音只偶发，这个代价比"发语音失败"划算。关掉：OLLAMA_UNLOAD_BEFORE_RVC=0。
    if (process.env.RVC_ENABLED !== '0' && process.env.OLLAMA_UNLOAD_BEFORE_RVC !== '0') {
      // 先看显存：够 RVC 用（~2.5 GB）就直接开跑，不要去打扰本地聊天模型——
      // 卸载 + 轮询最多要等 18 秒，那 18 秒就是用户听到语音前的延迟。
      const free = gpuFreeMiB()
      if (free !== null && free >= Number(process.env.RVC_MIN_FREE_MIB ?? 4500)) {
        // 显存充足，跳过卸载
      } else try {
        await fetch(`${OLLAMA_URL}/api/generate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: OLLAMA_CHAT_MODEL, keep_alive: 0 }),
          signal: AbortSignal.timeout(5000),
        })
        // 卸载是异步的：从发起到真正释放要 5~15 s，直接跑 RVC 仍会 OOM。轮询到腾出空位为止。
        for (let i = 0; i < 12; i += 1) {
          const ps = await fetch(`${OLLAMA_URL}/api/ps`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => null)
          const still = (ps?.models ?? []).some((m) => String(m.name ?? m.model ?? '').startsWith(OLLAMA_CHAT_MODEL))
          if (!still) break
          await new Promise((r) => setTimeout(r, 1500))
        }
      } catch { /* Ollama 没起来就算了，不阻断发语音 */ }
    }

    if (process.env.RVC_ENABLED !== '0' && RVC_MODEL && existsSync(RVC_PY)) {
      const tmpIn = path.join(GEN_DIR, `.rvc-in-${Date.now()}.wav`)
      const tmpOut = path.join(GEN_DIR, `.rvc-out-${Date.now()}.wav`)
      const tmpSrc = path.join(GEN_DIR, `.tts-${Date.now()}.${ext}`)
      try {
        mkdirSync(GEN_DIR, { recursive: true })
        writeFileSync(tmpSrc, audio)
        // 统一转 16k/单声道 wav，省得 RVC 的 librosa 读 mp3 出岔子
        const ff = spawnSync(RVC_FFMPEG, ['-y', '-i', tmpSrc, '-ac', '1', '-ar', '44100', '-sample_fmt', 's16', tmpIn], {
          encoding: 'utf8', timeout: 60_000, windowsHide: true,
        })
        if (ff.status !== 0 || !existsSync(tmpIn)) throw new Error(`ffmpeg 转码失败：${String(ff.stderr ?? '').slice(-200)}`)
        const rvc = spawnSync(RVC_PY, ['tools/infer_cli.py',
          '--input_path', tmpIn,
          '--opt_path', tmpOut,
          '--model_name', RVC_MODEL,
          '--index_path', RVC_INDEX,
          '--f0up_key', String(RVC_F0UP),
          '--device', 'cuda:0',
          '--is_half', 'True',
          '--f0method', 'rmvpe',
        ], {
          cwd: RVC_ROOT,
          encoding: 'utf8',
          timeout: 300_000,
          windowsHide: true,
          env: { ...process.env, weight_root: path.join(RVC_ROOT, 'assets', 'weights') },
        })
        if (rvc.status !== 0 || !existsSync(tmpOut)) throw new Error(`RVC 变声失败：${String(rvc.stderr ?? '').slice(-300)}`)
        audio = readFileSync(tmpOut)
        ext = 'wav'
        backend = `${backend}+rvc`
      } catch (error) {
        // 变声失败不阻断发送：退回原合成音，但把原因带回去
        backend = `${backend}（RVC 变声失败：${error.message}）`
      } finally {
        for (const f of [tmpSrc, tmpIn, tmpOut]) { try { rmSync(f, { force: true }) } catch {} }
      }
    }

    // 2) 落盘（文件名用内容哈希，避免重复堆积）
    mkdirSync(GEN_DIR, { recursive: true })
    const name = `${createHash('sha1').update(say).digest('hex').slice(0, 12)}.${ext}`
    const file = path.join(GEN_DIR, name)
    writeFileSync(file, audio)

    // 3) 交给桥接发送
    const script = path.join(ROOT, 'scripts', 'send-voice.mjs')
    const run = spawnSync(process.execPath, [script, 'send', `generated/${name}`, dest], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
    })
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim()
    if (run.status !== 0) {
      return { content: [{ type: 'text', text: `发送失败（exit ${run.status}）：\n${out.slice(-600)}` }], isError: true }
    }
    return {
      content: [{
        type: 'text',
        text: `已发送语音（${backend}）到 ${dest}：${say}\n${out.split(/\r?\n/).filter(l => l.includes('✅') || l.includes('messageId')).join('\n')}`,
      }],
    }
  },
)

server.tool(
  'qq_sing',
  '点歌：在 B 站搜原曲 → 下载 → 分离人声 → 用洛琪希音色唱 25~60 秒 → **混回原伴奏** → 发成 QQ 语音条。默认 engine=rvc（在原唱人声上换声，保旋律）；engine=gsv 则改用本地 GPT-SoVITS v2ProPlus 逐句念唱（无音高控制，旋律靠伴奏）。rvc 模式下自动测原曲音高定调，不用指定调子。整条约 25~90 秒，期间不要重复调用。',
  {
    song: z.string().describe('歌名，例如「朋友的酒」「小星星」'),
    target: z.string().optional().describe('group:群号 或 private:QQ号；省略则发第一个白名单群'),
    start: z.number().optional().describe('从第几秒开始截（可选，默认取歌曲 25% 处，避开前奏）'),
    engine: z.enum(['rvc', 'gsv']).optional()
      .describe('人声引擎。rvc（默认）=在原唱人声上换声，保旋律、真"唱"；gsv=用 GPT-SoVITS v2ProPlus 念唱歌词（TTS 无音高控制，旋律只来自伴奏，适合朗诵/念白/纯音乐填词）'),
  },
  async ({ song, target, start, engine }) => {
    const name = String(song ?? '').trim()
    if (!name) return { content: [{ type: 'text', text: 'song 为空' }], isError: true }
    let cfg
    try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) } catch (e) {
      return { content: [{ type: 'text', text: `读 config.json 失败：${e.message}` }], isError: true }
    }
    let dest = String(target ?? '').trim()
    if (!dest) {
      const first = (cfg.allow?.groups ?? [])[0]
      if (!first) return { content: [{ type: 'text', text: '没有指定 target，且白名单为空' }], isError: true }
      dest = `group:${first}`
    }
    const args = [path.join(ROOT, 'sing.mjs'), '--song', name, '--target', dest]
    if (Number.isFinite(start)) args.push('--start', String(start))
    if (engine === 'gsv' || engine === 'rvc') args.push('--engine', engine)

    // 2026-11-09 用户要求：QQ 里一收到点歌请求就**立刻开工**，不要让模型等渲染完才说话。
    // 所以默认 fire-and-forget：把 sing.mjs 甩到独立进程里跑，工具马上返回；
    // 唱完由 sing.mjs 自己调 send-voice 发到会话，不需要这轮对话再等。
    // 要回到"等它唱完再回复"的老行为：SYNC_SING=1。
    if (process.env.SYNC_SING !== '1') {
      const logPath = path.join(ROOT, 'state', 'sing-jobs.log')
      const fd = openSync(logPath, 'a')
      const child = spawn(process.execPath, args, {
        cwd: ROOT,
        detached: true,
        stdio: ['ignore', fd, fd],
        windowsHide: true,
        env: { ...process.env, SING_ASYNC: '1' },
      })
      child.unref()
      try { closeSync(fd) } catch { /* 子进程已继承句柄 */ }
      writeFileSync(path.join(ROOT, 'state', 'sing-last-job.json'), JSON.stringify({
        pid: child.pid, song: name, target: dest, engine: engine ?? 'rvc', startedAt: new Date().toISOString(),
      }, null, 2), 'utf8')
      return {
        content: [{
          type: 'text',
          text: `已经开唱了：《${name}》（${engine === 'gsv' ? 'GSV 念唱' : 'RVC 换声'}，pid ${child.pid}）。`
            + `\n渲染在后台跑，唱完会自动把语音发到 ${dest}——这轮不用等，可以继续说别的。`,
        }],
      }
    }

    const run = spawnSync(process.execPath, args, {
      cwd: ROOT, encoding: 'utf8', timeout: 480_000, windowsHide: true,
    })
    const raw = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim()
    const lastJson = raw.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'))
    if (run.status !== 0 || !lastJson) {
      return { content: [{ type: 'text', text: `点歌失败（exit ${run.status}）：\n${raw.slice(-800)}` }], isError: true }
    }
    let r
    try { r = JSON.parse(lastJson) } catch { r = null }
    if (!r || !r.ok) return { content: [{ type: 'text', text: `点歌失败：${raw.slice(-500)}` }], isError: true }
    return {
      content: [{
        type: 'text',
        text: `唱好了：《${r.song}》→ ${r.title}\n已作为语音发出到 ${dest}（${r.seconds} 秒，file=${r.file}）\n${String(r.detail ?? '').split(/\r?\n/).filter((l) => l.includes('✅')).slice(0, 2).join('\n')}`,
      }],
    }
  },
)
// 预热：MCP 进程起来后立刻空跑一次合成，把 GSV 模型加载进显存。
// 冷启动要 60~80 秒；预热放进后台，不阻塞任何工具调用。
if (process.env.TTS_PREWARM !== '0') {
  const prewarmText = '预热。'
  void (async () => {
    try {
      await fetch(`${TTS_URL}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: prewarmText,
          text_lang: 'zh',
          ref_audio_path: REF_AUDIO,
          prompt_text: REF_TEXT,
          prompt_lang: REF_LANG,
          media_type: 'wav',
          streaming_mode: false,
        }),
        signal: AbortSignal.timeout(240_000),
      })
    } catch { /* 预热失败不影响功能 */ }
  })()
}

await server.connect(new StdioServerTransport())
