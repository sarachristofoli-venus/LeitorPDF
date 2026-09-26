# Leitor PDF

Leitor de PDF para Windows, leve e sem distrações. Usa Electron com o PDF.js, o motor de PDF do Firefox.

## Instalar

Execute `dist/LeitorPDF-Setup-1.0.0.exe`. O instalador:
- deixa escolher a pasta de instalação e não exige administrador;
- cria atalhos na Área de Trabalho e no Menu Iniciar;
- registra o app para arquivos `.pdf`. Para torná-lo o padrão, clique com o botão direito em um PDF, escolha **Abrir com → Escolher outro aplicativo → Leitor PDF** e marque **Sempre**.

## Recursos

| Recurso | Inspirado em |
|---|---|
| Abas para vários documentos, tela inicial com recentes | Foxit Reader |
| Miniaturas e sumário (marcadores) no painel lateral | Adobe Acrobat Reader |
| Busca que ignora acentos (`coracao` encontra `coração`) e destaca os resultados | Edge / Firefox |
| Rolagem contínua; zoom automático, pela largura, pela página ou em % (também com Ctrl + roda do mouse) | Edge / Chrome |
| Retoma a página e o zoom em que você parou em cada arquivo | SumatraPDF |
| Modo noturno das páginas, tema claro/escuro/do sistema | Okular / Adobe |
| Modo apresentação (F5), tela cheia (F11) | Adobe / SumatraPDF |
| Girar páginas, imprimir, propriedades do documento | Adobe |
| Seleção e cópia de texto, links internos e externos clicáveis | todos |
| PDFs protegidos por senha | todos |
| Instância única: um duplo clique em outro PDF abre uma nova aba | SumatraPDF |

Pressione **F1** no app para ver todos os atalhos de teclado.

## Desenvolvimento

```bash
npm install
npm start            # roda o app
npm run dist         # gera o instalador em dist/
```

Testes de fumaça automatizados (abrem o app via DevTools Protocol e tiram screenshots):

```bash
npx electron scripts/make_sample.js                   # gera test/amostra.pdf
node scripts/smoke.mjs <pasta-com-steps.mjs> test/amostra.pdf
```

### Observação sobre o build no Windows
Se `npm run dist` falhar com *"Cannot create symbolic link"* ao extrair o `winCodeSign`, extraia o pacote manualmente sem os arquivos do macOS:

```bash
7za x %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<n>.7z -o%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0 -xr!darwin
```

Outra opção é ativar o Modo de Desenvolvedor do Windows.

## Estrutura

- `src/main.js`: processo principal (janela, protocolo interno `app://`, instância única, arquivos)
- `src/preload.js`: ponte segura entre a interface e o sistema
- `src/renderer.js`: o visualizador (abas, renderização sob demanda, busca, miniaturas, sumário, impressão)
- `src/index.html`, `src/styles.css`: a interface
- `build/`: ícones; `scripts/`: geração do ícone, PDF de teste e testes
