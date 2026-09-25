# Soundboard

App desktop multiplataforma (Windows, macOS, Linux) feito em Electron: o usuário importa arquivos de áudio, vincula cada um a uma tecla (ou combinação) e toca o som ao apertar a tecla. Interface em português (pt-BR) e inglês, sem framework. A única dependência de runtime é o `electron-updater`; o resto (inclusive o ZIP do `.soundboard`) é escrito à mão, então não adicione dependências sem necessidade.

## Estrutura

- `src/main.js`: processo principal. Janela, persistência, IPC e atalhos globais (`globalShortcut`).
- `src/keyboard.js` + `src/keyboard-helper.ps1`: (só Windows) descobre de qual teclado veio cada tecla. O `.ps1` compila um C# com `Add-Type` que escuta o Raw Input (`RIDEV_INPUTSINK`), e o `keyboard.js` converte scancode em `KeyboardEvent.code`. O script é copiado para a pasta de dados antes de rodar, porque o PowerShell não lê de dentro do `app.asar`.
- `src/archive.js`: leitor e escritor de ZIP sem dependências, usado pelo `.soundboard`. Grava sem compressão; lê sem compressão ou deflate. Não tem ZIP64 (limite de 4 GB).
- `src/link.js`: baixa um áudio de um link ("Importar de link"): o arquivo direto ou uma página que aponte para ele (`og:audio`, o `play('...')` do MyInstants ou o primeiro link de áudio). Usa o `net.fetch` do Electron, porque o `fetch` do Node leva 403 do Cloudflare no MyInstants. Lança erros com `code`, traduzidos com as chaves `link.*`.
- `src/updater.js`: atualização pelo app (ver "Atualização").
- `src/i18n.js` + `src/locales/*.json`: textos da interface (ver "Idiomas").
- `src/preload.js`: expõe `window.api` via `contextBridge` (contextIsolation ligado, nodeIntegration desligado).
- `src/renderer/`: UI em HTML/CSS/JS puro (`index.html`, `styles.css`, `renderer.js`). No renderer, `window.api` é referenciado como `sb`; não declare `const api`, porque colide com o global exposto.
- Layout: sidebar (perfis; no pé, aviso de atualização, seletor de tema e o item Configurações; vira gaveta abaixo de 760px) e a área principal, que alterna pelo `data-view` do `<body>`: `sounds` (topo com busca e tabela `#list`, linhas do `rowTpl`) ou `settings` (`#settingsView`, um card `.setting` por opção). Adicionar e editar som é pelo modal `#editor`; a captura de tecla (`#capture`) abre por cima dele. O menu ⋯ dos perfis e o do + usam o popover genérico `openPopover(items, at, owner)`.

## Dados

- Ficam em `app.getPath('userData')` (no Windows, `%APPDATA%\Soundboard`).
- `soundboard.json` guarda `{ masterVolume, exclusive, outputDevice, theme, language, sort, closeToTray, trayNoticeShown, stopAccelerator, stopKeyLabel, activeProfile, profiles[] }`. `closeToTray` diz se o ✕ esconde (padrão) ou sai, e `trayNoticeShown` marca que o aviso "continua rodando" já apareceu. `theme` é `'system' | 'light' | 'dark'`, e `sort` é `{ by: 'added' | 'name' | 'key', dir: 'asc' | 'desc' }`, a ordem da tabela. `stop*` é a tecla de "parar tudo", que dispara `stop-all` como atalho global. `exclusive` liga o "um som por vez". `inputDevice` (`{ id, label }` ou `null`) é o teclado escolhido; o `id` é o `VID_xxxx&PID_xxxx(&MI_xx)` do caminho do dispositivo. `outputDevice` é o `deviceId` da saída de áudio (`'default'` = padrão do sistema), aplicado com `setSinkId`.
- Cada perfil tem `id, name, accelerator, keyLabel, sounds[]`, e cada som tem `id, file, name, accelerator, keyLabel, volume, color, start, end`. `start`/`end` são o trecho tocado, em segundos (`end: null` = até o fim): o corte não mexe no arquivo, e o renderer para o som no fim por timer. O `publicState()` manda ao renderer só os sons do perfil ativo, em `sounds`.
- Configs antigas, com `sounds[]` na raiz, são migradas para um perfil "Principal" no `loadConfig`.
- Os áudios importados são **copiados** para `sounds/<uuid>.<ext>`, então o original pode ser apagado. A cópia só acontece ao confirmar o modal (`sounds:add`); antes disso `sounds:pick`/`sounds:check` só devolvem candidatos, e `sounds:read` manda os bytes para a forma de onda. O `sounds:link` baixa o áudio de um link para `<temp>/soundboard-links` e devolve um candidato igual; o `sounds:add` apaga o temporário depois de copiar, e a pasta é limpa ao abrir e ao sair. O link chega pelo menu do +, colado (Ctrl+V fora de campo de texto) ou arrastado do navegador.

