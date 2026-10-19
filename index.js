// dsh-tts：把 assistant 的文字回答读出来。
//
// 引擎（config.json 的 engine）：
//   "edge" — 微软 Edge 在线语音（默认，晓晓等自然音色，需要 python + edge-tts + ffplay）
//   "sapi" — Windows 自带离线语音合成（System.Speech，无网络也能用）
//   "gpt_sovits" — 本机 GPT-SoVITS，按语种 / 会话路由，可热切换权重
//   "cosyvoice" — 本机 CosyVoice2/3，参考音频零样本克隆（服务由本插件拉起）
// edge 合成失败（断网 / 没装包）时自动回退到 sapi；cosyvoice 不可用时同样回退。
//
// - 默认只读「最终回答」：含 tool-call 的中间步骤消息跳过。
// - 队列串行播放；新的用户提问会打断正在朗读的旧回答。
// - 调试：DSH_TTS_DRY=1 时不发声，只把待朗读文本写进 tts.log。
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { toSpeech } from "./polish.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SPEAK_PS1 = path.join(here, "speak.ps1");
const COSY_SERVER = path.join(here, "cosyvoice_server.py");
const LOG_FILE = path.join(here, "tts.log");
const LOG_MAX = 512 * 1024;

const DEFAULTS = {
  enabled: true,
  engine: "edge",
  gsvApi: "http://127.0.0.1:9880",
  gsvPython: "",
  gsvWorkDir: "",
  gsvConfig: "GPT_SoVITS/configs/tts_infer_streamfire.yaml",
  gsvGptWeights: "",
  gsvVitsWeights: "",
  gsvVersion: "v2",
  gsvGeneratedConfig: "GPT_SoVITS/configs/dsh-tts-infer.yaml",
  gsvRefAudio: "",
  gsvPromptText: "",
  gsvPromptLang: "zh",
  gsvTextLang: "zh",
  gsvSpeed: 1.0,
  gsvEn: null,
  gsvJa: null,
  sessionVoices: {},
  gsvMaxChunk: 110,
  gsvStartTimeoutMs: 120000,
  gsvTimeoutMs: 180000,
  // ---- CosyVoice（engine === "cosyvoice" 时生效）----
  cosyApi: "http://127.0.0.1:9883",
  cosyPython: "",
  cosyWorkDir: "",
  cosyModelDir: "pretrained_models/CosyVoice2-0.5B",
  cosyRefAudio: "",
  cosyPromptText: "",
  cosyInstruct: "",
  cosySpeed: 1.0,
  cosyStartTimeoutMs: 180000,
  cosyTimeoutMs: 180000,
  finalOnly: true,
  voice: "",
  rate: 0,
  volume: 100,
  edgeVoice: "zh-CN-XiaoxiaoNeural",
  edgeRate: "+0%",
  edgeVolume: "+0%",
  langRouting: true,
  jaVoice: "ja-JP-NanamiNeural",
  enVoice: "en-US-AriaNeural",
  playerVolume: 100,
  pythonPath: "python",
  maxChars: 1200,
  minChars: 2,
  skipCodeBlocks: true,
  polish: "rules",
  dedupeSeconds: 120,
  stopPort: 9889,
};

const CFG_FILE = path.join(here, "config.json");

function loadConfig() {
  const cfg = { ...DEFAULTS };
  try {
    const raw = JSON.parse(
      fs.readFileSync(CFG_FILE, "utf8").replace(/^\uFEFF/, ""),
    );
    for (const key of Object.keys(DEFAULTS)) {
      if (raw[key] !== undefined) cfg[key] = raw[key];
    }
  } catch {
    // 配置坏了就用默认值，绝不能影响 DSH 启动
  }
  cfg.maxChars = Math.max(40, Math.min(20000, Number(cfg.maxChars) || DEFAULTS.maxChars));
  cfg.minChars = Math.max(0, Number(cfg.minChars) || 0);
  cfg.playerVolume = Math.max(0, Math.min(100, Number(cfg.playerVolume)));
  return cfg;
}

function log(message) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX) {
      fs.rmSync(LOG_FILE + ".1", { force: true });
      fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch {}
}

// 朗读稿净化（去 Markdown、路径只留文件名、数字读法、长句停顿）在 polish.js。

