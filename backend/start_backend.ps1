# start_backend.ps1
# Always uses the venv's uvicorn — bypasses Anaconda path conflict
$venvUvicorn = Join-Path $PSScriptRoot "..\venv\Scripts\uvicorn.exe"
Set-Location $PSScriptRoot
& $venvUvicorn app.main:app --reload
