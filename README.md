# dsh-tts —— 让 DSH 把回答读出来

把 assistant 的**最终文字回答**读出来。默认用微软 Edge 在线语音（晓晓，自然音色），断网或合成失败时自动回退到 Windows 自带离线语音（SAPI）。

> DSH 本身只有「语音输入」（录音转文字），没有「朗读输出」。这个插件补上输出这一半。

## 依赖

| 引擎 | 需要 |
| --- | --- |
| `edge`（默认） | Python 3 + `edge-tts`（已装）+ `ffplay`（已在 PATH，ffmpeg 自带）+ 联网 |
| `sapi`（回退） | 无，Windows 自带 |

```powershell
python -m pip install edge-tts   # 已经装好，换机器时用
```

## 装在哪

- 插件源码：`<home>\.dsh\plugins\dsh-tts`
- 挂载：`<home>\.dsh\profiles\desktop\package.json` 的 `dsh.profile.bundles` 里有 `@dsh-tts/speech`
- 依赖是 `link:` 指向插件目录，改代码不用重装，重启 DSH 生效

## 生效方式

完全退出 DSH 桌面版再打开（托盘退出，不是关窗口）。
启动后每条**不含工具调用**的 assistant 消息会被朗读；你发新问题时，正在读的旧回答会被打断。

## 立即试听（不经过 DSH）

Edge 音色：

```powershell
python -m edge_tts --text "你好，我是深海，这是晓晓的声音。" --write-media "$env:TEMP\t.mp3" --voice zh-CN-XiaoxiaoNeural
ffplay -nodisp -autoexit -loglevel quiet "$env:TEMP\t.mp3"
```

离线 SAPI 音色：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<home>\.dsh\plugins\dsh-tts\speak.ps1" -Text "你好，我是深海。"
```

## 配置：`config.json`（改完重启 DSH 生效）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `engine` | `"edge"` | `edge` = 在线自然音色；`sapi` = 离线系统音色 |
| `finalOnly` | `true` | 只读最终回答；`false` 时中间步骤也读 |
| `edgeVoice` | `"zh-CN-XiaoxiaoNeural"` | 晓晓。可选 `zh-CN-YunxiNeural`（云希，男）、`zh-CN-XiaoyiNeural`（晓伊）、`zh-CN-YunyangNeural`（云扬，播音腔） |
| `edgeRate` | `"+0%"` | 语速，如 `"+10%"` / `"-10%"` |
| `edgeVolume` | `"+0%"` | 音量增益，如 `"+20%"` |
| `playerVolume` | `100` | 播放音量 0~100（`0` 静音，调试用） |
| `pythonPath` | `"python"` | Python 可执行文件 |
| `voice` | `""` | SAPI 回退时的音色，空 = 系统默认 |
| `rate` | `0` | SAPI 语速 -10~10 |
| `volume` | `100` | SAPI 音量 0~100 |
| `maxChars` | `1200` | 单条最多读多少字，超出按句号截断 |
| `minChars` | `2` | 短于这个长度不读 |
| `skipCodeBlocks` | `true` | 跳过 ``` 代码块 |
| `polish` | `"rules"` | 朗读稿净化：`rules` = 开，`off` = 只做原来的去标记 |
| `dedupeSeconds` | `120` | 同一段文字在这段时间内不重复读 |
| `chunkGapMs` | `120` | 句与句之间的换气时间（毫秒） |
| `paraGapMs` | `520` | 段落之间的停顿（毫秒），听着才像在讲话 |
| `gsvPrewarm` | `"zh"` | 启动时预热哪一路：`zh` / `en` / `ja` / `all` / `off` |
| `gsvIdleExitMinutes` | `20` | 这么久没合成过就掐掉 GSV 进程（`0` = 不掐） |
| `rewrite` | `"off"` | `ollama` = 合成前先让本地小模型把稿子改口播 |
| `rewriteApi` | `http://127.0.0.1:11434` | Ollama 地址 |
| `rewriteModel` | `"qwen3:4b"` | 改写用哪个模型 |
| `rewriteTimeoutMs` | `20000` | 改写超时就退回原文，不卡朗读 |