## Teclas

- O renderer converte `KeyboardEvent.code` em accelerator do Electron (`eventToShortcut`), por exemplo `Control+1`, `F1`, `num5`. O mesmo accelerator serve tanto para o atalho local quanto para o global.
- Uma tecla pertence a um só dono (`releaseAccelerator` no main). As teclas de som valem só dentro do próprio perfil, então dois perfis podem usar a mesma tecla. Já "parar tudo" e as teclas de troca de perfil valem sempre, e por isso tiram a tecla dos sons de todos os perfis.
- Todo som precisa de tecla: o modal não salva sem ela, e o `Backspace` na captura só remove as teclas de "parar tudo" e de perfil. Se a tecla escolhida já era de outro som, ela é movida e o outro fica sem tecla (aparece com ⚠).
- Durante a captura de tecla, o renderer chama `setCapturing(true)` e o main desliga os atalhos globais. Sem isso o sistema "engole" uma tecla já registrada e ela não chega à janela.
- No Windows, com o NumLock desligado, o teclado numérico manda End, setas etc., e o atalho global `numN` não dispara. Nesse caso o keydown local trata a tecla (`numpadWithoutNumLock`).
- O "." do numpad ABNT2 (e de teclados de PC no Mac) manda `NumpadComma`, que o Electron não tem como accelerator. Ele vira `numdec`, mas o atalho global `numdec` registra outra tecla física, então essa só funciona pelo keydown local, com o app em foco (`focusOnlyKey`).
- No Mac, o `LayoutAwareGlobalHotkeys` do Chromium fica desligado (`disable-features` no main). Com ele, o atalho global ia para a primeira tecla que produz o caractere no layout, e o `num1` virava o `1` de cima (o mesmo com `.` e `/` do numpad). Sem ele vale a tecla física, como na captura.
- Com um teclado escolhido (`deviceMode()` no main), o `globalShortcut` fica desligado: o main manda `device-key` só para as teclas desse teclado, e o renderer ignora os keydowns locais vinculados. Os modificadores valem vindos de qualquer teclado (o numpad não tem Ctrl). O Raw Input só observa, então a tecla continua chegando ao app em foco. Se o auxiliar falhar, `keyboardError` é preenchido e o app volta ao `globalShortcut`.
- Os atalhos globais estão sempre ligados (a antiga chave `globalHotkeys` é apagada no `loadConfig`): o app é para rodar em segundo plano, como um Stream Deck. Fechar a janela só a esconde (o áudio toca no renderer, então ela não pode ser destruída), a não ser com `closeToTray: false`. Sai-se pela bandeja (`Tray`, Windows/Linux, ícone em `src/assets/tray.png`) ou Cmd+Q, e o `before-quit` libera o fechamento. Há trava de instância única.
- O main dispara `play` via IPC e o keydown local é ignorado, para não tocar duas vezes. A exceção são os accelerators em `failedHotkeys`, que o sistema recusou; esses continuam funcionando só com a janela em foco.

## Exportar, importar e backup

- Um `.soundboard` é um ZIP com `soundboard.json` (`{ format: 'soundboard-export', version, type: 'profile' | 'backup', app, profiles[], settings? }`, perfis sem ids) e os áudios em `sounds/`. `EXPORT_VERSION` sobe só se o formato mudar de um jeito que versões antigas não entendam; um arquivo de versão maior é recusado.
- A importação (`importProfiles` no main) gera ids e nomes de arquivo novos: o caminho de dentro do ZIP nunca vira caminho no disco. Nome repetido vira "Nome (2)". A tecla do perfil só entra se estiver livre; a de um som só perde para "parar tudo" e as teclas de perfil. O retorno conta `droppedKeys` e `missing` para o toast.
- O backup leva as configurações de `BACKUP_SETTINGS` (não leva `outputDevice` nem `inputDevice`, que dependem do computador). Restaurar pergunta (`showMessageBox`) se junta ou substitui; substituir importa antes de apagar os perfis antigos e desfaz tudo se falhar.

## Segundo plano

- O menu da bandeja (`updateTrayMenu`, refeito a cada `saveConfig`) lista os perfis, "Parar tudo", abrir e sair. No Mac não há bandeja: o mesmo menu (menos abrir/sair) vai para o `app.dock.setMenu`.
- Iniciar com o sistema: Windows/Mac usam `setLoginItemSettings` com `--hidden` (o portátil registra o `.exe` de `PORTABLE_EXECUTABLE_FILE`, porque roda de uma cópia temporária); no Linux vai um `.desktop` em `~/.config/autostart`. O estado é lido do sistema (`readOpenAtLogin`), não da config. Com `--hidden` (ou `wasOpenedAtLogin` no Mac) a janela é criada com `show: false`. No `npm start` a opção fica desabilitada (`app.isPackaged`).