function extractText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!block || block.type !== "text") continue;
    if (typeof block.text === "string" && block.text.trim()) parts.push(block.text);
  }
  return parts.join("\n");
}

function once(fn) {
  let called = false;
  return (...args) => {
    if (called) return;
    called = true;
    fn(...args);
  };
}

function tmpPath(ext) {
  return path.join(
    os.tmpdir(),
    `dsh-tts-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}${ext}`,
  );
}

function rm(file) {
  try { fs.rmSync(file, { force: true }); } catch {}
}

// 当前会话是谁：写进 current-session.json，供 voices.py / roleplay skill 读取。
const CURRENT_SESSION_FILE = path.join(here, "current-session.json");
let lastSessionJson = "";

function sessionIdOf(session, event) {
  if (session && session.id) return String(session.id);
  const data = event && event.data;
  if (data && data.sessionId) return String(data.sessionId);
  const meta = session && session.meta;
  if (meta && meta.sessionId) return String(meta.sessionId);
  return "";
}

function recordSession(session, event) {
  const sid = sessionIdOf(session, event);
  if (!sid) return;
  const info = {
    id: sid,
    title: String((session && (session.title || (session.meta && session.meta.title))) || ""),
    cwd: String((session && session.cwd) || ""),
    updatedAt: new Date().toISOString(),
  };
  const raw = JSON.stringify(info, null, 2) + "\n";
  if (raw === lastSessionJson) return;
  lastSessionJson = raw;
  try { fs.writeFileSync(CURRENT_SESSION_FILE, raw, "utf8"); } catch {}
}