> 提示：`engine` 可以是 `edge`（在线）、`sapi`（离线）、`gpt_sovits`（本机模型）或 `cosyvoice`（本机零样本克隆）；本机当前用 `gpt_sovits`。

## 显存：按需开，用完就还

GSV 是个吃显存的大户——中文 / 英文 / 日文三路各一个进程，全开约 **7.8 GB**。开着它打不了大型游戏，所以给了三层收放：

| 什么时候 | 怎么收 |
| --- | --- |
| 启动 | 只预热 `gsvPrewarm` 指定的那一路（默认 `zh`，约 2.6 GB）；`off` = 一个都不开 |
| 闲着 | 超过 `gsvIdleExitMinutes`（默认 20）没合成过，自动掐掉进程，显存归零 |
| 立刻要玩 | 双击 **`release.bat`**：掐掉正在读的 + 把 GSV 全收掉，跑完顺手打一行 `nvidia-smi` |

`release.bat` 打的是本地旁路 `http://127.0.0.1:9889/release`，返回 `{"ok":true,"killed":3}` 就是收干净了。查当前状态：

```powershell
curl http://127.0.0.1:9889/status
# {"ok":true,"speaking":false,"queued":0,"models":{"http://127.0.0.1:9880":{"ready":true,"pid":3372}}}
```

**代价**：进程被收掉之后再要朗读，第一句要等模型冷启动（几十秒，`gsvStartTimeoutMs` 默认 120 秒上限）。所以 `gsvIdleExitMinutes` 别调太小，3 分钟以下会频繁重启。

想更省事：平时 `gsvPrewarm` 设 `off`，只听声音时手动拉；或者干脆玩之前双击 `release.bat`，玩完不用管，下次朗读它会自己起来。

## 让朗读别带书面腔

三层，从便宜到贵：

**用词**（`polish.js` 的 `COLLOQUIAL` 表，零成本）。`因此→所以`、`然而→但是`、`该方案→这个方案`、`具有→有`、`较为显著→比较明显`、`诸多→很多`、`综上所述→总的来说`……改词不改意思。`该 / 其 / 即` 这类会误伤的（应该、其中、即使）只按固定后缀换。

**停顿**（`chunkGapMs` / `paraGapMs`）。原来块与块之间靠播放器收尾的自然间隙，听着像一句一句往外蹦；现在句间 120 ms、段间 520 ms。

**句式**（要模型，上限也最高）。规则不敢拆长定语，一拆就把意思改歪。开了 `rewrite: "ollama"` 后，合成前先让本地小模型把稿子改一遍：拆长句、换语序、去术语。失败就用原文，不耽误读。

**叹词**（`softenInterjections`）。句首的「啊，」「哎，」会被念成一板一眼的报幕腔——模型在训练数据里只见过叹词夹在完整句子中间，没见过孤立一个字的叹。实测换成波浪号最灵：

```
啊，你来了呀    2.02 秒
啊~你来了呀     3.14 秒    多出来的一秒就是那声「叹」
啊——你来了呀   2.26 秒    破折号反而没用
```

所以句首（或标点后）的「叹词 + 逗号」一律换成 `叹词 + ~`。句中「这样啊，」不是叹词，不动。主人 2026-10-21 听过 12 种写法的对比，原话：「带 `，` 会比较奇怪，其他的都还好」。

> 参考音频的脾气也会被模型照抄——播音腔的参考录出来就是播音腔。本机当前中文还是单条参考（`gsvRefAudio`）；多情绪参考的素材已备好并验过两组，等新模型重测后再接进插件。

## 朗读稿净化（`polish`）

朗读前把「写给人看」的 Markdown 改成「念出来不别扭」的口语稿，规则在 `polish.js`：零依赖、毫秒级、确定性。

