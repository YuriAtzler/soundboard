# Troca o .exe portatil pela versao nova depois que o Soundboard fecha (ver updater.js).
# O .exe fica travado enquanto o app roda (ele extrai o app para uma pasta temporaria e espera
# o app sair), entao a copia e tentada ate dar certo, por no maximo 60 segundos.
param([string]$New, [string]$Exe, [switch]$Relaunch)

for ($i = 0; $i -lt 60; $i++) {
  try {
    Copy-Item -LiteralPath $New -Destination $Exe -Force -ErrorAction Stop
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}
Remove-Item -LiteralPath $New -Force -ErrorAction SilentlyContinue
if ($Relaunch) { Start-Process -FilePath $Exe }