## Atualização

- `src/updater.js` escolhe o modo: `auto` (Windows NSIS e AppImage: `electron-updater` baixa sozinho e `quitAndInstall` no "Reiniciar"), `portable` (`.exe` portátil: consulta a API de releases, baixa o `.exe` novo para a pasta temporária e, no "Reiniciar" ou ao sair, o `portable-update.ps1` espera o app fechar e copia o novo por cima de `PORTABLE_EXECUTABLE_FILE`; se a pasta do `.exe` não aceitar escrita, vira `manual`). O script é criado pelo WMI (`Win32_Process.Create`), e não por `spawn`: o Windows põe o portátil num job que mata os processos que sobram quando o app fecha, e um filho desanexado morria junto (o app fechava e nunca reabria), `manual` (Mac e `.deb`: consulta a API de releases e abre `releases/latest/download/<artifactName>`) e `dev` (`npm start`: consulta, mas abre a página da Release). No `auto`, se a Release não tiver os `latest*.yml`, a checagem cai na API como no `manual`.
- O Mac não atualiza sozinho porque o Squirrel.Mac exige assinatura Developer ID.
- Depende do `publish` (GitHub) no `package.json`, que embute o `app-update.yml` no app, e dos `latest*.yml`/`.blockmap` que o workflow sobe para a Release.

## Idiomas

- **Nenhum texto de interface fica escrito no código.** Todo texto vai para `src/locales/pt-BR.json` e `en.json` (chaves planas, como `settings.output.title`) e é usado com `t('chave', { vars })` no renderer ou `i18n.t(...)` no main. Um valor `{ one, other }` é plural, escolhido por `vars.n`. `npm run check:i18n` (também no workflow de release) falha se faltar chave num idioma, se o código usar chave inexistente ou se sobrar texto com acento no código.
- No HTML, o texto é marcado com `data-i18n` (texto), `data-i18n-html` (só para textos dos dicionários com `<kbd>`/`<br>`), `data-i18n-title`, `data-i18n-placeholder` e `data-i18n-aria`, preenchidos pelo `applyI18n` (também nos `<template>`). Botão com ícone leva o texto num `<span data-i18n>`, para não apagar o SVG.
- `config.language` é `'system'` ou um de `i18n.LANGUAGES`; `system` usa português se `app.getLocale()` for `pt-*`, e inglês nos demais casos. O preload pega o dicionário por `sendSync` (a primeira pintura já sai no idioma certo). Trocar o idioma manda o evento `language` ao renderer, que refaz os textos sem recarregar, e o `saveConfig` refaz o menu da bandeja.
- Textos montados pelo JS (toasts, rótulos, descrições que dependem da plataforma) precisam ser refeitos no `applyState`/`renderUpdate`, não só na abertura, para acompanhar a troca.
- Nomes que o usuário já tem (perfis, sons) não são traduzidos; só os nomes padrão novos seguem o idioma. Para acrescentar um idioma: um JSON novo em `src/locales`, o código em `i18n.LANGUAGES` e uma `<option>` no card de Idioma, com o nome no próprio idioma.
- O `archive.js` lança erros com `code` (`too-big`, `invalid`, `corrupt`, `unsupported`), que o main traduz com as chaves `zip.*`.

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

- `.github/workflows/release.yml`: um push de tag `v*` gera os instaladores em runners Windows, macOS (x64 + arm64) e Linux e publica na Release do GitHub, junto com os `latest*.yml` e `.blockmap` do updater. A versão do `package.json` é sobrescrita pela tag durante o build.
- Os nomes dos arquivos são fixos, sem versão (`artifactName` no `package.json`), para os links `releases/latest/download/...` do README não quebrarem. Não mude esses nomes sem atualizar o README.
- Não há assinatura de código (sem certificados), e os avisos que o usuário vê estão documentados no README. No Mac o app é assinado ad-hoc (`mac.identity: "-"`, `hardenedRuntime: false`). Sem nenhuma assinatura, o build arm64 abre como "danificado", e o hardened runtime com ad-hoc impede o Electron Framework de carregar.

## Ambiente do dono (WSL2)

- Para rodar `npm start` no WSL é preciso instalar `libnss3` e `libasound2t64`. No terminal do VS Code, rode `env -u ELECTRON_RUN_AS_NODE npm start`: a extensão exporta essa variável, e com ela o Electron roda como Node puro (`ipcMain` fica `undefined`).
- O `.exe` do Windows **não abre** a partir de `\\wsl.localhost\...` (a GPU e o renderer falham ao iniciar a partir de caminho UNC). Copie `dist/win-unpacked` para o disco C:; hoje a cópia fica em `C:\Users\atzle\Soundboard`.