- 代码块、表格、URL 不念
- 路径只念文件名：`C:\...\config.json` → `config.json`
- 年份逐位念（`2026 年` → `二零二六年`），百分比加「百分之」，千分位逗号去掉
- 列表项自动补句号，制造停顿
- 超过 42 字的句子，在「因为 / 但是 / 所以 / 然后」前插逗号
- 抹掉引号和落单星号，括号统一成全角，`--` → `——`
- 书面词换口语词（`COLLOQUIAL` 表，约 40 条，见上面「让朗读别带书面腔」）

实测对比：`tts-ab/compare.mp3`（同一音色，前半是净化前、后半是净化后），生成于 2026-10-20。

## 中途停止朗读

四个入口，随便挑一个顺手的：

| 方式 | 操作 | 效果 |
| --- | --- | --- |
| 按钮 | 输入框左下按钮排最右端那个「喇叭打叉」 | 清空待读队列 + 立刻 kill 当前 ffplay |
| 发消息 | 在对话框发任意一条（哪怕一个标点） | 同上 |
| 双击 | `stop.bat` | 同上，不需要打字，也不用切回 DSH |
| 浏览器 | 收藏 `http://127.0.0.1:9889/stop`，点一下 | 同上 |

- 端口在 `config.json` 的 `stopPort` 改，默认 `9889`；只绑 `127.0.0.1`，外网碰不到。
- 服务随 DSH 启动；`enabled: false` 时不启动。
- 想确认当前在不在读：`http://127.0.0.1:9889/status` 返回 `{"ok":true,"speaking":true,"queued":0}`。
- 嫌长是另一个问题：`maxChars` 调小（默认 1200）比中途掐更省事。

### 按钮是怎么塞进去的（`client.js`）

按钮不在 host 侧，在浏览器侧——GUI 的那排按钮归 Web 前端管，Node 插件碰不到 DOM。

| 环节 | 做法 |
| --- | --- |
| 声明 | `package.json` 里 `dsh.client.platform = "web"`，`exports["./client"] = "./client.js"` |
| 入口形态 | `window.__ModuleLoader__.load({ id, factory })`，导出 `apply` / `inject`（DSH 客户端插件强制要求，原生 ESM 会被拒） |
| 挂载点 | `[data-composer-seat]`，再取里面最左边的 `button` 当锚点 |
| 样式 | `cloneNode(true)` 复制 `+` 按钮，白拿尺寸、圆角、边框、hover、主题色，只换里面图标 |
| 活着 | `MutationObserver` 盯 body，React 重渲染把按钮冲掉后 120ms 内补回 |
| 点击 | `fetch("http://127.0.0.1:9889/stop")`，host 侧回了 `access-control-allow-origin`，跨端口才通 |

**已知脆点**：这套定位靠 DOM 结构，GUI 改版把 `[data-composer-seat]` 或左侧按钮组换掉就会失效；届时按钮消失，`stop.bat` 和发消息两个老入口仍然可用。

### 中文模型重训（2026-10-20）

| | 旧 | 新 |
| --- | --- | --- |
| GPT | `dania-e15.ckpt` | `dania2-e15.ckpt` |
| SoVITS | `dania_e16_s2192.pth` | `dania2_e15_s285.pth` |
| 训练数据 | 来路不明的长音频切片（切片目录已清空） | 游戏语音 50 条，约 7 分钟，48 kHz 原声降到 32k |
| 轮数 | 15 / 16 | 15 / 15，batch 6 |

**为什么换**：参考音频只负责音色，音域来自模型权重学到的韵律分布。旧模型念长段汇报会塌，新模型宽一些——同一句 11.9 s → 9.9 s，不再拖着走。

**v2ProPlus 的四步预处理**：`1-get-text` → `2-get-hubert-wav32k` → `2-get-sv` → `3-get-semantic`。踩过的两个坑：

