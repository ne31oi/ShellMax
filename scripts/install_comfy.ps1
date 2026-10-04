<#
.SYNOPSIS
  Installs the standalone ComfyUI engine for ShellMax into .\comfy (idempotent).

.DESCRIPTION
  - downloads the official ComfyUI portable (NVIDIA) release
  - pins ComfyUI core to the commit the MiniMax H3 workflow was validated on
  - installs sageattention / triton-windows pinned to a known-good stack (RTX 50xx, sm120)
  - clones only the custom node packs the workflow needs, at pinned commits
  - copies the project's own node packs (comfy_nodes\*) into the engine
  - points ComfyUI at the existing models folder (no copying)
  - verifies sol-attn / sageattention and that all required node classes load

  Re-running is safe: finished steps are detected and skipped.

.PARAMETER WithDebugNodes
  Also install rgthree-comfy and ComfyUI-Easy-Use so the ORIGINAL workflow json
  can be opened in the engine's own UI for debugging. Not needed by ShellMax.
#>
param(
    [switch]$WithDebugNodes,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- pins
$ReleaseTag     = 'v0.37.0'
$ReleaseAsset   = 'ComfyUI_windows_portable_nvidia.7z'
$ReleaseUrl     = "https://github.com/Comfy-Org/ComfyUI/releases/download/$ReleaseTag/$ReleaseAsset"
$CoreCommit     = 'b0f4b7b294ce482a2e071d9d762c133d38c7aa07'
$SevenZipUrl    = 'https://www.7-zip.org/a/7zr.exe'
$SageWheelUrl   = 'https://github.com/woct0rdho/SageAttention/releases/download/v2.2.0-windows.post4/sageattention-2.2.0%2Bcu130torch2.9.0andhigher.post4-cp39-abi3-win_amd64.whl'
$TritonSpec     = 'triton-windows==3.6.0.post25'
$OnnxSpec       = 'onnxruntime-gpu==1.24.4'   # insightface (face identity in H3FaceTrackCrop) runs on it

$NodePacks = @(
    @{ Name = 'ComfyUI-DLSS5-Enhancer'; Url = 'https://github.com/Blueforcer/ComfyUI-DLSS5-Enhancer'; Commit = '796ed5927a202ba50b5c929cd08e16b365041162' },
    @{ Name = 'MaskVidExperiments'; Url = 'https://github.com/drozbay/MaskVidExperiments'; Commit = 'c32ed8c17e6fe892a174ebf25fe98b1317de97fb' },
    @{ Name = 'comfyui-controlnet-aux'; Url = 'https://github.com/comfyorg/comfyui-controlnet-aux'; Commit = '83463c2e4b04e729268e57f638b4212e0da4badc' },
    @{ Name = 'H3-Optimizations'; Url = 'https://github.com/Zironic/H3-Optimizations'; Commit = '862774944a331bc1a66cee1cf805b94bd138ebbe' },
    @{ Name = 'ComfyUI-KJNodes';                    Url = 'https://github.com/kijai/ComfyUI-KJNodes';                       Commit = '203eb357743402b437db8ae973a062a9b15387d2' },
    @{ Name = 'ComfyUI-VideoHelperSuite';           Url = 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite';        Commit = '4ee72c065db22c9d96c2427954dc69e7b908444b' },
    @{ Name = 'Comfyui_Minimax_h3_latent_Upscaler'; Url = 'https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler'; Commit = '04f71594d11325be877b5ba05096fcb851c29048' },
    # face refine (MiniMax_H3_FaceRefine_Best): face tracking / stitching and the "Load Image & Crop" node
    @{ Name = 'ComfyUI-H3-FaceRefine';              Url = 'https://github.com/Carasibana/ComfyUI-H3-FaceRefine';             Commit = 'd8521d14fe0d721d80cd9417fff5a559cbc21aba' },
    @{ Name = 'comfyui-obvpm';                      Url = 'https://github.com/obvpm/comfyui-obvpm';                          Commit = '7d5b977add00c2fb9690dca9a5f20023a47c8a80' },
    @{ Name = 'ComfyUI-Fantastic-MiniMaxH3-PromptBuilder'; Url = 'https://github.com/Adudeguyman/ComfyUI-Fantastic-MiniMaxH3-PromptBuilder'; Commit = '6ba597137a7249e15b8edbf2fc061ab7d0808035' }
)
$DebugPacks = @(
    @{ Name = 'rgthree-comfy';     Url = 'https://github.com/rgthree/rgthree-comfy';   Commit = '' },
    @{ Name = 'ComfyUI-Easy-Use';  Url = 'https://github.com/yolain/ComfyUI-Easy-Use'; Commit = '' }
)

# node classes the ShellMax graph uses; verified against /object_info
$RequiredClasses = @(
    'DLSS5Settings', 'DLSS5EnhanceImages', 'DLSS5EnhanceVideoFile', 'VHS_LoadVideoFromFilenames', 'VHS_InsertMetadataToVideo', 'ShellMaxVideoPathToFilenames',
    'VHS_LoadVideoFFmpegPath', 'GetImageSize', 'SAM3_TrackToMask', 'SolidMask', 'SetLatentNoiseMask', 'VAEEncodeAudio', 'VAEEncode', 'MaskComposite', 'GrowMaskWithBlur', 'VRAM_Debug', 'RemoveBackground', 'CLIPTextEncode',
    'MVEx_SubjectCrop', 'MVEx_SubjectUncrop', 'MVEx_MaskCleanup', 'MVEx_MaskToLatentSpace', 'DWPreprocessor', 'MiniMaxH3FunControlNetApply', 'ShellMaxModelPatchLoaderByPath', 'ShellMaxBackgroundRemovalLoaderByPath', 'ShellMaxBodySwapSource', 'ShellMaxBodySwapRestoreHands', 'ShellMaxBodySwapBackground', 'ShellMaxBodySwapFitComposite',
    'ShellMaxH3HeadSwapTrack', 'ShellMaxH3HeadSwapMasks', 'ShellMaxH3HeadSwapContours', 'ShellMaxH3HeadSwapTemporal', 'ShellMaxH3HeadSwapStitch', 'ShellMaxH3HeadSwapPad', 'ShellMaxH3HeadSwapRestore', 'ShellMaxLatentUpscalerDimensionsByPath',
    'MiniMaxH3AddGuide', 'MiniMaxH3SigmaShift', 'EmptyMiniMaxH3LatentAV', 'TextGenerate', 'StringConcatenate', 'CFGGuider', 'ManualSigmas', 'ImageResizeKJv2',
    'H3MemoryOptimization', 'H3AIMDOResidencyLimiter', 'H3SparseAttentionAdvanced',
    'ShellMaxUpscaleModelLoaderByPath', 'ImageUpscaleWithModel', 'ImageScale',
    'MiniMaxH3ReferenceToVideo', 'BlockSparseAttention', 'ModelAttentionBackend', 'ExtendIntermediateSigmas',
    'LTXVSeparateAVLatent', 'LTXVConcatAVLatent', 'ComfyMathExpression', 'ResolutionSelector',
    'PrimitiveFloat', 'PrimitiveStringMultiline', 'SamplerCustomAdvanced', 'BasicGuider', 'BasicScheduler',
    'KSamplerSelect', 'RandomNoise', 'DisableNoise', 'SplitSigmas', 'VAEDecode', 'VAEDecodeAudio',
    'LoadImage', 'LoadAudio',
    'MiniMaxH3MemoryEfficientSageAttentionPatch', 'MiniMaxLowVRAMAttention', 'MiniMaxChunkFeedForward',
    'VHS_VideoCombine', 'VHS_LoadVideo', 'MinimaxH3LatentUpscaler3D',
    'ShellMaxUNETLoaderByPath', 'ShellMaxCLIPLoaderByPath', 'ShellMaxVAELoaderByPath',
    'ShellMaxLoraLoaderByPath', 'ShellMaxLoraModelOnlyByPath', 'ShellMaxLatentUpscalerByPath',
    # face refine
    'VHS_LoadVideoPath', 'H3FaceTrackCrop', 'H3InjectVideoLatent', 'H3PerFrameDenoise', 'H3FaceStitch',
    'MiniMaxH3NativeAudioLock', 'LoadImageCrop', 'PreviewAny',
    # SeedVR2 enhance
    'SeedVR2Preprocess', 'SeedVR2PostProcessing', 'SeedVR2Conditioning',
    'SeedVR2TemporalChunk', 'SeedVR2TemporalMerge', 'ImageScaleBy',
    'VAEEncodeTiled', 'VAEDecodeTiled', 'KSampler',
    # frame interpolation (RIFE / FILM)
    'FrameInterpolate', 'ShellMaxFrameInterpLoaderByPath',
    'MiniMaxH3RefModStack', 'MiniMaxH3FantasticRefModTextEncode', 'MiniMaxH3FantasticRefModCreate',
    'MiniMaxH3FantasticEditComposite', 'ShellMaxH3ReferenceBundle', 'ShellMaxH3MaskEditBundle', 'ShellMaxCheckpointLoaderByPath', 'MiniMaxH3FantasticObjectMask', 'SAM3_VideoTrack', 'ShellMaxH3ObjectMask'
)

# ---------------------------------------------------------------- paths
$Root        = Split-Path -Parent $PSScriptRoot
$Config      = Get-Content (Join-Path $Root 'config\comfy.json') -Raw | ConvertFrom-Json
$ComfyRoot   = Join-Path $Root 'comfy'
$Tools       = Join-Path $ComfyRoot 'tools'
$Downloads   = Join-Path $ComfyRoot 'downloads'
$Portable    = Join-Path $Root $Config.portable_dir
$Core        = Join-Path $Portable 'ComfyUI'
$Python      = Join-Path $Portable 'python_embeded\python.exe'
$CustomNodes = Join-Path $Core 'custom_nodes'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    ok: $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "`n[ОШИБКА] $msg" -ForegroundColor Red; exit 1 }

function Invoke-Native {
    # run a native command, fail loudly on non-zero exit
    param([string]$Exe, [string[]]$ArgList)
    & $Exe @ArgList
    if ($LASTEXITCODE -ne 0) { Fail "$Exe $($ArgList -join ' ') -> exit $LASTEXITCODE" }
}

function Invoke-Git { param([string[]]$ArgList) Invoke-Native 'git' (@('-c', 'safe.directory=*') + $ArgList) }

function Get-File($url, $dest) {
    if (Test-Path $dest) { Ok "уже скачано: $(Split-Path -Leaf $dest)"; return }
    $part = "$dest.part"
    Write-Host "    скачиваю $url"
    # curl.exe resumes (-C -) if a previous attempt was interrupted
    Invoke-Native 'curl.exe' @('-L', '--fail', '--retry', '5', '-C', '-', '-o', $part, $url)
    Move-Item $part $dest
}

New-Item -ItemType Directory -Force $Tools, $Downloads | Out-Null

# ---------------------------------------------------------------- 1. portable
Step "1/7 ComfyUI portable $ReleaseTag"
if (Test-Path $Python) {
    Ok 'portable уже распакован'
} else {
    $sevenZip = Join-Path $Tools '7zr.exe'
    Get-File $SevenZipUrl $sevenZip
    $archive = Join-Path $Downloads $ReleaseAsset
    Get-File $ReleaseUrl $archive
    Write-Host '    распаковываю (несколько минут)...'
    Invoke-Native $sevenZip @('x', $archive, "-o$ComfyRoot", '-y', '-bso0', '-bsp1')
    if (-not (Test-Path $Python)) { Fail "после распаковки не найден $Python" }
    Ok 'распаковано'
}

# ---------------------------------------------------------------- 2. core commit
Step "2/7 ядро ComfyUI -> $($CoreCommit.Substring(0,7))"
if (Test-Path (Join-Path $Core '.git')) {
    $head = (& git -c safe.directory=* -C $Core rev-parse HEAD).Trim()
    if ($head -ne $CoreCommit) {
        # portable ships a shallow/detached checkout; fetch the exact commit
        Invoke-Git @('-C', $Core, 'fetch', '--quiet', 'origin', $CoreCommit)
        Invoke-Git @('-C', $Core, 'checkout', '--quiet', '--force', $CoreCommit)
    }
    Ok "HEAD = $CoreCommit"
} else {
    Write-Host '    в portable нет .git — клонирую ядро заново' -ForegroundColor Yellow
    $tmp = "$Core.git-tmp"
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Invoke-Git @('clone', '--quiet', 'https://github.com/Comfy-Org/ComfyUI', $tmp)
    Invoke-Git @('-C', $tmp, 'checkout', '--quiet', $CoreCommit)
    # keep portable's user/models/input/output dirs, replace code only
    Move-Item (Join-Path $tmp '.git') (Join-Path $Core '.git')
    Invoke-Git @('-C', $Core, 'checkout', '--quiet', '--force', $CoreCommit)
    Remove-Item -Recurse -Force $tmp
    Ok "HEAD = $CoreCommit"
}
Invoke-Native $Python @('-s', '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', (Join-Path $Core 'requirements.txt'))
Ok 'requirements.txt установлены'

# ---------------------------------------------------------------- 3. accel stack
Step '3/7 torch / triton / sageattention'
$torchInfo = & $Python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.is_available(), torch.cuda.get_device_capability() if torch.cuda.is_available() else '')"
Write-Host "    torch: $torchInfo"
if ($torchInfo -notmatch 'True') { Fail 'torch не видит CUDA. Обновите драйвер NVIDIA.' }
Invoke-Native $Python @('-s', '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', $TritonSpec)
Invoke-Native $Python @('-s', '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-deps', $SageWheelUrl)
Invoke-Native $Python @('-s', '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', $OnnxSpec)
Ok 'triton-windows, sageattention и onnxruntime-gpu установлены'

