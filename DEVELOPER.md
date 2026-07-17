# Guia de Desenvolvimento — Território John Melo

Este documento explica como modificar, estender e personalizar o ambiente 3D interativo do universo **John Melo / Figura Pública**.

---

## 1. Painel de Ferramentas do Desenvolvedor (In-Game)
O site possui um **Painel de Controle embutido** para desenvolvedores. Para abri-lo:
1. Pressione **ESC** durante o jogo para pausar.
2. Clique no botão **DEV TOOLS** (ou pressione a tecla **Tab**).
3. Modifique valores em tempo real (Velocidade, Gravidade, Densidade do Nevoeiro, Intensidade das Luzes, Efeitos CRT, etc.).

---

## 2. Estrutura do Código (`main.js`)
O motor 3D está escrito em Vanilla Three.js de alta performance estruturado em torno das seguintes áreas:

*   **Configurações Globais (`config`)**: Armazena as variáveis de física, renderização e geração. Modificar os valores iniciais neste objeto altera os padrões do site.
*   **Gerador Procedural (`generateChunk`)**: Divide o mundo em blocos (chunks) de 40×40 unidades. Usa um gerador de números pseudo-aleatórios semeado (seeded PRNG) baseado em coordenadas `(cx, cz)`.
*   **Banco de Luzes (Light Pool)**: Mantém um número fixo de luzes PointLight e SpotLight ativas na placa gráfica. Conforme o jogador se move, o motor calcula as luzes mais próximas e atualiza suas posições em tempo real. Isso evita recompilações de shaders e otimiza o cache de renderização.

---

## 3. Como Customizar Elementos

### A. Adicionar Novas Imagens / Obras
1. Salve as imagens na pasta `public/assets/` (ex: `minha_pintura.png`).
2. No topo de `main.js`, localize a função `loadTextures`. Adicione sua imagem à lista `list`:
   ```javascript
   { name: 'minhaObra', url: '/assets/minha_pintura.png' }
   ```
3. Para fazer a obra surgir nas paredes das galerias, adicione o nome da textura ao sorteador em `buildGalleryCell`:
   ```javascript
   // Adicione o nome da textura no array de sorteio:
   texName: ['face', 'poster', 'city', 'posterRed', 'minhaObra'][Math.floor(rng() * 5)]
   ```

### B. Adicionar Novos Manifestos ou Textos
Os textos do Zine e do Manifesto estão no arquivo `index.html` em formato HTML clássico:
*   Para mudar as páginas do Zine, altere as divs `<div class="zine-page" id="zine-page-X">` dentro de `#overlay-zine`.
*   Para o Manifesto, altere o papel dentro de `#overlay-manifesto`.

### C. Ajustar Física de Corrida e Pulo
*   A velocidade de caminhada é controlada por `config.moveSpeed`.
*   A velocidade de corrida (pressionando **Shift**) é controlada por `config.runSpeed`.
*   A altura do pulo é controlada por `config.jumpStrength`, contraposta pela constante `config.gravity`.
