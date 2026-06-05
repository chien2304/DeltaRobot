param(
    [string]$ToolchainBin = "",
    [string]$Source = "doancuoiky.cpp",
    [string]$Mcu = "atmega16"
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkspaceRoot = Split-Path -Parent $Root
$BuildDir = Join-Path $WorkspaceRoot "firmware_build"
$SourcePath = Join-Path $Root $Source
$BaseName = [System.IO.Path]::GetFileNameWithoutExtension($Source)
$BuildStamp = Get-Date -Format "yyyyMMdd_HHmmss"
$OutputBaseName = "${BaseName}_${BuildStamp}"
$ElfPath = Join-Path $BuildDir "$OutputBaseName.elf"
$HexPath = Join-Path $BuildDir "$OutputBaseName.hex"
$MapPath = Join-Path $BuildDir "$OutputBaseName.map"
$StableHexPath = Join-Path $BuildDir "$BaseName.hex"

function Find-ToolchainBin {
    param([string]$Requested)

    $candidates = @()

    if ($Requested) {
        $candidates += $Requested
    }

    if ($env:AVR_TOOLCHAIN_BIN) {
        $candidates += $env:AVR_TOOLCHAIN_BIN
    }

    $cmd = Get-Command "avr-g++.exe" -ErrorAction SilentlyContinue
    if ($cmd) {
        return (Split-Path -Parent $cmd.Source)
    }

    $candidates += @(
        "D:\Atmel Toolchain\AVR8 GCC\Native\3.4.1061\avr8-gnu-toolchain\bin",
        "C:\Program Files (x86)\Atmel\Studio\7.0\toolchain\avr8\avr8-gnu-toolchain\bin",
        "C:\Program Files (x86)\Microchip\Studio\7.0\toolchain\avr8\avr8-gnu-toolchain\bin",
        "C:\Program Files\Microchip\Studio\7.0\toolchain\avr8\avr8-gnu-toolchain\bin"
    )

    foreach ($dir in $candidates) {
        if ($dir -and (Test-Path (Join-Path $dir "avr-g++.exe"))) {
            return $dir
        }
    }

    $searchRoots = @(
        "D:\Atmel Toolchain",
        "C:\Program Files (x86)\Atmel",
        "C:\Program Files (x86)\Microchip",
        "C:\Program Files\Microchip"
    )

    foreach ($root in $searchRoots) {
        if (!(Test-Path $root)) {
            continue
        }

        $found = Get-ChildItem $root -Recurse -Filter "avr-g++.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1

        if ($found) {
            return $found.DirectoryName
        }
    }

    return $null
}

if (!(Test-Path $SourcePath)) {
    throw "Source file not found: $SourcePath"
}

$Bin = Find-ToolchainBin -Requested $ToolchainBin
if (!$Bin) {
    Write-Host "AVR toolchain not found." -ForegroundColor Red
    Write-Host ""
    Write-Host "Install Microchip Studio/AVR GNU Toolchain, or run:"
    Write-Host '  .\build_hex.ps1 -ToolchainBin "C:\path\to\avr8-gnu-toolchain\bin"'
    Write-Host ""
    Write-Host "You can also set AVR_TOOLCHAIN_BIN to the folder containing avr-g++.exe."
    exit 1
}

$AvrGxx = Join-Path $Bin "avr-g++.exe"
$Objcopy = Join-Path $Bin "avr-objcopy.exe"
$Size = Join-Path $Bin "avr-size.exe"

if (!(Test-Path $Objcopy)) {
    throw "avr-objcopy.exe not found in: $Bin"
}

New-Item -ItemType Directory -Force -Path $BuildDir | Out-Null

$compileArgs = @(
    "-mmcu=$Mcu",
    "-Os",
    "-std=gnu++11",
    "-funsigned-char",
    "-funsigned-bitfields",
    "-fpack-struct",
    "-fshort-enums",
    "-Wall",
    "-ffunction-sections",
    "-fdata-sections",
    "-Wl,--gc-sections",
    "-o",
    $ElfPath,
    $SourcePath
)

Write-Host "Using AVR toolchain: $Bin"
Write-Host "Compiling $Source -> build\$OutputBaseName.elf"
& $AvrGxx @compileArgs
if ($LASTEXITCODE -ne 0) {
    throw "avr-g++ failed with exit code $LASTEXITCODE"
}

Write-Host "Creating build\$OutputBaseName.hex"
& $Objcopy -O ihex -R .eeprom $ElfPath $HexPath
if ($LASTEXITCODE -ne 0) {
    throw "avr-objcopy failed with exit code $LASTEXITCODE"
}

if (Test-Path $Size) {
    & $Size --mcu=$Mcu --format=avr $ElfPath
    if ($LASTEXITCODE -ne 0) {
        throw "avr-size failed with exit code $LASTEXITCODE"
    }
}

try {
    Copy-Item -LiteralPath $HexPath -Destination $StableHexPath -Force
    Write-Host "Latest HEX copy: $StableHexPath" -ForegroundColor Green
} catch {
    Write-Host "Could not update latest HEX copy: $StableHexPath" -ForegroundColor Yellow
    Write-Host $_.Exception.Message -ForegroundColor Yellow
}

Write-Host ""
Write-Host "HEX ready: $HexPath" -ForegroundColor Green
