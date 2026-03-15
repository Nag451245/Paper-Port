$root = $PSScriptRoot

Write-Host "Building backend..." -ForegroundColor Cyan
Set-Location "$root\server"
npm run build

Write-Host "Building frontend..." -ForegroundColor Cyan
Set-Location "$root\frontend"
npm run build

Write-Host "Starting all services..." -ForegroundColor Green

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\server'; npm start"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; npm run preview"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\server\breeze-bridge'; python app.py"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\engine'; cargo build --release; .\target\release\capital-guard-engine.exe"

Write-Host "All services launched!" -ForegroundColor Green