# ---------------------------------------------------------------- 4. node packs
Step '4/7 пакеты нод'
$packs = $NodePacks
if ($WithDebugNodes) { $packs = $packs + $DebugPacks }
foreach ($p in $packs) {
    $dir = Join-Path $CustomNodes $p.Name
    if (-not (Test-Path (Join-Path $dir '.git'))) {
        Invoke-Git @('clone', '--quiet', $p.Url, $dir)
    }
    if ($p.Commit) {
        $head = (& git -c safe.directory=* -C $dir rev-parse HEAD).Trim()
        if ($head -ne $p.Commit) {
            Invoke-Git @('-C', $dir, 'fetch', '--quiet', 'origin')
            Invoke-Git @('-C', $dir, 'checkout', '--quiet', '--force', $p.Commit)
        }
    }
    $req = Join-Path $dir 'requirements.txt'
    if (Test-Path $req) {
        Invoke-Native $Python @('-s', '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '-r', $req)
    }
    Ok "$($p.Name) @ $(if ($p.Commit) { $p.Commit.Substring(0,7) } else { 'latest' })"
}

# The pinned KJNodes predates the core attention override argument (upstream #750).
Invoke-Native $Python @('-s', (Join-Path $Root 'backend\app\comfy\compat.py'), $CustomNodes)

# ---------------------------------------------------------------- 5. shellmax nodes
Step '5/7 ноды из проекта (comfy_nodes\*)'
# copied, not linked: exFAT volumes support neither symlinks nor junctions.
# The backend re-syncs these copies before every engine start.
foreach ($pack in Get-ChildItem (Join-Path $Root 'comfy_nodes') -Directory) {
    $dest = Join-Path $CustomNodes $pack.Name
    robocopy $pack.FullName $dest /MIR /XD __pycache__ /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "не удалось скопировать $($pack.FullName) -> $dest" }
    $global:LASTEXITCODE = 0
    Ok "$($pack.Name)"
}