export function apply(ctx) {
  const cfg = loadConfig();
  let cfgMtime = 0;
  try { cfgMtime = fs.statSync(CFG_FILE).mtimeMs; } catch {}

  // 运行中改了 config.json（换音色 / 绑定会话）时自动重载，省一次重启。
  function maybeReloadConfig() {
    try {
      const st = fs.statSync(CFG_FILE);
      if (st.mtimeMs <= cfgMtime) return;
      try { JSON.parse(fs.readFileSync(CFG_FILE, "utf8").replace(/^\uFEFF/, "")); }
      catch { return; } // 可能写到一半，等下一次事件再试
      cfgMtime = st.mtimeMs;
      Object.assign(cfg, loadConfig());
      log("config.json 已重新加载");
    } catch {}
  }
  const queue = [];
  let speaking = false;
  let current = null;
  let interrupted = false;
  let lastHash = "";
  let lastHashAt = 0;

  function stopCurrent() {
    interrupted = true;
    if (current) {
      try { current.kill(); } catch {}
    }
  }

  // ---- 一键停止 ----
  // 发一条新消息也能停，但听长回答听到一半再去打字很别扭。
  // 这里开个只绑 127.0.0.1 的小旁路，浏览器收藏 / 桌面快捷方式点一下就静音。
  let stopServer = null;

  function startStopServer() {
    if (stopServer) return;
    const port = Number(cfg.stopPort) || 9889;
    try {
      stopServer = http.createServer((req, res) => {
        const pathName = (req.url || "").split("?")[0];
        const reply = (code, obj) => {
          const body = Buffer.from(JSON.stringify(obj), "utf8");
          res.writeHead(code, {
            "content-type": "application/json; charset=utf-8",
            "content-length": body.length,
            // GUI 在 3501，掐音在 9889，跨端口要放行（只放本机来源，反正服务也只绑 127.0.0.1）
            "access-control-allow-origin": "*",
            "cache-control": "no-store",
          });
          res.end(body);
        };
        if (pathName === "/stop") {
          queue.length = 0;
          stopCurrent();
          reply(200, { ok: true, stopped: true });
        } else if (pathName === "/status") {
          reply(200, { ok: true, speaking, queued: queue.length });
        } else {
          reply(404, { ok: false, error: "not found" });
        }
      });
      stopServer.on("error", (err) => log(`stop server: ${err && err.message}`));
      stopServer.listen(port, "127.0.0.1", () => {
        log(`stop server on http://127.0.0.1:${port}/stop`);
      });
    } catch (err) {
      log(`stop server 启动失败: ${err && err.message}`);
    }
  }

  function pump() {
    if (speaking || queue.length === 0) return;
    const item = queue.shift();
    const text = item.text;
    const sid = item.sid || "";
    speaking = true;
    interrupted = false;
    const done = once(() => {
      current = null;
      speaking = false;
      setImmediate(pump);
    });

    if (process.env.DSH_TTS_DRY === "1") {
      log(`[dry] ${text}`);
      done();
      return;
    }
    if (cfg.engine === "sapi") {
      speakSapi(text, done);
    } else if (cfg.engine === "cosyvoice") {
      speakCosy(text, done, sid);
    } else if (cfg.langRouting) {
      speakRouted(text, done, sid);
    } else if (cfg.engine === "gpt_sovits") {
      speakGsv(text, done, sid);
    } else {
      speakEdge(text, done);
    }
  }

  // ---- SAPI：Windows 离线合成 ----
  function speakSapi(text, done) {
    const file = tmpPath(".txt");
    try {
      fs.writeFileSync(file, text, "utf8");
    } catch (err) {
      log(`sapi write error: ${err && err.message}`);
      return done();
    }
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", SPEAK_PS1,
      "-TextFile", file,
      "-Rate", String(cfg.rate),
      "-Volume", String(cfg.volume),
    ];
    if (cfg.voice) args.push("-Voice", cfg.voice);

    const child = spawn("powershell.exe", args, { windowsHide: true, stdio: "ignore" });
    current = child;
    const finish = once(() => { rm(file); done(); });
    child.on("error", (err) => { log(`sapi spawn error: ${err && err.message}`); finish(); });
    child.on("exit", () => finish());
  }

  // ---- edge-tts：在线自然语音，失败回退 SAPI ----
  function speakEdge(text, done) {
    const txt = tmpPath(".txt");
    const mp3 = tmpPath(".mp3");
    const cleanup = () => { rm(txt); rm(mp3); };
    const finish = once(() => { cleanup(); done(); });

    try {
      fs.writeFileSync(txt, text, "utf8");
    } catch (err) {
      log(`edge write error: ${err && err.message}`);
      return speakSapi(text, finish);
    }

    const args = ["-m", "edge_tts", "--file", txt, "--write-media", mp3, "--voice", cfg.edgeVoice];
    if (cfg.edgeRate) args.push("--rate", String(cfg.edgeRate));
    if (cfg.edgeVolume) args.push("--volume", String(cfg.edgeVolume));

    const child = spawn(cfg.pythonPath || "python", args, { windowsHide: true, stdio: "ignore" });
    current = child;
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 60000);

    child.on("error", (err) => {
      clearTimeout(timer);
      log(`edge spawn error: ${err && err.message}; fallback to sapi`);
      speakSapi(text, finish);
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      if (interrupted) return finish();
      let ok = false;
      try { ok = code === 0 && fs.existsSync(mp3) && fs.statSync(mp3).size > 0; } catch {}
      if (!ok) {
        log(`edge synth failed (code ${code}); fallback to sapi`);
        return speakSapi(text, finish);
      }
      playFile(mp3, finish);
    });
  }

  function playFile(file, done) {
    const args = ["-nodisp", "-autoexit", "-loglevel", "quiet"];
    if (Number.isFinite(cfg.playerVolume)) args.push("-volume", String(cfg.playerVolume));
    args.push(file);

    const child = spawn("ffplay", args, { windowsHide: true, stdio: "ignore" });
    current = child;
    const finish = once(done);
    child.on("error", (err) => { log(`ffplay error: ${err && err.message}`); finish(); });
    child.on("exit", () => finish());
  }

  // ---- GPT-SoVITS：本机模型（api_v2.py /tts），每个语种一个服务/端口 ----
  const gsvStates = new Map(); // api -> { starting, ready, child, logFd }

  function gsvBaseOf(api) {
    return String(api || "").replace(/\/+$/, "");
  }

  // zh 用顶层配置；en/ja 用 gsvEn / gsvJa 对象。
  function gsvProfiles() {
    const out = [];
    if (cfg.engine === "gpt_sovits") {
      out.push({
        name: "zh",
        api: cfg.gsvApi,
        gpt: cfg.gsvGptWeights,
        vits: cfg.gsvVitsWeights,
        version: cfg.gsvVersion,
        ref: cfg.gsvRefAudio,
        prompt: cfg.gsvPromptText,
        promptLang: cfg.gsvPromptLang,
        textLang: cfg.gsvTextLang,
        speed: cfg.gsvSpeed,
      });
    }
    for (const [lang, prof] of [["en", cfg.gsvEn], ["ja", cfg.gsvJa]]) {
      if (prof && prof.api && prof.gptWeights && prof.vitsWeights) {
        out.push({
          name: lang,
          api: prof.api,
          gpt: prof.gptWeights,
          vits: prof.vitsWeights,
          version: prof.version,
          ref: prof.refAudio,
          prompt: prof.promptText,
          promptLang: prof.promptLang || lang,
          textLang: prof.textLang || lang,
          speed: prof.speed,
        });
      }
    }
    return out;
  }

  function gsvForLang(lang) {
    return gsvProfiles().find((p) => p.name === lang) || null;
  }

  // ---- 会话级音色：sessionVoices[sessionId] 优先于语种路由 ----
  function sanitizeId(sid) {
    return String(sid).replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 48) || "x";
  }

  function boundProfile(sid) {
    const map = cfg.sessionVoices;
    if (!sid || !map || typeof map !== "object") return null;
    const b = map[String(sid)];
    if (!b || !b.api || !b.gptWeights || !b.vitsWeights) return null;
    return {
      name: "sess-" + sanitizeId(String(sid)),
      api: b.api,
      gpt: b.gptWeights,
      vits: b.vitsWeights,
      version: b.version || "v2",
      ref: b.refAudio,
      prompt: b.promptText || "",
      promptLang: b.promptLang || "zh",
      textLang: b.textLang || "",
      speed: b.speed,
      session: String(sid),
    };
  }

  // 同一端口可能被不同语种/不同会话复用：权重不一致时用 set_*_weights 热切换。
  const loadedWeights = new Map(); // api -> { gpt, vits }

  async function applyWeights(profile) {
    const api = gsvBaseOf(profile.api);
    const cur = loadedWeights.get(api);
    if (cur && cur.gpt === profile.gpt && cur.vits === profile.vits) return;
    const call = async (endpoint, weights) => {
      const url = `${api}${endpoint}?weights_path=${encodeURIComponent(weights)}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`set weights ${endpoint} http ${r.status} ${body.slice(0, 120)}`);
      }
    };
    await call("/set_gpt_weights", profile.gpt);
    await call("/set_sovits_weights", profile.vits);
    loadedWeights.set(api, { gpt: profile.gpt, vits: profile.vits });
    log(`[${profile.name}] weights -> ${path.basename(profile.gpt)} / ${path.basename(profile.vits)}`);
  }

  // 按句切块：逐块合成，播放上一块时预取下一块，减少停顿。
  function splitSpeech(text) {
    const parts = String(text).split(/(?<=[。！？!?；;\n])/).map((s) => s.trim()).filter(Boolean);
    const chunks = [];
    let cur = "";
    const max = Math.max(40, Number(cfg.gsvMaxChunk) || 110);
    for (const p of parts) {
      if (cur && (cur + p).length > max) { chunks.push(cur); cur = p; }
      else cur += p;
    }
    if (cur) chunks.push(cur);
    return chunks.length ? chunks : [String(text)];
  }

  async function pingGsv(api, timeout = 1500) {
    try {
      const r = await fetch(gsvBaseOf(api) + "/docs", { signal: AbortSignal.timeout(timeout) });
      return r.ok || r.status < 500;
    } catch {
      return false;
    }
  }

  // 把 Windows 路径写成纯 ASCII 的 YAML 双引号标量：
  // 反斜杠双写、非 ASCII 转 \uXXXX，避免上游用 GBK 读配置时把中文路径读坏。
  function yamlQ(value) {
    let out = '"';
    for (const ch of String(value)) {
      const code = ch.codePointAt(0);
      if (ch === "\\") out += "\\\\";
      else if (ch === '"') out += '\\"';
      else if (code < 0x20 || code > 0x7e) out += "\\u" + code.toString(16).toUpperCase().padStart(4, "0");
      else out += ch;
    }
    return out + '"';
  }

  // 每次启动都按 config.json 重新生成推理配置，避免上游把选中的权重/版本写坏。
  function writeGsvConfig(profile) {
    const tplPath = path.join(here, "gsv-infer.template.yaml");
    const tpl = fs.readFileSync(tplPath, "utf8");
    const out = tpl
      .replaceAll("__T2S__", () => yamlQ(profile.gpt))
      .replaceAll("__VITS__", () => yamlQ(profile.vits))
      .replaceAll("__VERSION__", () => String(profile.version || "v2"));
    const rel = `GPT_SoVITS/configs/dsh-tts-${profile.name}.yaml`;
    const target = path.resolve(cfg.gsvWorkDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, out, "utf8");
    return rel;
  }

  function ensureGsv(profile) {
    const api = gsvBaseOf(profile.api);
    let st = gsvStates.get(api);
    if (!st) { st = { starting: null, ready: false, child: null, logFd: null }; gsvStates.set(api, st); }
    if (st.starting) return st.starting;
    st.starting = (async () => {
      if (await pingGsv(api, 1200)) { st.ready = true; return; }
      if (!cfg.gsvWorkDir) throw new Error("gsvWorkDir 未配置");
      let u;
      try { u = new URL(api); } catch { throw new Error(`gsv api 非法: ${profile.api}`); }
      let configPath = cfg.gsvConfig;
      let wroteConfig = false;
      if (profile.gpt && profile.vits) {
        try {
          configPath = writeGsvConfig(profile);
          wroteConfig = true;
        } catch (err) {
          log(`gsv 生成配置失败: ${err && err.message}`);
        }
      }
      const args = ["api_v2.py", "-a", u.hostname, "-p", String(u.port || 9880), "-c", configPath];
      log(`[${profile.name}] gsv starting: ${cfg.gsvPython || "python"} ${args.join(" ")}`);
      try {
        st.logFd = fs.openSync(path.join(here, "gsv-server.log"), "a");
        st.child = spawn(cfg.gsvPython || "python", args, {
          cwd: cfg.gsvWorkDir,
          windowsHide: true,
          stdio: ["ignore", st.logFd, st.logFd],
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        });
      } catch (err) {
        throw new Error(`gsv spawn 失败: ${err && err.message}`);
      }
      st.child.on("error", (err) => log(`[${profile.name}] gsv spawn error: ${err && err.message}`));
      st.child.on("exit", (code) => { st.ready = false; log(`[${profile.name}] gsv exited ${code}`); });
      const deadline = Date.now() + (Number(cfg.gsvStartTimeoutMs) || 120000);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (interrupted) throw new Error("interrupted during gsv start");
        if (await pingGsv(api, 1200)) {
          st.ready = true;
          if (wroteConfig) loadedWeights.set(api, { gpt: profile.gpt, vits: profile.vits });
          log(`[${profile.name}] gsv ready`);
          return;
        }
      }
      throw new Error(`[${profile.name}] gsv 启动超时`);
    })().finally(() => { st.starting = null; });
    return st.starting;
  }

  async function gsvSynth(text, profile, textLang) {
    await ensureGsv(profile);
    await applyWeights(profile);
    const url = new URL(gsvBaseOf(profile.api) + "/tts");
    const q = url.searchParams;
    q.set("text", text);
    q.set("text_lang", textLang || profile.textLang || "zh");
    q.set("ref_audio_path", profile.ref || "");
    q.set("prompt_text", profile.prompt || "");
    q.set("prompt_lang", profile.promptLang || "zh");
    q.set("text_split_method", "cut5");
    q.set("batch_size", "1");
    q.set("speed_factor", String(Number(profile.speed) || 1));
    q.set("media_type", "wav");
    q.set("streaming_mode", "false");
    const r = await fetch(url, { signal: AbortSignal.timeout(Number(cfg.gsvTimeoutMs) || 180000) });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`gsv http ${r.status} ${body.slice(0, 160)}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1000) throw new Error("gsv 返回音频为空");
    const file = tmpPath(".wav");
    fs.writeFileSync(file, buf);
    return file;
  }

  function playFileAsync(file) {
    return new Promise((resolve) => {
      const args = ["-nodisp", "-autoexit", "-loglevel", "quiet"];
      if (Number.isFinite(cfg.playerVolume)) args.push("-volume", String(cfg.playerVolume));
      args.push(file);
      const child = spawn("ffplay", args, { windowsHide: true, stdio: "ignore" });
      current = child;
      const finish = once(() => { rm(file); resolve(); });
      child.on("error", (err) => { log(`ffplay error: ${err && err.message}`); finish(); });
      child.on("exit", () => finish());
    });
  }

  async function speakGsv(text, done, sid) {
    const profile = boundProfile(sid) || gsvForLang("zh") || gsvProfiles()[0];
    if (!profile) return speakEdge(text, done);
    try {
      await ensureGsv(profile);
    } catch (err) {
      log(`gsv 不可用: ${err && err.message}; 回退 edge`);
      return speakEdge(text, done);
    }
    try {
      const chunks = splitSpeech(text);
      let next = chunks.length ? gsvSynth(chunks[0], profile).catch((err) => { log(`gsv synth: ${err && err.message}`); return null; }) : null;
      for (let i = 0; i < chunks.length; i++) {
        if (interrupted) {
          if (next) next.then((f) => { if (f) rm(f); }).catch(() => {});
          break;
        }
        const file = await next;
        next = i + 1 < chunks.length
          ? gsvSynth(chunks[i + 1], profile).catch((err) => { log(`gsv synth: ${err && err.message}`); return null; })
          : null;
        if (interrupted) { if (file) rm(file); continue; }
        if (!file) { log("gsv chunk 失败，跳过该块"); continue; }
        await playFileAsync(file);
      }
    } catch (err) {
      log(`gsv speak: ${err && err.message}`);
    } finally {
      done();
    }
  }

  // ---- CosyVoice：参考音频零样本克隆，服务由本插件按需拉起 ----
  // 与 gpt_sovits 不同，CosyVoice 的「音色」就是一条参考音频：换音色 = 换 wav + 它的原文，
  // 不需要训练，也没有权重热切换。分块、预取、打断的逻辑和 gsv 一致。
  const cosyState = { starting: null, ready: false, child: null, logFd: null };

  function cosyBase() {
    return String(cfg.cosyApi || "").replace(/\/+$/, "");
  }

  async function pingCosy(timeout = 1500) {
    try {
      const r = await fetch(cosyBase() + "/health", { signal: AbortSignal.timeout(timeout) });
      if (!r.ok) return false;
      const j = await r.json().catch(() => ({}));
      return !!j.ok;
    } catch {
      return false;
    }
  }

  function ensureCosy() {
    if (cosyState.starting) return cosyState.starting;
    cosyState.starting = (async () => {
      if (await pingCosy(1200)) { cosyState.ready = true; return; }
      if (!cfg.cosyWorkDir) throw new Error("cosyWorkDir 未配置");
      let u;
      try { u = new URL(cosyBase()); } catch { throw new Error(`cosy api 非法: ${cfg.cosyApi}`); }
      const args = [
        COSY_SERVER,
        "--host", u.hostname,
        "--port", String(u.port || 9883),
        "--model-dir", cfg.cosyModelDir || "pretrained_models/CosyVoice2-0.5B",
      ];
      if (cfg.cosyRefAudio) args.push("--ref-audio", cfg.cosyRefAudio);
      log(`[cosy] starting: ${cfg.cosyPython || "python"} ${args.join(" ")}`);
      try {
        cosyState.logFd = fs.openSync(path.join(here, "cosy-server.log"), "a");
        cosyState.child = spawn(cfg.cosyPython || "python", args, {
          cwd: cfg.cosyWorkDir,
          windowsHide: true,
          stdio: ["ignore", cosyState.logFd, cosyState.logFd],
          env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
        });
      } catch (err) {
        throw new Error(`cosy spawn 失败: ${err && err.message}`);
      }
      cosyState.child.on("error", (err) => log(`[cosy] spawn error: ${err && err.message}`));
      cosyState.child.on("exit", (code) => { cosyState.ready = false; log(`[cosy] exited ${code}`); });
      const deadline = Date.now() + (Number(cfg.cosyStartTimeoutMs) || 180000);
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        if (interrupted) throw new Error("interrupted during cosy start");
        if (await pingCosy(1200)) { cosyState.ready = true; log("[cosy] ready"); return; }
      }
      throw new Error("[cosy] 启动超时");
    })().finally(() => { cosyState.starting = null; });
    return cosyState.starting;
  }

  async function cosySynth(text) {
    await ensureCosy();
    const r = await fetch(cosyBase() + "/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text,
        refAudio: cfg.cosyRefAudio || "",
        promptText: cfg.cosyPromptText || "",
        instruct: cfg.cosyInstruct || "",
        speed: Number(cfg.cosySpeed) || 1.0,
      }),
      signal: AbortSignal.timeout(Number(cfg.cosyTimeoutMs) || 180000),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`cosy http ${r.status} ${body.slice(0, 160)}`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1000) throw new Error("cosy 返回音频为空");
    const file = tmpPath(".wav");
    fs.writeFileSync(file, buf);
    return file;
  }

  async function speakCosy(text, done, sid) {
    try {
      await ensureCosy();
    } catch (err) {
      log(`cosy 不可用: ${err && err.message}; 回退 edge`);
      return speakEdge(text, done);
    }
    try {
      const chunks = splitSpeech(text);
      let next = chunks.length
        ? cosySynth(chunks[0]).catch((err) => { log(`cosy synth: ${err && err.message}`); return null; })
        : null;
      for (let i = 0; i < chunks.length; i++) {
        if (interrupted) {
          if (next) next.then((f) => { if (f) rm(f); }).catch(() => {});
          break;
        }
        const file = await next;
        next = i + 1 < chunks.length
          ? cosySynth(chunks[i + 1]).catch((err) => { log(`cosy synth: ${err && err.message}`); return null; })
          : null;
        if (interrupted) { if (file) rm(file); continue; }
        if (!file) { log("cosy chunk 失败，跳过该块"); continue; }
        await playFileAsync(file);
      }
    } catch (err) {
      log(`cosy speak: ${err && err.message}`);
    } finally {
      done();
    }
  }

  // ---- 按语种路由：中文走本机模型，日文/英文走 Edge ----
  function detectLang(text) {
    const kana = (text.match(/[\u3040-\u30ff]/g) || []).length;
    const han = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    const total = kana + han + latin;
    if (total === 0) return "zh";
    if (kana / total > 0.15) return "ja";
    if (latin / total > 0.6 && han / total < 0.2) return "en";
    return "zh";
  }

  // 语种路由要按「句」判断，不能先按长度拼块，否则会把中文和日文并在一起。
  function splitSentences(text) {
    const max = Math.max(40, Number(cfg.gsvMaxChunk) || 110);
    const parts = String(text)
      .split(/(?<=[。．.！？!?；;…\n])/)
      .map((s) => s.trim())
      .filter(Boolean);
    const out = [];
    for (const p of parts) {
      if (p.length <= max) out.push(p);
      else for (let i = 0; i < p.length; i += max) out.push(p.slice(i, i + max));
    }
    return out;
  }

  function buildSegments(text) {
    const out = [];
    for (const chunk of splitSentences(text)) {
      if (!/[\u4e00-\u9fff\u3040-\u30ffA-Za-z0-9]/.test(chunk)) continue; // 纯标点不送合成
      const lang = detectLang(chunk);
      const last = out[out.length - 1];
      if (last && last.lang === lang && last.text.length + chunk.length <= 160) {
        last.text += (lang === "en" ? " " : "") + chunk;
      } else out.push({ lang, text: chunk });
    }
    return out;
  }

  function edgeSynth(text, voice) {
    return new Promise((resolve) => {
      const txt = tmpPath(".txt");
      const mp3 = tmpPath(".mp3");
      try {
        fs.writeFileSync(txt, text, "utf8");
      } catch (err) {
        log(`edge synth write: ${err && err.message}`);
        return resolve(null);
      }
      const args = ["-m", "edge_tts", "--file", txt, "--write-media", mp3, "--voice", voice];
      if (cfg.edgeRate) args.push("--rate", String(cfg.edgeRate));
      if (cfg.edgeVolume) args.push("--volume", String(cfg.edgeVolume));
      const child = spawn(cfg.pythonPath || "python", args, { windowsHide: true, stdio: "ignore" });
      let ok = false;
      const finish = once(() => {
        rm(txt);
        if (!ok) rm(mp3);
        resolve(ok ? mp3 : null);
      });
      child.on("error", (err) => { log(`edge synth spawn: ${err && err.message}`); finish(); });
      child.on("exit", (code) => {
        try { ok = code === 0 && fs.statSync(mp3).size > 0; } catch { ok = false; }
        finish();
      });
    });
  }

  function synthSeg(seg, sid) {
    const bound = boundProfile(sid);
    const profile = bound || gsvForLang(seg.lang);
    if (profile) {
      // 会话绑定：同一个音色读所有语种，逐句把 text_lang 切到检测到的语种；
      // 未绑定：沿用原来「语种 -> 该语种档案自带 textLang」的行为。
      const textLang = bound ? seg.lang : profile.textLang;
      return gsvSynth(seg.text, profile, textLang).catch((err) => {
        log(`[${seg.lang}] gsv 失败，改走 edge: ${err && err.message}`);
        return edgeSynth(seg.text, seg.lang === "ja" ? cfg.jaVoice : seg.lang === "en" ? cfg.enVoice : cfg.edgeVoice);
      });
    }
    const voice = seg.lang === "ja" ? cfg.jaVoice : seg.lang === "en" ? cfg.enVoice : cfg.edgeVoice;
    return edgeSynth(seg.text, voice);
  }

  async function speakRouted(text, done, sid) {
    try {
      const segs = buildSegments(text);
      let next = segs.length ? synthSeg(segs[0], sid) : null;
      for (let i = 0; i < segs.length; i++) {
        if (interrupted) {
          if (next) next.then((f) => { if (f) rm(f); }).catch(() => {});
          break;
        }
        const file = await next;
        next = i + 1 < segs.length ? synthSeg(segs[i + 1], sid) : null;
        if (interrupted) { if (file) rm(file); continue; }
        if (!file) { await new Promise((r) => speakSapi(segs[i].text, r)); continue; }
        await playFileAsync(file);
      }
    } catch (err) {
      log(`routed speak: ${err && err.message}`);
    } finally {
      done();
    }
  }

  function speak(text, force = false, sid = "") {
    if (!text || text.length < cfg.minChars) return;
    const hash = crypto.createHash("sha1").update(text).digest("hex");
    const now = Date.now();
    if (!force && hash === lastHash && now - lastHashAt < cfg.dedupeSeconds * 1000) return;
    lastHash = hash;
    lastHashAt = now;

    queue.push({ text, sid: String(sid || "") });
    while (queue.length > 2) queue.shift(); // 积压时丢旧的，别越读越落后
    pump();
  }

  try {
    ctx.on("session/event", (session, event) => {
      try {
        if (!event) return;
        maybeReloadConfig();
        if (!cfg.enabled) return;
        recordSession(session, event);
        const sid = sessionIdOf(session, event);

        if (event.type === "user/message") {
          queue.length = 0;
          stopCurrent();
          return;
        }

        if (event.type !== "assistant/message") return;
        const data = event.data || {};
        const content = (data.message && data.message.content) || data.content;
        if (!Array.isArray(content)) return;

        if (cfg.finalOnly) {
          const hasToolCall = content.some((b) => b && b.type === "tool-call");
          if (hasToolCall) return;
        }

        const text = toSpeech(extractText(content), cfg);
        if (text) speak(text, false, sid);
      } catch (err) {
        log(`event error: ${err && err.message}`);
      }
    });
  } catch (err) {
    log(`apply error: ${err && err.message}`);
  }

  // 一键停止的本地旁路（只绑 127.0.0.1）。
  if (cfg.enabled) startStopServer();

  // 启动时按引擎预热，避免第一条回答干等模型加载。
  if (cfg.enabled && process.env.DSH_TTS_DRY !== "1") {
    if (cfg.engine === "cosyvoice") {
      ensureCosy().catch((err) => log(`[cosy] prewarm: ${err && err.message}`));
    } else {
      const profiles = gsvProfiles();
      (async () => {
        for (const p of profiles) {
          try { await ensureGsv(p); } catch (err) { log(`[${p.name}] gsv prewarm: ${err && err.message}`); }
        }
      })();
    }
  }
}
