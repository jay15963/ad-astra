# Pedido do jogador: tipos de missão v2 (18/nov/2026)

Texto original (resumido fielmente):

1. **"Pouso" é confuso.** Escolher *Sonda* + superfície lunar já é um pouso com sonda. Trocar o tipo "Pouso" por **Rover**:
   missão que perdura na superfície e gera ciência com o tempo.
2. **Contratos fora de hora.** Contratos como "carga para a Lua" aparecem antes de alguém (ou o jogador) ter ido à Lua.
   Contratos devem respeitar o que já foi alcançado (marcos, tecnologia, infraestrutura existente).
3. **Estação.** Montar uma estação do zero enviando módulos, ou ajudar a montar uma existente (se houver tratado/parceria).
4. **Satélite.** Escolher o tipo de satélite (comunicação, observação da Terra, navegação, científico, observatório
   profundo tipo Hubble...). Observatórios dão ciência até o fim da vida útil.
5. **Carga.** Escolher o tipo de carga. Para superfícies: módulos de base e até veículos, podendo criar uma base do zero
   ou ajudar a montar uma (como na estação).
6. **Estações e bases dão ciência com o tempo** e exigem manutenção por envio de cargas (sem carga, degradam).
7. **Visualização em tempo real (Dia de Lançamento / chegada):**
   - Encontro em órbita com estação existente: mostrar a nave **acoplando** na estação. Sem estação ainda: só o módulo
     se desacoplando/sendo posicionado.
   - Missão para base de superfície: pouso na superfície entregando a carga **com a base ao fundo**, desenhada conforme o
     tamanho: no início só habitats pequenos e painéis solares; crescendo: área de pouso, prédios, cúpulas, veículos,
     estruturas gigantes. Coisas acontecendo: veículos andando pela base e indo receber a carga da nave (se a base já
     tiver veículos).

Relação com outros sistemas: bases que crescem viram colônias (src/sim/colonies.js da Fase C, estágios
Reconhecimento → Posto avançado → Base → Colônia...). Estações/bases devem usar o mesmo ativo/infraestrutura.
O tipo legado `landing` em dados existentes precisa de alias/migração.

# Pedido do jogador: tech tree 1950–3000 (18/nov/2026)

Situação ao anotar: a Fase C está criando ~14–23 nós por era (~176 no total com os 45 de base). O jogador quer uma
árvore **realmente grande**, cobrindo 1950→3000, onde:

- **Nós de liberação** (os mais importantes) liberam coisas para fazer ou construir:
  - foguetes para criar no Hangar e para comprar,
  - tipos de naves, de satélites, de sondas, de rovers,
  - módulos de estação e de base,
  - tipos de missão.
- Esses nós ficam **bem destacados, com cores diferentes por tipo de liberação** (ex.: foguete, nave, satélite, sonda,
  rover, módulo, tipo de missão), com legenda.
- **A maioria dos nós melhora a eficiência** de algo (custo, confiabilidade, ciência, tempo de desenvolvimento,
  vida útil, manutenção...).
- Tudo o que hoje aparece "liberado por data" (catálogo de foguetes, naves, peças do Hangar, tipos de missão/subtipos
  da Missões v2) deve passar a depender da tech tree do jogador (rivais da IA seguem a história/IA própria).

# Pedido do jogador: mercado de foguetes entre agências (18/nov/2026)

- Comprar foguetes de outras agências deve depender de **tratados/acordos** (hoje o catálogo só usa `access`
  open/bloc/own + `embargo` fixos nos dados). Ex.: tratado de cooperação ou contrato de lançamento abre o foguete
  daquela agência; ruptura/tensão fecha.
- O caminho inverso: **agências da IA pedem contrato para comprar foguetes do jogador** (os do Hangar e os próprios).
  O interesse cresce com o **número de voos** e a **confiabilidade** do foguete (e cai com falhas recentes, preço,
  tensão política). Contrato rende caixa/reputação ao jogador e ocupa cadência de produção.
