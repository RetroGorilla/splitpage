$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8791

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
try {
    $listener.Start()
} catch {
    Write-Host "Could not start on port $port - it may already be in use."
    Write-Host "Close any other running Splitpage window and try again, or edit `$port in this script."
    Read-Host "Press Enter to close"
    exit 1
}

Write-Host "Splitpage is running at http://localhost:$port/"
Write-Host "Leave this window open while you work. Close it (or press Ctrl+C) to stop the server."
Start-Process "http://localhost:$port/"

$mime = @{
    ".html"        = "text/html; charset=utf-8"
    ".js"          = "text/javascript; charset=utf-8"
    ".json"        = "application/json; charset=utf-8"
    ".webmanifest" = "application/manifest+json; charset=utf-8"
    ".svg"         = "image/svg+xml"
    ".png"         = "image/png"
    ".ico"         = "image/x-icon"
}

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        try {
            $reqPath = $request.Url.AbsolutePath
            if ($reqPath -eq "/") { $reqPath = "/index.html" }
            $filePath = [System.IO.Path]::GetFullPath((Join-Path $root $reqPath.TrimStart("/")))

            if (-not $filePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
                $response.StatusCode = 403
            } elseif (-not (Test-Path $filePath -PathType Leaf)) {
                $response.StatusCode = 404
                $bytes = [System.Text.Encoding]::UTF8.GetBytes("Not found: $reqPath")
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            } else {
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                if ($mime.ContainsKey($ext)) { $response.ContentType = $mime[$ext] } else { $response.ContentType = "application/octet-stream" }
                $bytes = [System.IO.File]::ReadAllBytes($filePath)
                $response.ContentLength64 = $bytes.Length
                $response.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } catch {
            $response.StatusCode = 500
        } finally {
            $response.OutputStream.Close()
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
