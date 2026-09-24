# Soundboard

Vincule áudios a teclas do teclado e toque com um toque. Roda em **Windows, macOS e Linux** (Electron).

## Usar

```bash
npm install
npm start
```

- **Adicionar áudio**: botão no topo ou arraste arquivos (mp3, wav, ogg, m4a, aac, flac, webm, opus).
- **Vincular tecla**: clique na tecla do card e aperte a tecla (combinações com Ctrl/Alt/Shift/Cmd funcionam).
  `Esc` cancela, `Backspace` remove o vínculo.
- **Tocar**: aperte a tecla (apertar de novo reinicia) ou clique no botão de play. `Esc` para tudo.
- **Atalhos globais**: com a chave ligada, as teclas funcionam mesmo com o app em segundo plano.
  Use teclas como F1–F12 ou combinações (ex.: `Ctrl+1`), porque o atalho global "rouba" a tecla dos outros apps.
- Nome e volume de cada som são editáveis no card.

Os áudios são copiados para a pasta de dados do app, então o arquivo original pode ser movido ou apagado.

## Gerar instalador

```bash
npm run dist:win    # .exe (instalador + portátil)
npm run dist:mac    # .dmg (precisa rodar num Mac)
npm run dist:linux  # AppImage + .deb
```

Os arquivos ficam em `dist/`.

## Observações

- **Linux/Wayland**: atalhos globais podem não funcionar em algumas sessões Wayland; nesse caso as teclas continuam funcionando com a janela em foco.
- **macOS**: atalhos globais podem pedir permissão de Acessibilidade.