# ---------------------------------------------------------------- 6. models
Invoke-Native $Python @('-s', (Join-Path $Root 'scripts\install_dlss5.py'))

Step '6/7 extra_model_paths.yaml (модели из существующей установки)'
$models = $Config.legacy_models_dir -replace '\\', '/'
if (-not (Test-Path $models)) { Write-Host "    внимание: папка моделей не найдена: $models" -ForegroundColor Yellow }
$yaml = @"
# generated by scripts/install_comfy.ps1 - models are shared, not copied
shellmax_refmods:
    base_path: $($Core -replace '\\', '/')/models
    refmods: refmods
shellmax_shared:
    base_path: $models
    diffusion_models: diffusion_models
    text_encoders: text_encoders
    vae: vae
    vae_approx: vae_approx
    loras: loras
    latent_upscale_models: latent_upscale_models
    ultralytics: ultralytics
    refmods: refmods
"@
# UTF-8 without BOM: PS 5.1's -Encoding utf8 would prepend a BOM to the first yaml key
[IO.File]::WriteAllText((Join-Path $Core 'extra_model_paths.yaml'), $yaml, (New-Object Text.UTF8Encoding $false))
Ok $models

# insightface looks only in the engine's own models\insightface (no extra paths); the pack is small, copy it
$insightSrc = Join-Path $Config.legacy_models_dir 'insightface/models/buffalo_l'
$insightDst = Join-Path $Core 'models/insightface/models/buffalo_l'
if ((Test-Path $insightSrc) -and -not (Test-Path (Join-Path $insightDst 'w600k_r50.onnx'))) {
    robocopy $insightSrc $insightDst /E /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "не удалось скопировать insightface buffalo_l" }
    $global:LASTEXITCODE = 0
    Ok 'insightface buffalo_l скопирован'
} elseif (Test-Path $insightDst) {
    Ok 'insightface buffalo_l уже на месте'
} else {
    Write-Host '    insightface buffalo_l скачается при первом улучшении лица' -ForegroundColor Yellow
}

