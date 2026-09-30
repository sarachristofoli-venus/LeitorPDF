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

- O OCR roda **no seu computador**, sem internet, com um de dois motores (escolha em *Motor do OCR*):
  - **OCR do Windows** (padrão): o reconhecedor de texto com IA que já vem no Windows 10 e 11
    (`Windows.Media.Ocr`). Nos testes com páginas de jornal foi **~15× mais rápido** que o Tesseract, com a
    mesma precisão ou melhor:

    | Teste | OCR do Windows | Tesseract |
    |---|---|---|
    | Página de jornal com gabarito digitado (erro por letra) | 0,8 s · 0,11% | 6,9 s · 0,49% |
    | 10 páginas do jornal em JPG de 200 dpi (palavras encontradas) | 3,0 s · 97,7% | 46,6 s · 97,9% |
    | PDF digitalizado de 40 páginas (fluxo completo) | 9,2 s | 54,7 s |

    Usa o idioma instalado no Windows (português do Brasil já vem no Windows em português). Se o idioma não
    estiver instalado, ou em outro sistema, o app usa o Tesseract automaticamente.
  - **[Tesseract](https://github.com/tesseract-ocr/tesseract)** (via Tesseract.js): mais lento, incluso no app
    com português e inglês; também lê créditos de foto escritos na vertical.
- **PDF digitalizado:** o app avisa quando o PDF não tem texto. Clique em *Reconhecer texto (OCR)* (ou Ctrl+Shift+O).
  O texto reconhecido fica invisível sobre a imagem da página: pode ser selecionado, copiado e pesquisado,
  aqui e em qualquer outro leitor. Salve com Ctrl+S.
- **Imagens:** arraste várias fotos (JPG, PNG, WebP, BMP, GIF) para a janela ou use *Criar PDF a partir de imagens*.
  A orientação das fotos de celular é corrigida automaticamente; as páginas podem ser reordenadas e giradas.
- PDFs protegidos contra alteração recebem uma **cópia** com o texto reconhecido (o original não é modificado).
- **Layout em colunas** (jornais, revistas): os dois motores separam colunas, títulos, legendas e fotos
  (o Tesseract em modo de segmentação automática, PSM 3). Assim, selecionar uma coluna copia só aquela coluna.
- **Fotos tortas / digitalizações enviesadas**: a inclinação é medida e corrigida antes da leitura; o texto
  invisível é posicionado de volta sobre a imagem original (conferido com a página de teste girada até 15°).
- **Letras pequenas**: imagens de até ~1900 px são ampliadas 2× antes do OCR.
- **Refazer o OCR**: escolha *Todas as páginas*; a camada de texto anterior é substituída, sem duplicar.

## Editor de matéria

Inspirado no *Editor Impresso* do Akaii (clipping de jornais): botão **Editor de matéria** na barra ou tecla **E**.

- A página é dividida em **blocos**: título, subtítulo, linha do autor, cada coluna, legenda, tabela.
  O texto vem do próprio PDF. Com *Ler texto nas imagens* ligado, anúncios, logotipos e páginas digitalizadas
  passam pelo OCR e viram blocos também (tracejados em roxo).
- Clique num campo (Editoria, Título, Subtítulo, Autor, Conteúdo) e depois nos blocos. O texto é emendado como
  no Akaii: desfaz a hifenização entre colunas, abre parágrafo depois de ponto final e continua a frase nos
  outros casos. **Ctrl+clique** troca o conteúdo do campo. Um trecho selecionado pode ser enviado ao campo pela
  barra flutuante.
- Melhorias em relação ao Akaii:
  - a **letra capitular** é unida ao texto ("V" + "itória" vira "Vitória"; "O" + "que" continua "O que");
  - **tabelas** (vagas do SINE, gastos públicos) viram um bloco só, com as linhas preservadas;
  - a linha do autor é limpa ("Por Fulano / Foto: Divulgação" vira "Fulano").
- A **área da matéria** é marcada na página, com bordas ajustáveis. *Salvar recorte* gera um JPG em 200 dpi,
  e *Copiar recorte* manda a imagem para a área de transferência. *Copiar matéria* copia todos os campos.
- **Esc** limpa tudo para a próxima matéria; *Desfazer* retira o último bloco.

## Desempenho

Medido com um jornal de 10 páginas (fotos CMYK), um livro de 600 páginas e um PDF digitalizado de 40 páginas:

- **Abertura:** a biblioteca de gravação (pdf-lib) só é carregada na hora de salvar e o código compilado
  fica em cache (V8 code cache no protocolo `app://`): o programa abre ~0,1 s mais rápido.
- **Salvar:** o pdf-lib pausava a cada 50–100 objetos (~15 ms por pausa no Windows). Sem as pausas, um PDF com
  8 mil objetos passou de 7,5 s para 0,2 s.
- **Busca:** o texto é lido em paralelo por até 4 workers do PDF.js (documentos com 60 ou mais páginas), e a
  leitura começa quando a barra de busca abre. No livro de 600 páginas: 6,8 s → 1,7 s.
- **Memória:** o PDF.js guarda as imagens já decodificadas só das 12 páginas usadas por último, então rolar
  documentos longos não acumula memória (−10% a −25% nos testes, com três documentos abertos).
- **Prioridade:** miniaturas e tarefas de fundo esperam as páginas da tela terminarem de desenhar.
- **OCR:** o OCR do Windows lê várias páginas ao mesmo tempo (~0,1 s por página de jornal em paralelo) e o
  processo que conversa com ele fecha sozinho depois de um minuto parado. No Tesseract, a imagem chega em pixels
  crus (PPM), sem comprimir e descomprimir um PNG (~15% mais rápido, texto idêntico), e os workers iniciam
  juntos, na quantidade que os núcleos e a memória do computador permitem (até 6).
- **Tela estável:** o canvas que o PDF.js usa para medir o texto ficava visível por um instante e empurrava a
  página enquanto as camadas de texto eram montadas; agora fica oculto.

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
- `src/ocr.js`: OCR com o OCR do Windows ou o Tesseract.js (várias páginas em paralelo, 100% local)
- `native/WinOcr.cs`: ponte para o OCR do Windows (`build/winocr.exe`, compilado por `scripts/build-winocr.cjs`
  com o compilador C# que já vem no Windows; `npm start` e `npm run dist` compilam sozinhos)
- `src/pdfbuild.js`: camada de texto invisível e montagem de PDF a partir de imagens (pdf-lib)
- `src/index.html`, `src/styles.css`: a interface
- `build/`: ícones; `scripts/`: geração do ícone, PDF de teste e testes
