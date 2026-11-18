# Pedido do jogador: visual de bases e estações (18/nov/2026)

O jogador viu os prints `tools/_scratch/ref/mv2-launch-visuals-*` e disse: as bases e a estação espacial ainda estão
feias, e principalmente há **coisas sobrepondo outras** (ex.: veículos desenhados por cima dos habitats).

Problemas observados pelo líder nos prints:

## Bases de superfície (Lua, Marte, Titã; tiers 0–5)
- **Ordem de profundidade quebrada:** veículos, painéis e habitats não respeitam quem está na frente. Tudo precisa ser
  ordenado por profundidade (y do pé no chão / distância), com escala de perspectiva por distância.
- Objetos "flutuando": painéis solares acima dos habitats, arco e torre gigantes em Marte soltos no céu, sem base nem
  sombra de contato. Todo objeto precisa estar ancorado no solo, com sombra coerente com o Sol.
- O anel da plataforma de pouso cruza as pernas do lander; o lander deve pousar DENTRO da plataforma, com a base
  ao fundo e espaço livre ao redor da plataforma.
- Layout da base: módulos amontoados num único plano. Precisa de composição crível: área de pouso afastada,
  caminhos/estradas, habitats conectados por túneis, campo de painéis num lado, antenas, depósitos, e nos tiers
  altos estruturas grandes em segundo plano (com névoa atmosférica em Marte/Titã).
- Painéis solares redondos estranhos no lander marciano; veículos parecem colados como adesivos.
- Iluminação plana: falta sombreamento consistente (direção do Sol), oclusão de contato, luzes noturnas.

## Estação (ISS e estações montadas por módulos)
- ISS com configuração errada: a treliça principal é **horizontal**, perpendicular aos módulos pressurizados que
  ficam no centro; 4 pares de asas solares em 8 painéis nas pontas da treliça, radiadores, segmento russo.
  Hoje está com treliça vertical, painéis enormes e chapados, módulos sobrepondo painéis.
- Estações genéricas montadas por módulos: mesma regra de profundidade e de conexão (módulos ligados por nós,
  painéis presos à estrutura), sem sobreposição.
- Painéis sem textura de células, sem perspectiva e sem reflexo.