# SeedVR2 models for enhance (shared models folder; no copy of weights into the engine)
Step '6b/7 модели SeedVR2 (детализация)'
$seedVrDir = Join-Path $Config.legacy_models_dir 'diffusion_models'
$seedVaeDir = Join-Path $Config.legacy_models_dir 'vae'
$seed3b = Join-Path $seedVrDir 'seedvr2_3b_int8_convrot.safetensors'
$seed7b = Join-Path $seedVrDir 'seedvr2_7b_int8_convrot.safetensors'
$seedVae = Join-Path $seedVaeDir 'seedvr2_ema_vae_fp16.safetensors'
$emaVae = Join-Path $seedVaeDir 'ema_vae_fp16.safetensors'
New-Item -ItemType Directory -Force -Path $seedVrDir, $seedVaeDir | Out-Null
if (-not (Test-Path $seedVae)) {
    if (Test-Path $emaVae) {
        Copy-Item $emaVae $seedVae
        Ok 'vae/seedvr2_ema_vae_fp16.safetensors (копия ema_vae_fp16)'
    } else {
        Write-Host '    скачиваю seedvr2_ema_vae_fp16…' -ForegroundColor Yellow
        Invoke-WebRequest -Uri 'https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/vae/seedvr2_ema_vae_fp16.safetensors' -OutFile $seedVae -UseBasicParsing
        Ok 'vae/seedvr2_ema_vae_fp16.safetensors'
    }
} else { Ok 'vae/seedvr2_ema_vae_fp16.safetensors уже на месте' }
if (-not (Test-Path $seed3b) -and -not (Test-Path $seed7b)) {
    Write-Host '    скачиваю seedvr2_3b_int8_convrot (для 16 ГБ VRAM)…' -ForegroundColor Yellow
    Invoke-WebRequest -Uri 'https://huggingface.co/Comfy-Org/SeedVR2/resolve/main/diffusion_models/seedvr2_3b_int8_convrot.safetensors' -OutFile $seed3b -UseBasicParsing
    Ok 'diffusion_models/seedvr2_3b_int8_convrot.safetensors'
} elseif (Test-Path $seed3b) {
    Ok 'seedvr2_3b_int8 уже на месте'
} else {
    Ok 'seedvr2_7b_int8 будет использован как fallback (3B предпочтительнее на 16 ГБ)'
}

