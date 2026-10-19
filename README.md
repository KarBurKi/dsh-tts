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
| `dedupeSeconds` | `120` | 同一段文字在这段时间内不重复读 |

> 提示：`engine` 可以是 `edge`（在线）、`sapi`（离线）或 `gpt_sovits`（本机模型）；本机当前用 `gpt_sovits`。

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

## 排错

- 日志：`<home>\.dsh\plugins\dsh-tts\tts.log`（合成失败会记 `fallback to sapi`）
- 只看不发声：环境变量 `DSH_TTS_DRY=1` 启动 DSH，文本会写进日志
- Edge 没声音但有 SAPI 声音：检查联网、`python -m edge_tts --help`、`ffplay -version`
- 完全没声音：跑上面的手动试听；确认系统有音频输出设备

## 卸载

1. `profiles\desktop\package.json` 的 `bundles` 与 `dependencies` 里删掉 `@dsh-tts/speech`
2. 删掉 `<home>\.dsh\plugins\dsh-tts` 目录
3. 可选：`python -m pip uninstall edge-tts`