- 漏跑 `2-get-sv`，`TextAudioSpeakerLoader` 会在 `assert os.path.exists(path7)` 处失败——v2ProPlus 多要一份 `7-sv_cn` 特征。
- `logs/<实验名>/logs_s2_v2ProPlus` 目录要先建，否则第 5 轮存 checkpoint 时 `FileNotFoundError` 直接中断训练。

命令行训练（不必开 WebUI）：

```powershell
# SoVITS：改 GPT_SoVITS/configs/s2v2ProPlus.json，写 TEMP\tmp_s2.json
.\runtime\python.exe -s GPT_SoVITS\s2_train.py --config TEMP\tmp_s2.json
# GPT：改 GPT_SoVITS/configs/s1longer-v2.yaml，写 TEMP\tmp_s1.yaml
$env:hz="25hz"; .\runtime\python.exe -s GPT_SoVITS\s1_train.py --config_file TEMP\tmp_s1.yaml
```

s2 约 15 分钟、s1 约 20 分钟。`s1_train` 收尾时会在 rich 打印阶段抛 `UnicodeEncodeError`（控制台 GBK 装不下 `•`），此时 ckpt 已经写完，可以忽略。

## GPT-SoVITS 本机模型与按会话绑定

| 字段 | 说明 |
| --- | --- |
| `gsvApi` / `gsvJa.api` / `gsvEn.api` | 中文 / 日文 / 英文各自的本地服务端口（9880 / 9882 / 9881） |
| `gsvGptWeights` / `gsvVitsWeights` | 中文音色的 GPT / SoVITS 权重（绝对路径） |
| `gsvRefAudio` / `gsvPromptText` / `gsvPromptLang` | 参考音频、提示文本、提示语种 |
| `gsvJa` / `gsvEn` | 日文 / 英文音色档案（字段同上） |
| `sessionVoices` | 按会话绑定：`{ "<sessionId>": { api, gptWeights, vitsWeights, version, refAudio, promptText, promptLang, textLang } }` |

**优先级**：`sessionVoices[sessionId]` > 按语种路由（zh / en / ja 三个档案）> Edge / SAPI 兜底。

- 会话绑定后，该会话整段回答都用这一副嗓子；逐句按检测到的语言切换 `text_lang`（中文模型读日文、日文模型读中文都实测通过）。
- 同一端口被不同会话 / 语种复用时，插件调用 `api_v2.py` 的 `/set_gpt_weights`、`/set_sovits_weights` 热切换权重，不用重启服务。
- 会话 ID 由插件写进 `current-session.json`（每次 `session/event` 刷新，记录 `id`/`title`/`cwd`）。
- 绑定命令在 `~/.dsh/skills/roleplay/scripts/voices.py`：`sessions`、`bind --session current --name <角色> --lang <ja|zh>`、`unbind --session current`。
- 改 `config.json` 后，dsh-tts 会在下一条消息前自动热重载（按 mtime 检测）；插件版本旧时需重启 DSH。

> 提示：`gsvJa` / `gsvEn` 的权重路径要指向 `<运行时>\GPT_weights_v4\*.ckpt` 与 `SoVITS_weights_v4\*.pth`（参考音频不同名时手动配对），不要写成 `模型\<语种>\<角色>\...` —— 那里只有参考音频。

## 按句换情绪

同一个音色，念技术结论和日常汇报不该是同一副语气。中文档案可以挂一组情绪参考：

```json
"emotionRefs": {
  "soft":    { "refAudio": "...\\refs\\soft.wav",    "promptText": "见到我很意外吗？……" },
  "playful": { "refAudio": "...\\refs\\playful.wav", "promptText": "在这哦~一点惊喜！……" },
  "threat":  { "refAudio": "...\\refs\\threat.wav",  "promptText": "安静！不许动！好吧，又来？" }
}
```

合成前按句子内容挑一组，把 `ref_audio_path` / `prompt_text` 换成那一组。GSV 这两个是请求参数，不是加载项，所以**逐块换情绪不重载权重**，开销只有每块读一次参考 wav。

