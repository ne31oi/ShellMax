<#
.SYNOPSIS
  Installs the standalone ComfyUI engine for ShellMax into .\comfy (idempotent).

.DESCRIPTION
  - downloads the official ComfyUI portable (NVIDIA) release
  - pins ComfyUI core to the commit the MiniMax H3 workflow was validated on
  - installs sageattention / triton-windows pinned to a known-good stack (RTX 50xx, sm120)
  - clones only the custom node packs the workflow needs, at pinned commits
  - links ShellMax's own nodes (comfy_nodes\shellmax_nodes) via a junction
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

$NodePacks = @(
    @{ Name = 'ComfyUI-KJNodes';                    Url = 'https://github.com/kijai/ComfyUI-KJNodes';                       Commit = '203eb357743402b437db8ae973a062a9b15387d2' },
    @{ Name = 'ComfyUI-VideoHelperSuite';           Url = 'https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite';        Commit = '4ee72c065db22c9d96c2427954dc69e7b908444b' },
    @{ Name = 'Comfyui_Minimax_h3_latent_Upscaler'; Url = 'https://github.com/LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler'; Commit = '04f71594d11325be877b5ba05096fcb851c29048' }
)
$DebugPacks = @(
    @{ Name = 'rgthree-comfy';     Url = 'https://github.com/rgthree/rgthree-comfy';   Commit = '' },
    @{ Name = 'ComfyUI-Easy-Use';  Url = 'https://github.com/yolain/ComfyUI-Easy-Use'; Commit = '' }
)

# node classes the ShellMax graph uses; verified against /object_info
$RequiredClasses = @(
    'MiniMaxH3ReferenceToVideo', 'BlockSparseAttention', 'ModelAttentionBackend', 'ExtendIntermediateSigmas',
    'LTXVSeparateAVLatent', 'LTXVConcatAVLatent', 'ComfyMathExpression', 'ResolutionSelector',
    'PrimitiveFloat', 'PrimitiveStringMultiline', 'SamplerCustomAdvanced', 'BasicGuider', 'BasicScheduler',
    'KSamplerSelect', 'RandomNoise', 'DisableNoise', 'SplitSigmas', 'VAEDecode', 'VAEDecodeAudio',
    'LoadImage', 'LoadAudio',
    'MiniMaxH3MemoryEfficientSageAttentionPatch', 'MiniMaxLowVRAMAttention', 'MiniMaxChunkFeedForward',
    'VHS_VideoCombine', 'VHS_LoadVideo', 'MinimaxH3LatentUpscaler3D',
    'ShellMaxUNETLoaderByPath', 'ShellMaxCLIPLoaderByPath', 'ShellMaxVAELoaderByPath',
    'ShellMaxLoraLoaderByPath', 'ShellMaxLoraModelOnlyByPath', 'ShellMaxLatentUpscalerByPath'
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
Ok 'triton-windows и sageattention установлены'

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

# ---------------------------------------------------------------- 5. shellmax nodes
Step '5/7 ноды ShellMax'
# copied, not linked: exFAT volumes support neither symlinks nor junctions.
# The backend re-syncs this copy before every engine start.
$dest = Join-Path $CustomNodes 'shellmax_nodes'
$src  = Join-Path $Root 'comfy_nodes\shellmax_nodes'
robocopy $src $dest /MIR /XD __pycache__ /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "не удалось скопировать $src -> $dest" }
$global:LASTEXITCODE = 0
Ok "$src -> $dest"

# ---------------------------------------------------------------- 6. models
Step '6/7 extra_model_paths.yaml (модели из существующей установки)'
$models = $Config.legacy_models_dir -replace '\\', '/'
if (-not (Test-Path $models)) { Write-Host "    внимание: папка моделей не найдена: $models" -ForegroundColor Yellow }
$yaml = @"
# generated by scripts/install_comfy.ps1 - models are shared, not copied
shellmax_shared:
    base_path: $models
    diffusion_models: diffusion_models
    text_encoders: text_encoders
    vae: vae
    vae_approx: vae_approx
    loras: loras
    latent_upscale_models: latent_upscale_models
"@
# UTF-8 without BOM: PS 5.1's -Encoding utf8 would prepend a BOM to the first yaml key
[IO.File]::WriteAllText((Join-Path $Core 'extra_model_paths.yaml'), $yaml, (New-Object Text.UTF8Encoding $false))
Ok $models

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
