# Soundboard

App desktop multiplataforma (Windows, macOS, Linux) feito em Electron: o usuário importa arquivos de áudio, vincula cada um a uma tecla (ou combinação) e toca o som ao apertar a tecla. Interface em português (pt-BR), sem framework e sem dependências de runtime.

## Estrutura

- `src/main.js`: processo principal. Janela, persistência, IPC e atalhos globais (`globalShortcut`).
- `src/keyboard.js` + `src/keyboard-helper.ps1`: (só Windows) descobre de qual teclado veio cada tecla. O `.ps1` compila um C# com `Add-Type` que escuta o Raw Input (`RIDEV_INPUTSINK`), e o `keyboard.js` converte scancode em `KeyboardEvent.code`. O script é copiado para a pasta de dados antes de rodar, porque o PowerShell não lê de dentro do `app.asar`.
- `src/preload.js`: expõe `window.api` via `contextBridge` (contextIsolation ligado, nodeIntegration desligado).
- `src/renderer/`: UI em HTML/CSS/JS puro (`index.html`, `styles.css`, `renderer.js`). No renderer, `window.api` é referenciado como `sb`; não declare `const api`, porque colide com o global exposto.
- Layout: sidebar (perfis + configurações gerais; vira gaveta abaixo de 760px), topo com busca e tabela de sons (`#list`, linhas do `rowTpl`). Adicionar e editar som é pelo modal `#editor`; a captura de tecla (`#capture`) abre por cima dele.

## Dados

- Ficam em `app.getPath('userData')` (no Windows, `%APPDATA%\Soundboard`).
- `soundboard.json` guarda `{ masterVolume, exclusive, outputDevice, theme, sort, stopAccelerator, stopKeyLabel, activeProfile, profiles[] }`. `theme` é `'system' | 'light' | 'dark'`, e `sort` é `{ by: 'added' | 'name' | 'key', dir: 'asc' | 'desc' }`, a ordem da tabela. `stop*` é a tecla de "parar tudo", que dispara `stop-all` como atalho global. `exclusive` liga o "um som por vez". `inputDevice` (`{ id, label }` ou `null`) é o teclado escolhido; o `id` é o `VID_xxxx&PID_xxxx(&MI_xx)` do caminho do dispositivo. `outputDevice` é o `deviceId` da saída de áudio (`'default'` = padrão do sistema), aplicado com `setSinkId`.
- Cada perfil tem `id, name, accelerator, keyLabel, sounds[]`, e cada som tem `id, file, name, accelerator, keyLabel, volume, color, start, end`. `start`/`end` são o trecho tocado, em segundos (`end: null` = até o fim): o corte não mexe no arquivo, e o renderer para o som no fim por timer. O `publicState()` manda ao renderer só os sons do perfil ativo, em `sounds`.
- Configs antigas, com `sounds[]` na raiz, são migradas para um perfil "Principal" no `loadConfig`.
- Os áudios importados são **copiados** para `sounds/<uuid>.<ext>`, então o original pode ser apagado. A cópia só acontece ao confirmar o modal (`sounds:add`); antes disso `sounds:pick`/`sounds:check` só devolvem candidatos, e `sounds:read` manda os bytes para a forma de onda.

## Teclas

- O renderer converte `KeyboardEvent.code` em accelerator do Electron (`eventToShortcut`), por exemplo `Control+1`, `F1`, `num5`. O mesmo accelerator serve tanto para o atalho local quanto para o global.
- Uma tecla pertence a um só dono (`releaseAccelerator` no main). As teclas de som valem só dentro do próprio perfil, então dois perfis podem usar a mesma tecla. Já "parar tudo" e as teclas de troca de perfil valem sempre, e por isso tiram a tecla dos sons de todos os perfis.
- Todo som precisa de tecla: o modal não salva sem ela, e o `Backspace` na captura só remove as teclas de "parar tudo" e de perfil. Se a tecla escolhida já era de outro som, ela é movida e o outro fica sem tecla (aparece com ⚠).
- Durante a captura de tecla, o renderer chama `setCapturing(true)` e o main desliga os atalhos globais. Sem isso o sistema "engole" uma tecla já registrada e ela não chega à janela.
- No Windows, com o NumLock desligado, o teclado numérico manda End, setas etc., e o atalho global `numN` não dispara. Nesse caso o keydown local trata a tecla (`numpadWithoutNumLock`).
- Com um teclado escolhido (`deviceMode()` no main), o `globalShortcut` fica desligado: o main manda `device-key` só para as teclas desse teclado, e o renderer ignora os keydowns locais vinculados. Os modificadores valem vindos de qualquer teclado (o numpad não tem Ctrl). O Raw Input só observa, então a tecla continua chegando ao app em foco. Se o auxiliar falhar, `keyboardError` é preenchido e o app volta ao `globalShortcut`.
- Os atalhos globais estão sempre ligados (a antiga chave `globalHotkeys` é apagada no `loadConfig`): o app é para rodar em segundo plano, como um Stream Deck. Fechar a janela só a esconde (o áudio toca no renderer, então ela não pode ser destruída). Sai-se pela bandeja (`Tray`, Windows/Linux, ícone em `src/assets/tray.png`) ou Cmd+Q, e o `before-quit` libera o fechamento. Há trava de instância única.
- O main dispara `play` via IPC e o keydown local é ignorado, para não tocar duas vezes. A exceção são os accelerators em `failedHotkeys`, que o sistema recusou; esses continuam funcionando só com a janela em foco.

## Tema

- O renderer aplica o tema com `data-theme` no `<html>` (tokens de cor em `:root` e `:root[data-theme="light"]`). O `nativeTheme` fica sempre em `system`, porque forçá-lo mudaria o `prefers-color-scheme` e o modo "Sistema" deixaria de ver o tema real.
- O tema salvo chega ao preload por `additionalArguments` (`initialTheme`), para a primeira pintura não piscar. A troca usa `document.startViewTransition` com um `clip-path` em círculo a partir do botão.

## Comandos

```bash
npm start          # roda em modo dev
npm run dist:win   # build Windows -> dist/ (o instalador NSIS precisa do Wine no Linux; sem ele sai só dist/win-unpacked)
npm run dist:mac   # só num Mac
npm run dist:linux # AppImage + .deb
```

## Release

- `.github/workflows/release.yml`: um push de tag `v*` gera os instaladores em runners Windows, macOS (x64 + arm64) e Linux e publica na Release do GitHub. A versão do `package.json` é sobrescrita pela tag durante o build.
- Os nomes dos arquivos são fixos, sem versão (`artifactName` no `package.json`), para os links `releases/latest/download/...` do README não quebrarem. Não mude esses nomes sem atualizar o README.
- Não há assinatura de código (sem certificados), e os avisos que o usuário vê estão documentados no README. No Mac o app é assinado ad-hoc (`mac.identity: "-"`, `hardenedRuntime: false`). Sem nenhuma assinatura, o build arm64 abre como "danificado", e o hardened runtime com ad-hoc impede o Electron Framework de carregar.

## Ambiente do dono (WSL2)

- Para rodar `npm start` no WSL é preciso instalar `libnss3` e `libasound2t64`. No terminal do VS Code, rode `env -u ELECTRON_RUN_AS_NODE npm start`: a extensão exporta essa variável, e com ela o Electron roda como Node puro (`ipcMain` fica `undefined`).
- O `.exe` do Windows **não abre** a partir de `\\wsl.localhost\...` (a GPU e o renderer falham ao iniciar a partir de caminho UNC). Copie `dist/win-unpacked` para o disco C:; hoje a cópia fica em `C:\Users\atzle\Soundboard`.