# Frame interpolation models (native RIFE / FILM)
Step '6c/7 модели интерполяции кадров'
$interpDir = Join-Path $Config.legacy_models_dir 'frame_interpolation'
New-Item -ItemType Directory -Force -Path $interpDir | Out-Null
$rife = Join-Path $interpDir 'rife_v4.26.safetensors'
$film = Join-Path $interpDir 'film_net_fp16.safetensors'
$rifeFb = Join-Path $Config.legacy_models_dir 'rife\rife49.pth'
if (-not (Test-Path $rife) -and -not (Test-Path $rifeFb)) {
    Write-Host '    скачиваю rife_v4.26.safetensors…' -ForegroundColor Yellow
    Invoke-WebRequest -Uri 'https://huggingface.co/Comfy-Org/frame_interpolation/resolve/main/rife_v4.26.safetensors' -OutFile $rife -UseBasicParsing
    Ok 'frame_interpolation/rife_v4.26.safetensors'
} elseif (Test-Path $rife) {
    Ok 'rife_v4.26 уже на месте'
} else {
    Ok 'rife49.pth будет использован как fallback'
}
if (-not (Test-Path $film)) {
    Write-Host '    скачиваю film_net_fp16.safetensors…' -ForegroundColor Yellow
    Invoke-WebRequest -Uri 'https://huggingface.co/Comfy-Org/frame_interpolation/resolve/main/film_net_fp16.safetensors' -OutFile $film -UseBasicParsing
    Ok 'frame_interpolation/film_net_fp16.safetensors'
} else {
    Ok 'film_net_fp16 уже на месте'
}

