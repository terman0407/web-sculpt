# ---------------------------------------------------------------------------
# WebSculpt - static file server for the module version (index.html).
# Uses only stock Windows PowerShell; Node.js is not required.
#
#   powershell -ExecutionPolicy Bypass -File serve.ps1
#   powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8081
#
# NOTE: the single-file build (websculpt.html) needs no server at all -
#       just open it in the browser. This script is for hacking on js/ directly.
#
# This file is intentionally ASCII-only: Windows PowerShell 5.1 decodes .ps1
# files with the system code page unless a UTF-8 BOM is present, and a mangled
# multi-byte comment can swallow the following newline (and thus a line of
# real code). Keeping it ASCII makes it immune to that.
# ---------------------------------------------------------------------------

param(
  [int]$Port = 8080,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.obj'  = 'text/plain; charset=utf-8'
  '.wgsl' = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Write-Host "Could not bind port $Port : $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Try another port:  serve.ps1 -Port 8081"
  exit 1
}

Write-Host ""
Write-Host "  WebSculpt  ->  http://localhost:$Port/" -ForegroundColor Green
Write-Host "  Press Ctrl+C to stop."
Write-Host "  Serving: $root"
Write-Host ""

if (-not $NoBrowser) {
  Start-Process "http://localhost:$Port/"
}

$rootFull = [System.IO.Path]::GetFullPath($root)

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
      $path = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
      if ($path -eq '/' -or $path.EndsWith('/')) { $path = $path + 'index.html' }
      $rel = $path.TrimStart([char]'/', [char]'\')
      $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))

      # Reject anything that escapes the served directory.
      if (-not $full.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        $res.StatusCode = 403
        $res.Close()
        continue
      }

      if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
        $res.StatusCode = 404
        $body = [System.Text.Encoding]::UTF8.GetBytes('Not found')
        $res.ContentLength64 = $body.Length
        $res.OutputStream.Write($body, 0, $body.Length)
        $res.Close()
        continue
      }

      $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $ct = $mime[$ext]
      if (-not $ct) { $ct = 'application/octet-stream' }

      # Read as raw bytes so file contents are never re-encoded.
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.StatusCode = 200
      $res.ContentType = $ct
      $res.ContentLength64 = $bytes.Length
      $res.Headers.Add('Cache-Control', 'no-cache')
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      try { $res.StatusCode = 500 } catch { }
    } finally {
      try { $res.Close() } catch { }
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
