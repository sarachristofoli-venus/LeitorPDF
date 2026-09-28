# Leitor PDF

Leitor de PDF para Windows, leve e sem distrações. Usa Electron com o PDF.js, o motor de PDF do Firefox.

## Instalar

Execute `dist/LeitorPDF-Setup-1.2.1.exe`. O instalador:
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
| **Anotações**: marca-texto (6 cores), sublinhado, tachado, notas adesivas arrastáveis, comentários | Adobe / Edge / Foxit |
| Anotações salvas **dentro do PDF** (padrão, visíveis no Adobe/Edge/Chrome); as já existentes no arquivo são editáveis | Adobe / Foxit |
| Painel "Anotações" com todos os trechos marcados e comentários; desfazer/refazer (Ctrl+Z / Ctrl+Y) | Adobe |
| Seleção de texto estável (sem "saltos"), clique triplo seleciona a linha, barra flutuante ao selecionar | Edge / PDF.js |
| Cópia limpa: corrige hifenização de fim de linha e ligaduras (ﬁ → fi); opção "copiar sem quebras de linha" | Acrobat |
| Ferramentas Seleção (V), Mão (H), Marca-texto (M) e Nota (N); menu de contexto completo | Adobe |
| Instância única: um duplo clique em outro PDF abre uma nova aba | SumatraPDF |
| **OCR**: reconhece o texto de PDFs digitalizados (aviso automático) e grava uma camada de texto invisível | Adobe (Aprimorar digitalizações) / OCRmyPDF |
| **Imagens → PDF**: junte várias fotos JPG/PNG, reordene, gire e gere um PDF pesquisável com texto copiável | Adobe (Criar PDF) / Microsoft Lens |

Pressione **F1** no app para ver todos os atalhos de teclado.

## Como as anotações são salvas

- **Ctrl+S** grava as anotações no próprio PDF (o arquivo é verificado antes de substituir o original).
  **Ctrl+Shift+S** salva uma cópia. Ao fechar com alterações pendentes, o app pergunta se deve salvar.
- Só as anotações alteradas são regravadas; o resto do arquivo não é modificado.
- PDFs **criptografados** (inclusive os que só restringem edição) não podem ser alterados. Nesse caso as
  anotações ficam guardadas no Leitor PDF (`%APPDATA%\Leitor PDF\anotacoes`) e reaparecem ao reabrir o arquivo.

## OCR e imagens

- O OCR usa o [Tesseract](https://github.com/tesseract-ocr/tesseract) (via Tesseract.js) e roda **no seu computador**,
  sem internet. Idiomas incluídos: português e inglês.
- **PDF digitalizado:** o app avisa quando o PDF não tem texto. Clique em *Reconhecer texto (OCR)* (ou Ctrl+Shift+O).
  O texto reconhecido fica invisível sobre a imagem da página: pode ser selecionado, copiado e pesquisado,
  aqui e em qualquer outro leitor. Salve com Ctrl+S.
- **Imagens:** arraste várias fotos (JPG, PNG, WebP, BMP, GIF) para a janela ou use *Criar PDF a partir de imagens*.
  A orientação das fotos de celular é corrigida automaticamente; as páginas podem ser reordenadas e giradas.
- PDFs protegidos contra alteração recebem uma **cópia** com o texto reconhecido (o original não é modificado).
- **Layout em colunas** (jornais, revistas): o Tesseract roda em modo de segmentação automática (PSM 3), que
  separa colunas, títulos, legendas e fotos. Assim, selecionar uma coluna copia só aquela coluna.
- **Fotos tortas / digitalizações enviesadas**: a inclinação é medida e corrigida antes da leitura; o texto
  invisível é posicionado de volta sobre a imagem original.
- **Letras pequenas**: imagens de até ~1900 px são ampliadas 2× antes do OCR.
- **Refazer o OCR**: escolha *Todas as páginas*; a camada de texto anterior é substituída, sem duplicar.

### Aceleração por GPU
Vem **desligada** por padrão: o PDF.js já desenha as páginas na CPU, e em alguns drivers a GPU travava por
~20 s ao ler imagens grandes (OCR, impressão). Para religar, feche o app e adicione `"gpu": true` ao arquivo
`%APPDATA%\Leitor PDF\dados.json`.

## Desenvolvimento

```bash
npm install
npm start            # roda o app
npm run dist         # gera o instalador em dist/
```

Testes de fumaça automatizados (abrem o app via DevTools Protocol e tiram screenshots).
Com a variável `LEITOR_AUTOSAVE_DIR` definida, a caixa "Salvar como" é respondida automaticamente com essa pasta:

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
- `src/renderer.js`: o visualizador (abas, renderização, busca, miniaturas, sumário, anotações, impressão)
- `src/annotations.js`: modelo e geometria das anotações (seleção → quadriláteros do PDF) e desenho
- `src/selection.js`: estabilização da seleção, clique triplo e limpeza do texto copiado
- `src/pdf-annotations.js`: gravação das anotações no PDF (pdf-lib), no processo principal
- `src/ocr.js`: OCR com Tesseract.js (vários processos em paralelo, 100% local)
- `src/pdfbuild.js`: camada de texto invisível e montagem de PDF a partir de imagens (pdf-lib)
- `src/index.html`, `src/styles.css`: a interface
- `build/`: ícones; `scripts/`: geração do ícone, PDF de teste e testes