# ---------------------------------------------------------------- 7. verify
if ($SkipVerify) { Write-Host "`nпроверка пропущена (-SkipVerify)"; exit 0 }
Step '7/7 проверка движка'
$check = @'
import sys, torch
import comfy_kitchen as ck
import sageattention
dev = torch.device("cuda")
ok = ck.sol_attn_is_available(dev)
print("sageattention", getattr(sageattention, "__version__", "?"), "| sol_attn", ok, "|", torch.cuda.get_device_name(0))
sys.exit(0 if ok else 3)
'@
$check | & $Python -s -
if ($LASTEXITCODE -ne 0) { Fail 'sol-attn недоступен для этой видеокарты — генерация не будет совпадать с воркфлоу.' }
Ok 'sol-attn и sageattention доступны'

Write-Host '    запускаю ComfyUI headless для проверки нод...'
$port = [int]$Config.port + 1   # temp port so a running engine is not disturbed
$log  = Join-Path $ComfyRoot 'verify.log'
$argsList = @($Config.args) + @('--port', "$port", '--listen', '127.0.0.1')
$env:TORCHDYNAMO_DISABLE = '1'
$proc = Start-Process -FilePath $Python -ArgumentList $argsList -WorkingDirectory $Portable -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
try {
    $info = $null
    for ($i = 0; $i -lt 180 -and -not $info; $i++) {
        Start-Sleep -Seconds 2
        if ($proc.HasExited) { Fail "ComfyUI завершился при старте, см. $log.err" }
        try { $info = Invoke-RestMethod -Uri "http://127.0.0.1:$port/object_info" -TimeoutSec 30 } catch { }
    }
    if (-not $info) { Fail "ComfyUI не ответил за 6 минут, см. $log.err" }
    $names = $info.PSObject.Properties.Name
    $missing = $RequiredClasses | Where-Object { $names -notcontains $_ }
    if ($missing) { Fail "не загрузились ноды: $($missing -join ', ') (см. $log.err)" }
    Ok "все $($RequiredClasses.Count) нужных нод на месте"
} finally {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
}

Write-Host "`nГотово. Движок: $Portable" -ForegroundColor Green