匹配规则在 `index.js` 的 `EMOTION_RULES`：

| 组 | 命中词（节选） |
| --- | --- |
| `threat` | 别怪、后果、否则、保证、后悔、小心、你敢、试试看、不客气 |
| `playful` | 哈哈、嘿嘿、猜猜、惊喜、好玩、有意思、才不 |
| 其余一律 | `soft` |

……这套规则很粗，宁可漏判也不乱判：真正的底色是 `soft`，只在明摆着的威胁或俏皮句上换一下。

**参考音频怎么来的**：从训练素材里挑同一语气的一组，每条之间补 0.30 秒气口拼到 3~10 秒（GSV 硬性要求），脚本见 `docs/情绪参考.md`。

两条实测教训：

- **一组里语气必须统一**。硬的掺软的拼在一起，模型学的不是「这个人有两种语气」，而是「每句话内部在两种语气之间跳」，听起来忽上忽下。
- **气声多的素材不能当威胁用**。参考里气声重，模型会照着学，威胁听起来像要断气。

## CosyVoice（零样本克隆）

`engine` 改成 `"cosyvoice"` 后，朗读走本机 CosyVoice2/3：**换音色只需换一条参考音频**，不训练、不切权重。
插件会在需要时用 `cosyWorkDir` 里的 Python 拉起 `cosyvoice_server.py`（本目录），失败则回退 Edge。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `cosyApi` | `http://127.0.0.1:9883` | 本地服务地址（与 GSV 的 9880/9881/9882 错开） |
| `cosyPython` | `""` | 跑 CosyVoice 的 Python（conda 环境的绝对路径），空 = `python` |
| `cosyWorkDir` | `""` | CosyVoice 仓库根目录（`import cosyvoice` 能找到的地方） |
| `cosyModelDir` | `pretrained_models/CosyVoice2-0.5B` | 相对 `cosyWorkDir`，或绝对路径 |
| `cosyRefAudio` | `""` | 参考音频，**单声道、尽量干净、3–25 秒** |
| `cosyPromptText` | `""` | 参考音频里说的那句话（逐字对照） |
| `cosyInstruct` | `""` | 自然语言控制指令，如 `用四川话说这句话`、`用温柔的语气`；留空走零样本 |
| `cosySpeed` | `1.0` | 语速 |
| `cosyStartTimeoutMs` / `cosyTimeoutMs` | `180000` | 起服务 / 单块合成的超时 |

服务端只有一个接口，方便手工验证：

```powershell
curl http://127.0.0.1:9883/health
curl -X POST http://127.0.0.1:9883/tts -H "content-type: application/json" `
  -d '{\"text\":\"测试一句\",\"refAudio\":\"D:/ref.wav\",\"promptText\":\"参考音频原文\"}' -o out.wav
```

**限制**：`sessionVoices` 目前只对 `gpt_sovits` 生效；CosyVoice 走全局单音色（`cosyRefAudio`）。
**部署前提**：本机需要 conda + CosyVoice 环境 + 模型；Windows 上的 pynini / Matcha-TTS / spk2info 三坑见对话记录。环境没备好时，`cosyvoice` 会静默回退 Edge，不影响使用。

## 排错

- 日志：`<home>\.dsh\plugins\dsh-tts\tts.log`（合成失败会记 `fallback to sapi`）
- 只看不发声：环境变量 `DSH_TTS_DRY=1` 启动 DSH，文本会写进日志
- Edge 没声音但有 SAPI 声音：检查联网、`python -m edge_tts --help`、`ffplay -version`
- 完全没声音：跑上面的手动试听；确认系统有音频输出设备

## 卸载

1. `profiles\desktop\package.json` 的 `bundles` 与 `dependencies` 里删掉 `@dsh-tts/speech`
2. 删掉 `<home>\.dsh\plugins\dsh-tts` 目录
3. 可选：`python -m pip uninstall edge-tts`
