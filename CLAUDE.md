# Soundboard

App desktop multiplataforma (Windows, macOS, Linux) feito em Electron: o usuário importa arquivos de áudio, vincula cada um a uma tecla (ou combinação) e toca o som ao apertar a tecla. Interface em português (pt-BR), sem framework e sem dependências de runtime.

## Estrutura

- `src/main.js`: processo principal. Janela, persistência, IPC e atalhos globais (`globalShortcut`).
- `src/preload.js`: expõe `window.api` via `contextBridge` (contextIsolation ligado, nodeIntegration desligado).
- `src/renderer/`: UI em HTML/CSS/JS puro (`index.html`, `styles.css`, `renderer.js`). No renderer, `window.api` é referenciado como `sb`; não declare `const api`, porque colide com o global exposto.

## Dados

- Ficam em `app.getPath('userData')` (no Windows, `%APPDATA%\Soundboard`).
- `soundboard.json` guarda `{ globalHotkeys, masterVolume, stopAccelerator, stopKeyLabel, sounds[] }` (`stop*` é a tecla de "parar tudo", que dispara `stop-all` como atalho global). Cada som tem `id, file, name, accelerator, keyLabel, volume, color`.
- Os áudios importados são **copiados** para `sounds/<uuid>.<ext>`, então o original pode ser apagado.

## Teclas

- O renderer converte `KeyboardEvent.code` em accelerator do Electron (`eventToShortcut`), por exemplo `Control+1`, `F1`, `num5`. O mesmo accelerator serve tanto para o atalho local quanto para o global.
- Uma tecla pertence a um só som (ou à tecla de parar tudo); ao reatribuir, o main remove a tecla do dono anterior.
- Com atalhos globais ligados, o main dispara `play` via IPC e o keydown local é ignorado, para não tocar duas vezes. A exceção são os accelerators em `failedHotkeys`, que o sistema recusou; esses continuam funcionando só com a janela em foco.

## Comandos

```bash
npm start          # roda em modo dev
npm run dist:win   # build Windows -> dist/ (o instalador NSIS precisa do Wine no Linux; sem ele sai só dist/win-unpacked)
npm run dist:mac   # só num Mac
npm run dist:linux # AppImage + .deb
```

## Ambiente do dono (WSL2)

- Para rodar `npm start` no WSL é preciso instalar `libnss3` e `libasound2t64`.
- O `.exe` do Windows **não abre** a partir de `\\wsl.localhost\...` (a GPU e o renderer falham ao iniciar a partir de caminho UNC). Copie `dist/win-unpacked` para o disco C:; hoje a cópia fica em `C:\Users\atzle\Soundboard`.
