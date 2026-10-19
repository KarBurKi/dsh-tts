# -*- coding: utf-8 -*-
# dsh-tts 朗读器：用 Windows 自带的 System.Speech（SAPI）把文本读出来。
# 由 index.js 以子进程方式调用；也可手动测试：
#   powershell -NoProfile -ExecutionPolicy Bypass -File speak.ps1 -Text "你好，这是一段测试"
# 无网络、无第三方依赖。
param(
    [string]$TextFile = "",
    [string]$Text = "",
    [string]$Voice = "",
    [int]$Rate = 0,
    [int]$Volume = 100,
    [string]$WaveOut = ""
)

$ErrorActionPreference = "Stop"

try {
    Add-Type -AssemblyName System.Speech

    if ($TextFile) {
        $content = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
    } else {
        $content = $Text
    }

    if (-not $content -or $content.Trim().Length -eq 0) { exit 0 }

    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try {
        if ($Voice) {
            try { $synth.SelectVoice($Voice) } catch { }
        }
        $synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
        $synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))

        if ($WaveOut) {
            $synth.SetOutputToWaveFile($WaveOut)
        }
        $synth.Speak($content)
    } finally {
        $synth.Dispose()
    }
    exit 0
} catch {
    [Console]::Error.WriteLine("dsh-tts speak failed: " + $_.Exception.Message)
    exit 1
}