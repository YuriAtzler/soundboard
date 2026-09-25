# Soundboard

Vincule áudios a teclas do teclado e toque com um toque. Roda em **Windows, macOS e Linux** (Electron).

## Baixar

Baixe a versão mais nova (ou veja todas em [Releases](https://github.com/YuriAtzler/soundboard/releases)):

| Sistema | Arquivo |
| --- | --- |
| Windows (instalador) | [Soundboard-Setup.exe](https://github.com/YuriAtzler/soundboard/releases/latest/download/Soundboard-Setup.exe) |
| Windows (portátil, sem instalar) | [Soundboard-Portatil.exe](https://github.com/YuriAtzler/soundboard/releases/latest/download/Soundboard-Portatil.exe) |
| macOS com chip Apple (M1 ou mais novo) | [Soundboard-mac-arm64.dmg](https://github.com/YuriAtzler/soundboard/releases/latest/download/Soundboard-mac-arm64.dmg) |
| macOS com Intel | [Soundboard-mac-x64.dmg](https://github.com/YuriAtzler/soundboard/releases/latest/download/Soundboard-mac-x64.dmg) |
| Linux (AppImage) | [Soundboard-linux.AppImage](https://github.com/YuriAtzler/soundboard/releases/latest/download/Soundboard-linux.AppImage) |
| Linux (Debian/Ubuntu) | [soundboard-linux.deb](https://github.com/YuriAtzler/soundboard/releases/latest/download/soundboard-linux.deb) |

O app não tem assinatura digital paga, então o sistema avisa na primeira vez:

- **Windows**: na tela azul "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo**.
- **macOS**: arraste o app para Aplicativos e abra. Quando aparecer que a Apple não pôde verificar o app, vá em
  **Ajustes do Sistema → Privacidade e Segurança** e clique em **Abrir Mesmo Assim**. Se ainda disser que o app
  "está danificado", rode no Terminal `xattr -cr /Applications/Soundboard.app` e abra de novo.
- **Linux (AppImage)**: dê permissão de execução (`chmod +x Soundboard-linux.AppImage`) e abra.

## Rodar do código

```bash
npm install
npm start
```

- **Adicionar áudio**: botão no topo ou arraste arquivos (mp3, wav, ogg, m4a, aac, flac, webm, opus). Cada arquivo abre
  uma janela para escolher o nome, o trecho que toca (arraste as alças na forma de onda e use **Ouvir trecho**) e a
  tecla, que é obrigatória. O som só é adicionado ao confirmar. Com vários arquivos, eles abrem um de cada vez ("2 de 5"),
  e dá para pular algum.
- **Editar**: clique no nome do som ou no lápis para mudar o nome, o trecho ou a tecla. O corte não altera o arquivo,
  então **Usar o áudio inteiro** desfaz.
- **Trocar a tecla**: clique na tecla do som e aperte outra (combinações com Ctrl/Alt/Shift/Cmd funcionam). `Esc` cancela.
  Se a tecla já era de outro som, ela passa para o novo, e o outro fica "Sem tecla".
- **Tocar**: aperte a tecla (apertar de novo para) ou clique no play. `Esc` para tudo.
- **Segundo plano**: as teclas funcionam mesmo com o app minimizado ou em outra janela. Fechar a janela só a esconde:
  o app continua na bandeja do sistema (Windows/Linux, perto do relógio), de onde se abre de novo ou se sai. No Mac, reabra pelo Dock e saia com Cmd+Q.
  Use teclas como F1–F12 ou combinações (ex.: `Ctrl+1`, `Ctrl+Num 1`), porque o atalho global "rouba" a tecla dos outros apps.
  No Windows, deixe o NumLock ligado para usar o teclado numérico como atalho global. Uma tecla com ⚠ só funciona com o
  app em foco (passe o mouse para ver o motivo).
- **Buscar e ordenar**: `Ctrl+F` busca pelo nome; clique em **Nome** ou **Tecla** no cabeçalho para ordenar.
- **Vários de uma vez**: marque os sons (Shift+clique marca um intervalo) para mudar o volume de todos ou removê-los.
- **Teclado na lista**: ↑/↓ escolhem o som, `Espaço` toca, `Enter` ou `F2` edita e `Delete` remove.
  Teclas vinculadas a sons têm prioridade.
- **Perfis** (na barra lateral): cada perfil é um conjunto separado de sons e teclas (ex.: "Live", "Jogo").
  `+` cria um perfil, um duplo clique no nome renomeia, e a tecla do perfil troca para ele de qualquer lugar.
- **Configurações** (na barra lateral, embaixo dos perfis):
  - **Volume geral** e **Tecla de parar tudo** (vale como atalho global, em qualquer perfil).
  - **Um som por vez**: tocar um som corta o que estiver tocando.
  - **Saída de áudio**: onde os sons tocam (fone, caixa ou um cabo virtual, como o VB-Cable, para mandar ao Discord).
  - **Teclado dos sons** (só Windows): escolha "Identificar teclado…" e aperte uma tecla no teclado que vai disparar os sons, por exemplo um teclado numérico USB. Daí em diante só ele dispara os sons, e as mesmas teclas nos outros teclados ficam livres. Ctrl/Alt/Shift podem vir de qualquer teclado. A tecla também chega ao app em foco, então prefira teclas que não façam nada nele.
  - **Tema**: Sistema, Claro ou Escuro.

Os áudios são copiados para a pasta de dados do app, então o arquivo original pode ser movido ou apagado.

## Publicar uma versão

O GitHub Actions (`.github/workflows/release.yml`) gera os instaladores dos três sistemas e cria a Release:

```bash
git tag v1.1.0
git push origin v1.1.0
```

A versão do app vem da tag. Em alguns minutos os arquivos aparecem em Releases e os links acima passam a baixar a versão nova.

## Gerar instalador localmente

```bash
npm run dist:win    # .exe (instalador + portátil)
npm run dist:mac    # .dmg (precisa rodar num Mac)
npm run dist:linux  # AppImage + .deb
```

Os arquivos ficam em `dist/`.

## Observações

- **Linux/Wayland**: atalhos globais podem não funcionar em algumas sessões Wayland; nesse caso as teclas continuam funcionando com a janela em foco.
- **macOS**: atalhos globais podem pedir permissão de Acessibilidade.
