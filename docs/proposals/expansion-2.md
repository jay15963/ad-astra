# Proposta de arquitetura nº 2: Ad Astra de 1950 a 3000

Autor: arquiteto nº 2. Ângulo: **primeiro a experiência do jogador**, ou seja, o ritmo no celular: duração da sessão,
número de turnos por era, o que um toque no disco significa em cada era, cenas de transição de era, cenários versus
campanha completa e como investidores e construtor de foguetes entram no loop.
Escopo: os 9 itens do roteiro e as fases A a D. Este documento só propõe. Nenhum código foi alterado.

Base lida: `GDD.md`, `ARCHITECTURE.md`, `PROGRESS.md`, `docs/DESIGN.md` §7, `src/core/*.js`, os cabeçalhos e as
premissas de data de `src/sim/*.js`, `src/ui/app.js`, `src/ui/store.js`, o formato de `data/*.json` e
`movel.css`/`responsivo.tsx` do CSmanager (só leitura).

Medidas de hoje (Node, máquina de desenvolvimento, `isro`, semente 42, 260 semanas sem jogador):
**2,5 ms por tick**, **save de 208 KB** (news 45, finance 25, calendar 24, world 22, contracts 18 KB).
`node tools/smoke.mjs 1` leva 3,5 s para 5 campanhas.

---

## 0. Resumo em 12 decisões

1. **O relógio interno continua sendo a semana** (52 por ano, calendário simplificado de `time.js`). `state.turn` passa a
   significar "semanas desde `state.startYear`" (é o que já significa hoje) e todos os prazos (`launchTurn`, `arriveTurn`,
   `expiresTurn`, `plannedTurn`) seguem em semanas absolutas. Nenhum campo agendado muda de unidade.
2. **O passo do jogador varia por era**: cada `tick` avança `dt` semanas (`ctx.dt`), com `dt` em {1, 2, 4, 13, 52}, vindo
   de uma **tabela de ritmo** em dados (`era.pace`). Um passo **para antes do fim** quando cai nele um compromisso do
   jogador (lançamento, chegada, prazo de decisão). Um toque nunca pula o dia de lançamento.
3. **Campanha 1950 → 3000 com ~3.300 toques no ritmo Normal** (~20 a 30 h de jogo) e ~1.700 no ritmo Rápido. Cada era
   fica entre 300 e 650 toques. Ver §2.
4. **A cena de transição de era é um ponto de parada que bloqueia o tempo** (`isBlocked → 'era'`): 4 cartões de
   reflexão, autosave e um slot de save "capítulo". A troca de pacote de dados acontece atrás dela.
5. **Cenários são fatias da mesma linha do tempo**, com início "montado a partir dos dados" (sem simular o passado).
   A "Corrida Lunar 2026–2030" continua idêntica (dt = 1, mesmos dados, mesmos testes).
6. **Atores têm linhagem**: o id é estável e o nome muda com a data (`nasa` aparece como "NACA" em 1950). Fusões,
   dissoluções e nascimentos vêm de `data/lifecycle.json` (fatos até 2030) e de regras procedurais depois disso. Os ids
   atuais (`nasa`, `cnsa`, `isro`, `esa`, `roscosmos`, `jaxa`, `spacex`, `blueorigin`) não mudam, e os saves e testes
   seguem válidos.
7. **"Mandatos" unificam história e investidores**: toda missão obrigatória vem de um patrono. Na agência estatal real o
   patrono é o governo (os programas do calendário, como hoje). Na agência criada pelo jogador e nas empresas, os
   patronos são investidores com participação (%), e os mandatos ocupam a **Agenda** na proporção dessa participação.
8. **O construtor de foguetes é uma ficha em pilha, não um editor KSP**: estágios em cartões, motor numa folha, tanque
   em degraus, boosters 0/2/4/6, com barras ao vivo de capacidade, chance e custo. O projeto vira programa de
   desenvolvimento (no mesmo molde da certificação tripulada) e depois entra no catálogo.
9. **A escolha do veículo é do jogador** (item 9, pedido direto do usuário nesta rodada): aceitar um briefing cria a
   missão **sem veículo**, com uma *sugestão dos engenheiros* marcada mas não escolhida. A missão não pode ser agendada
   sem a escolha. **Proponho puxar isso para a Fase A**: é pequeno, independente e foi o pedido explícito.
10. **Casca CSmanager**: topo compacto com hambúrguer (`.gaveta` + `.veu`), barra inferior com 4 destinos e o disco no
    centro, e um **registro de telas** (`src/ui/screens.js`) que alimenta roteador, títulos, barra, gaveta e selos.
11. **Save v2 com migração em cadeia** (`src/core/migrate.js`). Um save v1 da Corrida Lunar abre como v2. Um save mais
    novo ou ilegível é recusado com uma mensagem em pt-BR.
12. **Teste-mestre**: `tools/campaign-3000.mjs`, um bot sem tela que joga de 1950 a 3000 com orçamento de tempo, de
    tamanho do save e de **densidade de paradas por era**, a métrica de ritmo que protege a experiência no celular.

---

## 1. Princípios de ritmo (o que otimizamos)

O GDD define sessões de 3 a 5 minutos, uma mão, retrato e nenhum timer punitivo. Daí saem quatro números de projeto,
que valem para todas as eras e são verificados pelo bot (§13):

| Métrica | Alvo | Por quê |
| --- | --- | --- |
| **Densidade de paradas** (decisão, briefing, lançamento ou notícia de importância ≥ 3) por toque | 0,15 a 0,35 | Com 1 parada a cada 3 a 6 toques o disco "anda" sem virar clique vazio e sem afogar o jogador |
| Toques entre fechamentos naturais (resultado de missão, fechamento do ano, capítulo) | 25 a 60 | Uma sessão de 3 a 5 min termina num ponto de pausa |
| Latência de um toque (dispatch e render) no celular intermediário | ≤ 120 ms p95 | O disco precisa responder na hora |
| Toques por era | 300 a 650 | Cada era cabe em 3 a 6 horas, "muitas horas" para o loop macro sem cansar |

O jogo **mede o tempo em toques, não em anos**. Toda cadência de sistema (rodada de investidores, revisão de
calendário, eleição, evento narrativo) é escrita em **semanas absolutas** nos dados, mas o projeto de conteúdo é checado em
**toques**: se uma rodada anual de investidores cai a cada toque na Era 6 (passo de 1 ano), ela vira "a cada 5 anos".
O helper `cadence(ctx, {weeks, minSteps})` resolve isso (§3.3).

---

## 2. Modelo de tempo

### 2.1 Unidade interna e passo

- **Unidade interna: semana.** `WEEKS_PER_YEAR = 52` continua. `turnToDate(turn, startYear)` continua. A campanha usa
  `startYear = 1950`. Um save de 1950 a 3000 tem `turn` máximo de 54.652, que cabe em inteiro sem problema.
- **Passo (`dt`)**: número de semanas que um `tick` avança. Os valores permitidos são os divisores "bons" de 52
  (1, 2, 4, 13, 26, 52), para que mês e ano fechem sem resto.
- **Ritmo em dados**: `data/eras/<era>/era.json` traz `pace: [{from:{year,month}, stepWeeks}]`. O passo vigente é o da
  última faixa cujo `from` ≤ agora. O cenário pode sobrescrever (`scenario.stepWeeks`, a Corrida Lunar usa 1).
- **Ajuste do jogador ("Ritmo")**: Detalhado (½ passo), Normal, Rápido (2 × passo), sempre arredondado para um divisor
  permitido, nunca abaixo de 1 nem acima de 52. Fica em `state.clock.paceMult` porque muda o resultado: o determinismo
  vale por `(seed, ações, ritmo)`. A troca de ritmo é uma ação (`time/pace`) registrada no log.
- **Passo truncado**: `advance` calcula `dtEff = min(dt, próximoCompromisso − turn)`. Compromissos do jogador são
  `mission.launchTurn` com status `scheduled`, `transit.arriveTurn`, `decision.expiresTurn`, `era.end` e eventos
  agendados com `stopsPlayer: true`. **O Dia de Lançamento acontece na semana certa em qualquer era.** Na Era 6, um toque
  diz "+1 ano", mas, se o lançamento está em mar/2234, o toque para em mar/2234 e o próximo completa o ano.

### 2.2 Tabela de eras: o que um toque significa

Ritmo Normal (o Rápido divide os toques por ~2):

| Era | Anos | Faixas de passo | Toques | O que um toque no disco é | Sessão típica (5 min, ~25 a 40 toques) |
| --- | --- | --- | --- | --- | --- |
| 1. A Corrida | 1950–1975 | 1950–55: 13 sem (prólogo) · 1956–75: 2 sem | 24 + 520 = **544** | "+2 semanas": uma revisão de bancada, um voo de teste | 1 a 2 lançamentos, 1 marco disputado com a URSS/EUA |
| 2. Estações e Sondas | 1976–1999 | 4 sem | **312** | "+1 mês": um mês de operação de estação | 1 missão de longa duração, rotação de tripulação |
| 3. A Era Comercial | 2000–2025 | 4 sem | **338** | "+1 mês": contratos, cadência, reuso | 2 a 3 lançamentos comerciais e 1 leilão |
| 4. A Década Lunar | 2026–2050 | 2 sem (campanha) · **1 sem no cenário Corrida Lunar** | **650** | "+2 semanas": urgência, janelas, pousos | 1 lançamento lunar com chegada |
| 5. Expansão do Sistema | 2051–2199 | 13 sem | **596** | "+1 trimestre": uma remessa de suprimentos, uma janela a Marte a cada ~9 toques | 1 a 2 crises de colônia, 1 voo marciano |
| 6. Interplanetária e Interestelar | 2200–2599 | 52 sem | **400** | "+1 ano": uma geração de habitat avança, naves em voo por décadas | 1 decisão de colônia e 1 chegada de sonda interestelar |
| 7. Galáctica | 2600–3000 | 2600–2989: 52 sem · 2990–3000: 13 sem (desaceleração final) | 390 + 40 = **430** | "+1 ano" e, na última década, "+1 trimestre": o Eco se intensifica | peças do Eco e o Grande Silêncio |
| **Total** | | | **≈ 3.270** | | |

Justificativa dos totais:
- A Corrida Lunar de hoje tem 260 turnos para uma partida de 1 a 2 h, ou seja, ~15 a 25 s por turno com as paradas.
  Com esse custo por toque, 3.300 toques dão **~15 a 25 h**, dentro do "dezenas de horas" do GDD, e o Rápido
  (~1.700 toques) dá **8 a 12 h** para quem quer a história sem o detalhe.
- O **prólogo de 1950 a 1955 com passo trimestral** evita ~150 toques vazios antes do Sputnik. O jogo fica rápido até a
  corrida esquentar, e a faixa "2 semanas" começa em 1956 (ABMA, Quinta Academia chinesa, preparação do AIG).
- As Eras 2 e 3 são "industriais", com missões longas e muitos voos de rotina. O passo de 1 mês mantém a densidade de
  paradas no alvo sem 1.300 toques de rotina.
- A Era 4 na campanha usa 2 semanas, não 1: são 25 anos, contra 5 no cenário. O cenário Corrida Lunar continua com 1
  semana, porque ali o detalhe é o produto.
- As Eras 6 e 7 cobrem 800 anos em ~830 toques. Passo menor que 1 ano faria a campanha passar de 50 h; passo maior faria
  as viagens interestelares (décadas) chegarem "no mesmo toque", o que mata a torcida.
- A **desaceleração final** (2990–3000 com passo de 13 semanas) dá à aproximação do Grande Silêncio a mesma tensão do dia
  de lançamento: o mundo fica mais lento quando importa.

### 2.3 Disco (o botão de tempo) por era

- **Toque**: um passo. Embaixo do disco aparece o rótulo do passo ("+2 sem", "+1 mês", "+3 meses", "+1 ano"), lido de
  `query('time/stepLabel')`. Quando o passo vai ser truncado, o rótulo antecipa o motivo ("até o lançamento").
- **Toque longo ("Próximo evento")**: hoje são `RUN_MAX_WEEKS = 26`. Passa a ser **`RUN_MAX_STEPS = 12` passos ou 26
  semanas, o que for maior**: meio ano nas Eras 1 a 4, 3 anos na Era 5 e 12 anos nas Eras 6 e 7. O anel do disco
  mostra o progresso em passos.
- **Virada de ano** nas eras de passo anual: uma animação curta do ano no cabeçalho (desligada em reduzir movimento).
- **Nada muda no Pilar 5**: avançar é sempre opcional, sem timers, e fechar o app no meio de um passo não perde nada,
  porque o passo é atômico no engine.

### 2.4 Por que não manter o tick sempre em 1 semana

Rodar 1 semana por tick e só agrupar na UI (52 ticks por toque na Era 6) também funcionaria e não exigiria mexer nas
taxas dos módulos. Rejeitei por três motivos de experiência:
- **Latência**: 52 ticks × 2,5 ms em Node viram ~0,5 a 0,8 s num celular intermediário, e cresce com mais atores e
  colônias. O toque deixaria de ser instantâneo.
- **Campanha sem tela**: 54.652 ticks × 2,5 ms ≈ 2,3 min por semente. O teste de 3 sementes passaria de 7 min e não
  rodaria a cada mudança.
- **Ruído**: os eventos semanais (sorteio por semana) disparariam 52 vezes por toque, e a densidade de paradas
  explodiria nas eras longas. Com `dt`, a chance do passo é composta (`1−(1−p)^dt`) e o conteúdo controla a densidade.

O custo é a varredura dos módulos (§9), que é mecânica e verificável: com `dt = 1` o resultado tem que ser **idêntico**
ao de hoje, bit a bit (§13.2).

---

## 3. Engine: relógio, passo e eras

### 3.1 Estado novo (dono: core)

```js
state.version = 2
state.clock = {
  epochYear: 1950,          // informativo; a conta de data continua com state.startYear
  eraId: 'e4',              // era vigente (data/eras/<id>)
  stepWeeks: 1,             // passo vigente já com paceMult aplicado
  paceMult: 1,              // 0.5 | 1 | 2 (ajuste "Ritmo")
  steps: 0,                 // toques dados (estatística e ritmo)
  eraStartTurn: 0,
  pendingEra: null,         // { from, to } enquanto a cena de transição está aberta
}
state.endTurn                // continua: fim do cenário ou da campanha
state.scenarioId             // 'lunar_race' | 'campaign' | 'race_1957' | ...
```

### 3.2 `tick(state, data)` passa a avançar `dt`

```
tick(state, data):
  dt = stepFor(state, data)                       // ritmo da era × paceMult, truncado no próximo compromisso
  expira decisões com expiresTurn <= turn + dt − 1
  signals ← signalsPending
  para cada módulo: mod.tick(state, data, ctx)    // ctx.dt = dt, ctx.date = data no INÍCIO do passo
  turn += dt; clock.steps += 1
  se cruzou uma fronteira de era → clock.pendingEra = {...}; emitSignal('era/ending')
  se turn > endTurn → gameOver (ou finale em 3000)
```

- `ctx = { data, rng(label), date, dt, era, weeksIn(a, b) }`. O `ctx.rng(label)` continua dependendo de
  `(seed, turn, módulo, label)`. Como `turn` é a semana absoluta, a sorte não muda quando o ritmo muda, desde que os
  passos caiam nas mesmas semanas.
- `isBlocked(state)` ganha o caso `'era'` (cena de transição aberta). A ação `era/continue` aplica a troca:
  `onEraEnd` → troca de pacote → `onEraStart` → `clock.eraId = to`.
- **Hooks novos e opcionais por módulo**: `onEraStart(state, data, ctx, era)`, `onEraEnd(...)`,
  `onActorBorn(state, data, ctx, actorId)`, `onActorGone(state, data, ctx, actorId, {absorbedBy})`. São os pontos de
  extensão para o ciclo de vida (§5), sem que os módulos importem uns aos outros.
- `advance(state, data, steps, {stopOnEvent})` passa a contar **passos**. `time/advance {weeks}` continua aceito
  (compatibilidade: com `dt = 1`, semanas e passos coincidem). A UI nova manda `{steps}`.

### 3.3 Helpers de taxa em `src/core/helpers.js` (os únicos que os módulos usam)

```js
perStep(ratePerWeek, ctx)            // ratePerWeek * ctx.dt
chanceInStep(pWeek, ctx)             // 1 − (1 − pWeek)^dt
crossed(state, ctx, periodWeeks, phase = 0)  // true se um múltiplo (k*period + phase) cai em [turn, turn+dt)
cadence(ctx, { weeks, minSteps = 1 })        // período efetivo = max(weeks, minSteps*dt): "rodada anual" vira "a cada 5 toques" no passo anual
dueIn(state, ctx, turnValue)                 // turnValue em [turn, turn+dt): coisa agendada vence neste passo
```

`state.turn % 13 === 0` (revisões trimestrais, por exemplo) vira `crossed(state, ctx, 13)`. Com `dt = 1` é a mesma
coisa.

### 3.4 Fim da campanha em 3000

`campaign.end = {year: 3000, month: 0}`. Quando o passo alcança a primeira semana de 3000, o módulo `eco` (Fase C)
abre o **capítulo final** como decisão bloqueante com as três saídas do GDD: **Contato**, **Silêncio** e **Herança**.
Depois da escolha vem a cena de encerramento (`src/ui/ending.js`), e `gameOver = {reason: 'finale', ending}`.
Demissão por dívida e as derrotas atuais continuam valendo antes disso.

---

## 4. Cenários e campanha

### 4.1 Formato (`data/scenarios/<id>.json`)

```js
{
  id: 'campaign', kind: 'campaign' | 'scenario',
  name: 'Campanha', subtitle: '1950 a 3000',
  start: { year: 1950, month: 0 }, end: { year: 3000, month: 0 },
  eras: ['e1','e2','e3','e4','e5','e6','e7'],
  stepWeeks: null,                       // null = ritmo da era; número = fixo (Corrida Lunar: 1)
  playable: { rule: 'alive-at-start', include: [], exclude: [], custom: true },  // custom = Fase B
  history: 'faithful' | 'divergent',     // padrão do seletor "História" (ver 4.3)
  historicalFirsts: null,                // null = derivado da linha do tempo; objeto = sobrescreve (lunar_race)
  victory: { kind: 'eraTable' | 'finale', goals: [...] },
  unlocks: { builder: { from: 1960 }, investors: { from: 1950 }, colonies: { from: 2051 } }
}
```

- `data/scenario.json` continua existindo e passa a ser **o cenário `lunar_race`** (o loader o aceita no caminho antigo).
  Assim os testes que leem `data.scenario` seguem iguais.
- Cenários propostos: **Corrida Lunar (2026–2030)**, que já existe; **A Corrida (1957–1969)**, na Fase C1; **Estações
  (1971–1998)**, na C2; **Nova Era Comercial (2002–2020)**, na C3; **Fronteira Marciana (2051–2100)**, na C5;
  **O Grande Silêncio (2950–3000)**, liberado depois de terminar a campanha uma vez. Cada um com 150 a 300 toques
  (1 a 2 h).

### 4.2 Início montado a partir dos dados (sem simular o passado)

Um cenário que começa em 1957 ou em 2026 não roda o mundo desde 1950. Isso seria lento e daria um passado diferente
a cada semente, contra "o passado é fiel". O `bootstrap(scenario, data)` em `src/core/scenario.js`:
- aplica `lifecycle.json` até a data de início (quem existe e com que nome);
- deriva os **feitos históricos** dos itens do calendário com `truthLayer: 'fato'` e `historicalOutcome` anteriores
  ao início, e o `scenario.historicalFirsts` explícito, quando existe, tem precedência. Assim a Corrida Lunar fica
  idêntica;
- semeia `vehicleStats` com o histórico dos veículos até a data (`history` passa a ter `byYear` opcional na Fase C);
- usa os valores de atores (verba, apoio, cultura) da faixa de data correspondente em `actors.json`
  (`snapshots: [{from: 1957, budget, support, ...}]`).

### 4.3 Fidelidade histórica com o jogador no meio

Conflito central de experiência: se o jogador dirige a NASA em 1957, a URSS faz o Sputnik em out/1957 "porque é
fato", mas o jogador pode chegar primeiro. A proposta:
- **Seletor "História" no novo jogo**: *Fiel* (padrão) ou *Divergente*.
  - Fiel: itens `fato` dos rivais acontecem nas datas reais com o resultado histórico (como hoje,
    `slipChance: 0` + `historicalOutcome`). Só o jogador reescreve: se ele chegar antes, o rival faz o voo mesmo assim,
    mas leva o "segundo lugar".
  - Divergente: os itens `fato` recebem atraso e resultado sorteados como `plano_oficial`.
- **Itens condicionados**: todo item de calendário pós-divergência pode declarar `canon: {requires: {...}, onBreak:
  'drop' | 'reassign' | 'retarget'}`. Exemplo: Apollo-Soyuz exige `actorAlive: roscosmos` e tensão < 3; se a URSS já foi
  absorvida ou está em guerra, o item cai e vira notícia ("o aperto de mão que não houve"). Os autores de conteúdo da
  Fase C são obrigados a preencher `canon` nos itens de 1957 em diante que dependem de outros itens.

### 4.4 Campanha: capítulos e saves

- Uma era tem de 2 a 4 **capítulos** (`era.chapters: [{from, title}]`), por exemplo Era 1: "Prólogo", "Sputnik",
  "Mercúrio e Vostok" e "Apollo". A virada de capítulo é uma notícia de importância 3 com um cartão leve (não bloqueia),
  e é um ponto de parada natural para encerrar a sessão.
- **Slots de save**: `adastra.save.auto` (autosave como hoje), `adastra.save.era.<eraId>` (checkpoint na cena de
  transição, o último de cada era) e até 3 slots manuais. Quem perde a agência na Era 5 volta ao começo da Era 5,
  não a 1950. O Modo Lenda do GDD desliga os checkpoints.

---

## 5. Ciclo de vida dos atores

### 5.1 Linhagem: id estável, nome por data

```js
// data/actors.json (ou data/eras/<e>/actors.json), campos novos
{ id: 'nasa',
  names: [ { from: {year:1950}, name: 'NACA (EUA)', short: 'NACA', logo: {...} },
           { from: {year:1958, month:9}, name: 'NASA (EUA)', short: 'NASA', logo: {...} } ],
  born: {year: 1915}, kind: 'agency', country: 'EUA',
  snapshots: [ { from: {year:1950}, budget: 60, support: 40, ... }, { from: {year:1959}, budget: 330, ... }, ... ],
  ... campos atuais ... }
```

- `actorName(state, id)` (helper novo do core) resolve o nome pela data. A UI e as notícias deixam de ler `actor.name`
  direto. Nos dados atuais `name/short` continuam como valor final (sem `names` = nome fixo).
- O estado guarda `state.actors[id].nameIdx`, que muda por operação `rename` (ver abaixo), para que notícias antigas
  continuem com o nome da época (o texto da notícia já é gravado pronto).

### 5.2 Operações (`data/lifecycle.json`)

```js
{ ops: [
  { date: {year:1958, month:9}, op: 'rename', actor: 'nasa', to: 1, news: {...} },
  { date: {year:1960, month:6}, op: 'merge', from: ['abma'], into: 'nasa', carry: { crew: true, vehicles: ['redstone','jupiter_c','saturn_i'], cash: 0.5 } },
  { date: {year:1975, month:4}, op: 'merge', from: ['eldo'], into: 'esa', rename: 1 },
  { date: {year:1991, month:11}, op: 'dissolve-state', actor: 'roscosmos', nation: 'ussr', successorNation: 'russia', budgetShock: -0.7, rename: 2 },
  { date: {year:2002, month:2}, op: 'birth', actor: 'spacex', snapshot: 0 },
  ...
] }
```

`op ∈ birth | rename | merge | split | dissolve | dissolve-state | transfer | privatize`. O módulo novo
**`src/sim/lifecycle.js`** é o único que adiciona ou remove de `state.actors` depois do init. Ele chama
`diplomacy.seedRelations(newId)` e os hooks `onActorBorn/onActorGone` de todos os módulos (calendário reatribui itens,
equipe transfere pessoas, política liga a nação, missões cancelam ou transferem contratos).

**O jogador numa operação**:
- `rename`: transparente, com notícia e nova identidade.
- `merge` em que o ator do jogador é absorvido (ISAS → JAXA em 2003, ELDO → ESA em 1975): cartão bloqueante
  "Fusão: você agora dirige a JAXA" e `playerId` passa ao sobrevivente. Missões, equipe e caixa vão junto.
- `merge` em que o jogador absorve: ganho de equipe, veículos e caixa, com notícia.
- `dissolve-state` (URSS em 1991): o jogador que dirige o programa soviético atravessa a crise com choque de verba,
  cartão de decisão sobre equipe (emigração de engenheiros) e a nova identidade Agência Espacial Russa.
- **Atores reais seguem a história; o jogador decide a dele.** Para o ator do jogador, as operações reais que não são
  renomeação (fusão opcional, privatização) viram **proposta**, com a escolha histórica como padrão.

### 5.3 Nascimentos e mudanças reais de 1950 a 2030 (lista para `lifecycle.json`)

As datas abaixo são de conhecimento geral. **Conferir antes de fixar** (como o GDD faz com o calendário).
"Núcleo" = ator simulado completo. "Menor" = ator de fundo (§5.5).

| Data | Operação | Ator (id de linhagem) | Nível |
| --- | --- | --- | --- |
| antes de 1950 | vivo: NACA (1915) | `nasa` com nome "NACA" | núcleo |
| antes de 1950 | vivo: OKB-1 de Korolev (1946) como "Programa Espacial Soviético" | `roscosmos` (nome 0) | núcleo |
| fev/1956 | nascimento: ABMA, Exército dos EUA (equipe de von Braun) | `abma` | núcleo |
| out/1956 | nascimento: Quinta Academia do Ministério da Defesa (China) | `cnsa` (nome 0) | núcleo |
| out/1958 | renomeia NACA → NASA (lei de jul/1958); JPL transferido em dez/1958 | `nasa` | núcleo |
| jul/1960 | fusão: ABMA → NASA (Marshall) | `abma` → `nasa` | |
| 1961 | nascimento: SUPARCO (Paquistão), CNAE/INPE (Brasil) | `suparco`, `inpe` | menor |
| dez/1961 | nascimento: CNES (França) | `cnes` | menor (núcleo até 1975) |
| fev/1962 | nascimento: INCOSPAR (Índia) | `isro` (nome 0) | núcleo |
| fev–mar/1964 | nascimento: ELDO e ESRO | `eldo`, `esa` (nome 0 = ESRO) | núcleo |
| abr/1964 | nascimento: ISAS (Univ. de Tóquio; nacional em 1981) | `isas` | núcleo |
| ago/1969 | renomeia INCOSPAR → ISRO | `isro` | |
| out/1969 | nascimento: NASDA (Japão) | `jaxa` (nome 0) | núcleo |
| 1969 | nascimento: DFVLR/DLR (Alemanha) | `dlr` | menor |
| mai/1975 | fusão: ELDO → ESRO, que vira ESA | `eldo` → `esa` | |
| mar/1980 | nascimento: Arianespace | `arianespace` | menor (operadora de lançadores) |
| 1982 | nascimento: Orbital Sciences | `orbital` | menor |
| 1983 | nascimento: ISA (Israel) | `isa_il` | menor |
| 1988 | nascimento: ASI (Itália) | `asi` | menor |
| mar/1989 | nascimento: CSA (Canadá) | `csa` | menor |
| out/1989 | nascimento: KARI (Coreia do Sul) | `kasa` (nome 0) | menor |
| dez/1991 | dissolução da URSS | `roscosmos`: choque de verba | |
| fev/1992 | renomeia → Agência Espacial Russa (RKA); SSAU (Ucrânia) nasce | `roscosmos`, `ssau` | |
| 1992 | Projeto 921 (programa tripulado chinês, CMSA) | dentro de `cnsa` | |
| abr/1993 | renomeia → CNSA | `cnsa` | |
| fev/1994 | renomeia INPE/COBAE → AEB (Brasil) | `inpe` → nome AEB | menor |
| set/2000 | nascimento: Blue Origin | `blueorigin` | núcleo |
| mar/2002 | nascimento: SpaceX | `spacex` | núcleo |
| out/2003 | fusão: NASDA + ISAS + NAL → JAXA | `isas` → `jaxa`, renomeia | |
| mar/2004 | renomeia RKA → Roscosmos (agência federal; corporação estatal em 2015) | `roscosmos` | |
| jun/2006 | nascimento: Rocket Lab | `rocketlab` | menor |
| dez/2006 | nascimento: ULA (joint venture Boeing + Lockheed) | `ula` | menor |
| 2014 | nascimento: Agência Espacial dos Emirados | `uaesa` | menor (jogável a partir da Era 3) |
| 2015–2018 | nascimento: LandSpace, iSpace, Galactic Energy (China comercial) | `landspace`, ... | menor |
| 2016 | nascimento: Axiom Space | `axiom` | menor |
| jul/2018 | nascimento: ASA (Austrália) | `asa` | menor |
| 2021 | nascimento: Vast | `vast` | menor |
| mai/2024 | renomeia KARI → KASA | `kasa` | menor |
| abr/2025 | nascimento: Agência Espacial Africana (AfSA, Cairo) | `afsa` | menor |
| 2026–2030 | só o que estiver em plano oficial em nov/2026 (camada `plano_oficial`) | | |

### 5.4 Nascimentos especulativos depois de 2030 (procedurais e determinísticos)

`data/procgen/actors.json` define **gatilhos** e **gramáticas**; o sorteio usa `ctx.rng('lifecycle.birth')`:

| Gatilho (estado do mundo) | O que nasce | Exemplo de nome |
| --- | --- | --- |
| Crescimento econômico alto numa nação sem agência, por N anos | Agência nacional | "Agência Espacial da Indonésia" |
| Mercado aquecido (sentimento de investidores alto) e um destino com receita (turismo, mineração) | Corporação | "Helion Mineração Orbital" |
| Bloco forte com membros sem capacidade de lançamento | Consórcio | "Consórcio Pan-Africano de Lançamentos" |
| Colônia no estágio 5 (cidade-estado) com opinião separatista alta (Era 5+) | Ator-colônia | "República de Tharsis" |
| Fusão de dois atores fracos e amigos (confiança > 60, prestígio no terço inferior) | Ator fundido | "Nova Roscosmos-CNSA" |
| Era 5+, peças do Eco ≥ k | O **Colégio Silêncio** (único, roteirizado) | — |

Morte: falência (caixa abaixo de −X por N anos), irrelevância (fora do top 12 em prestígio e verba por 10 anos, vira
"menor" e depois some), fusão ou anexação por guerra (tensão 4 prolongada). Cada nascimento ou morte gera notícia e
uma linha no **Arquivo** (§10, "Linha do tempo").

### 5.5 Atores núcleo e de fundo (orçamento de desempenho)

- **Núcleo**: IA completa (diplomacia, calendário, pesquisa, propostas). **No máximo 12 vivos ao mesmo tempo** mais o
  jogador.
- **De fundo**: sem IA semanal; uma vez por ano têm verba, prestígio agregado e lançamentos comerciais agregados (como
  o "background" atual de `calendar.js`). Aparecem na Tabela da Era e nas notícias. Promoção a núcleo quando entram no
  top 12 por prestígio e verba; rebaixamento ao sair.
- **Mortos**: saem de `state.actors` e vão para `state.archive.actors[id] = {name, born, died, cause, bestRank, firsts}`
  (≤ 300 bytes cada). As relações com eles são apagadas.

---

## 6. A agência do jogador: criação, mandatos e investidores

### 6.1 Criar a própria agência (Fase B, item 4)

Assistente de 4 telas no novo jogo, cada uma com uma decisão só (polegar):
1. **Tipo**: estatal ou privada. A privada só é liberada a partir de 1980 na campanha. Antes disso aparece "Empresas
   privadas de lançamento só surgem nos anos 80", e o jogador pode ainda assim criar uma **agência estatal nova** de
   qualquer país.
2. **País e sede**: lista de países (`world.json` + `geopolitics.countryNames`) com busca. A sede é escolhida tocando
   no mapa-múndi (o worldmap ganha modo "escolher ponto", Fase B4) ou numa lista de cidades sugeridas. A base de
   lançamento inicial é uma do país, se houver, ou "contrato com base estrangeira".
3. **Nome e identidade**: nome, sigla (até 6 letras), cor e **logo** (§6.4).
4. **Resumo**: dificuldade derivada (verba inicial pela economia do país e pela era, aliados iniciais pelo bloco do
   país) e botão "Fundar agência".

No estado o ator é normal (`kind: 'agency' | 'company'`, `custom: true`, `id: 'custom_<n>'`). A nação vem de
`politics.nations` ou é criada como **nação genérica** a partir do país (economia média por tamanho, eleições
procedurais), e assim o país escolhido também existe na simulação política.

### 6.2 Mandatos: o modelo que unifica "missões da história" e investidores (item 6)

```js
state.cap = {                    // dono: investors (src/sim/investors.js, módulo novo)
  playerShare: 1.0,              // fração do jogador (0.10..1.0)
  holders: [ { id, name, kind: 'gov'|'investor'|'fund'|'partner', share, profile, since, termEnd, mood, logo } ],
  agenda: { slotsPerYear, used, mandated },
  lastRoundTurn, valuationM
}
state.mandates = [ { id, holderId, kind, title, type, destination, count, deadlineTurn, missionIds: [], penalty, reward, status } ]
```

- **Patrono**: toda missão obrigatória tem um. Para as **agências estatais reais** o patrono é o **governo**, e os
  programas do calendário (Mercury, Apollo, Artemis) são os mandatos do governo. Isso é o comportamento atual,
  rebatizado: `briefing kind 'calendar'` = mandato do governo. O governo não vende participação.
- Para a **agência criada pelo jogador e para empresas** (inclusive SpaceX e Blue Origin jogáveis), **as missões da
  história do calendário viram mandatos de investidores**: o calendário real de 1950 a 2030 não pertence à agência
  nova (os programas reais continuam com os donos reais). No lugar, cada investidor traz um **perfil de mandato**
  (`data/investors.json`: "Telecom: 3 satélites GEO por ano", "Turismo: 2 voos tripulados LEO", "Mineração: pouso no
  asteroide X até 2070", "Defesa: satélite SSO com prazo", "Ciência: sonda a Y").
- **Rodada de investimento**: uma por ano fiscal, usando `cadence(ctx, {weeks: 52, minSteps: 5})`: uma por ano nas
  Eras 1 a 4, uma a cada 5 anos nas Eras 6 e 7. É um cartão **não bloqueante** que expira no fim do passo seguinte, com
  1 a 3 propostas: valor (US$), participação (%), perfil de mandato, prazo e multa. Assinar ou recusar. Botão
  "Recomprar" quando há caixa (preço = participação × avaliação × 1,15).
- **Limites**: investidores somam no máximo **90%** (`playerShare ≥ 0,10`). Uma proposta que passaria do limite não é
  oferecida.
- **Autonomia (≥ 50%)**: o jogador pode adiar um mandato uma vez (custo de humor do investidor) e o conselho não pode
  demiti-lo.
- **Sem autonomia (< 50%)**: os mandatos são vinculantes. Prazo perdido gera multa e cai o humor do investidor. Com
  humor médio ponderado < 20 por 2 rodadas, o conselho **afasta o diretor**: `gameOver {reason: 'board'}`, no mesmo
  caminho da demissão por dívida que já existe, com cartão de aviso uma rodada antes.
- **A Agenda (espaço para missões próprias)**: a agência tem `slotsPerYear` (capacidade de missões simultâneas por ano,
  pela cadência das equipes e plataformas, que cresce com instalações e pesquisa). Os mandatos reservam
  `min(slots, ceil(slots × (1 − playerShare) × 1,1))`. Exemplos com 6 slots:
  100% → 0 mandatos; 70% → 2; 50% → 4; 25% → 5; 10% → 6, quase sem espaço para missões próprias, como o roteiro pede.
- **No loop**: o mandato chega como **briefing** com o selo do patrono (logo e nome do investidor) e o prazo no chip.
  Aceitar cria a missão **sem veículo** (§8), e o jogador escolhe veículo e nave. O Painel ganha o cartão "Conselho":
  "Sua parte: 62% · com autonomia", a barra da Agenda ("3 mandatos · 2 livres") e o próximo prazo.
- **Questão em aberto para o usuário**: as agências estatais reais devem ter também rodadas com parceiros privados a
  partir da Era 3 (parcerias público-privadas, com o governo sempre ≥ 51%)? A proposta deixa isso desligado por padrão
  (`scenario.unlocks.ppp`).

### 6.3 Por que isso é bom para o ritmo

O jogador escolhe, na rodada, **quanto da agenda vende**. Mais dinheiro significa menos liberdade: é uma decisão
estratégica a cada ~25 a 50 toques, nunca um formulário. Ela gera briefings que respeitam o alvo de densidade, porque
mandatos ocupam slots, não criam fila infinita.

### 6.4 Logos (item 5)

`src/ui/logo.js`: gerador de **SVG determinístico** a partir de `actor.logo = {shape: 'roundel'|'shield'|'chevron'|
'orbit'|'star'|'wordmark', field: '#hex', accent: '#hex', emblem: 'rocket'|'orbit'|'star'|'globe'|'wing'|'atom'|...,
ring: bool, stars: 0..5, text: 'SIGLA', era: 1..7}`. As peças ficam em `data/logo-parts.json` (paths SVG pequenos), sem
imagens nem fontes externas.
- **Agências reais**: identidade visual própria, curada no JSON e **sem copiar logotipo oficial** (risco jurídico do
  GDD), com estilo da época: em 1958 o "NASA" do jogo é um *roundel* com órbita, em 2026 um *wordmark* limpo.
  `names[i].logo` muda junto com a renomeação.
- **Atores procedurais**: logo sorteado pela gramática (cor da nação ou bloco, emblema pelo tipo do ator).
- **Agência do jogador**: editor de 5 controles (forma, emblema, duas cores, sigla) com prévia ao vivo, mais um botão
  "Sortear".
- O emblema atual do cabeçalho (`portrait.emblemSVG`) passa a chamar `logo.js`.

---

## 7. Construtor de foguetes (Fase B, item 7)

### 7.1 Modelo de dados

`data/parts.json` (por era: `data/eras/<e>/parts.json`):
```js
{ engines: [ { id: 'rd107', name: 'RD-107', propellant: 'kerolox', thrustKN, ispSL, ispVac, massT, costM, reliability, availableFrom, tech: null|nodeId, family } ],
  stages:  [ { id: 'tank_kerolox', propellant, dryFrac, sizes: { S: 20, M: 60, L: 150, XL: 400 } } ],   // toneladas de propelente
  boosters:[ { id, engineId, propT, dryT, costM, counts: [0,2,4,6] } ],
  fairings:[ { id, diameterM, massT, costM } ],
  avionics:[ { id, reliabilityBonus, costM, availableFrom } ] }
```

O projeto (estado, dono: `src/sim/designs.js`, módulo novo):
```js
state.designs[id] = {
  id: 'dsg_3', name: 'Andorinha II', owner: actorId, baseVehicleId: 'soyuz2' | null, origin: 'license'|'scratch',
  stages: [ { engineId, engines: 5, tankId, size: 'L' }, ... ], boosters: { id, count: 4 }, fairingId, avionicsId,
  derived: { capacity: { leo, gto, tli, mars, outer }, costM, reliabilityPrior, devCostM, devWeeks },  // cache; recalculado por designs.recompute
  program: null | { phase: 'work'|'testFlights'|'operational', startedTurn, readyTurn, testFlights, needFlights },
  stats: { flights, failures }
}
```

- **Física simples e explicável**: Δv por estágio (equação do foguete), comparada com uma tabela de Δv por
  `capacityKey` (leo 9,4 · gto 11,8 · tli 12,5 · mars 13,1 · outer 15,5 km/s, nos dados). A capacidade é a carga máxima
  que fecha o Δv. A empuxo-peso na decolagem precisa ser ≥ 1,2, senão "não sai do chão".
- **Confiabilidade**: o produto das confiabilidades das peças, com penalidade de projeto novo que cai com os voos
  (prior Beta, como `vehicleReliability`). Licenciar um foguete herda o histórico dele (prior mais forte).
- **"Comprar e editar"**: na Fase B cada veículo de `vehicles.json` oferecido para licença ganha `parts` (decomposição
  em peças). A licença exige relação (confiança ≥ X), ausência de embargo e tensão ≤ 2, e custa `licenseM`.
- **"Do zero"**: o jogador parte de um molde de família (2 estágios, 3 estágios, núcleo + boosters, reutilizável)
  com as peças liberadas pela pesquisa e pela era.
- **Desenvolvimento**: igual à certificação tripulada (`work → testFlights → operational`): custo e prazo pagos no
  início, N voos de teste (missões `source: 'test'` com carga lastro, no molde de `source: 'cert'`). Depois disso o
  projeto aparece no montador de missão como qualquer veículo. **Editar** um projeto operacional cria uma revisão
  (`Andorinha II-B`) com custo e prazo menores, mas com voos de teste de novo se a mudança for grande.
- **Resolvedor de catálogo**: `calendar.vehicleDef(state, data, id)` devolve o veículo de `data.index.vehicles` **ou**
  de `state.designs`. **Todo** acesso a veículo em `missions`, `risk`, `calendar` e `launch` passa a usar o resolvedor.
  Isso entra **na Fase A** (varredura) para destravar a B3 sem disputa de arquivo.
- **Arte**: `launch-render/vehicles.js` já tem "template por família" para ids desconhecidos. O projeto passa
  `{family, stages, boosters, diameter}`, e o pintor desenha a pilha sem arte específica.
- **Eras 6 e 7**: o mesmo modelo vira **construtor de naves** (categorias `drive`, `habitat`, `shield`, `probeBus`), com a
  tabela de Δv substituída por "anos até o alvo". O jogo não ganha um segundo editor.

### 7.2 Experiência no celular (tela "Hangar", na gaveta)

- Lista de projetos e licenças disponíveis, com botão "Novo projeto".
- O editor é uma **pilha vertical de cartões** (como o elenco no manager): cada estágio é um cartão com motor (toque →
  folha com opções e o efeito de cada uma: "+0,8 t LEO, −2% confiança, +US$ 4 mi"), tanque (degrau S/M/L/XL), boosters
  (0/2/4/6) e coifa. No topo fica a **silhueta** (do pintor do lançamento) e **barras ao vivo** de capacidade (LEO,
  GTO, Lua, Marte), chance estimada, custo por voo, custo e prazo de desenvolvimento.
- Qualquer mudança fica a **no máximo 2 toques**. O tempo não passa no Hangar. O botão "Desenvolver" abre a folha de
  confirmação com custo e prazo.
- O cálculo é puro (`query('designs/preview', draft)`) e não grava no estado até "Salvar projeto", que é a ação
  `design/save`.

---

## 8. Escolha do veículo pelo jogador (item 9, pedido direto nesta rodada)

### 8.1 O que acontece hoje (lido no código)

- `missions.js` `calendarDraft` preenche `vehicleId/spacecraftId` com o hardware do programa ou, se faltar, com
  `pickConfig` (o "mais barato válido"). `pushOpportunity` preenche com `pickConfig`. `awardToPlayer` (contrato ganho)
  preenche com `pickConfig`.
- Aceitar (`decisionHandlers.briefing` → `createMission`) cria a missão em `planning` já com veículo e nave. O jogador
  só troca se for ao montador e editar (`mission/update` permite).

### 8.2 Proposta

- Aceitar cria a missão em `planning` com `vehicleId: null` e `spacecraftId: null` (exceto nos casos travados abaixo) e
  `suggestion: {vehicleId, spacecraftId, reason: 'Mais barato que cabe a carga' | 'Hardware do programa'}`.
- `scheduleMission` recusa sem veículo, com a mensagem "Escolha o foguete e a nave antes de agendar."
- **Programas do calendário** (Artemis IV = SLS + Orion): o hardware do programa vira a sugestão marcada "Plano do
  programa" e o jogador confirma ou troca. Destino e tipo continuam travados, como hoje.
- **Casos que continuam travados**: o voo de demonstração da certificação (`certVehicleId`) e o voo de teste do
  construtor. Neles o próprio foguete é o objeto da missão.
- **Contratos**: o veículo é escolhido **no lance**, porque o preço depende dele. A folha de lance ganha o passo
  "Com qual foguete?", com a sugestão marcada. O contrato ganho cria a missão com esse veículo.
- **UI**: o cartão de briefing troca "Aceitar" por "**Aceitar e escolher o veículo**", que abre direto
  `#missoes/m/<id>` no passo 2 do montador (veículo), com a sugestão em destaque ("Sugestão dos engenheiros") e **sem
  seleção prévia**. "Aceitar depois" deixa a missão em planejamento, com o selo âmbar "falta o veículo" na lista e no
  Painel.
- **IA e bot**: `pickConfig` continua para a IA e para a sugestão. O bot de smoke e de `sim-campaign` passa a
  despachar `mission/update {vehicleId: suggestion.vehicleId, ...}` depois de aceitar.
- **Testes afetados (atualizar, porque codificam a regra antiga de "aceitar já escolhe")**: `missions.test.mjs:371`,
  `briefing-end.test.mjs:61/73`, `integrity.test.mjs:26` e `tools/sim-campaign.mjs`/`smoke.mjs`, quando conferem que a
  missão aceita já tem veículo ou já é agendável.

---

## 9. O que muda em cada módulo existente

| Arquivo | Mudança | Fase |
| --- | --- | --- |
| `src/core/time.js` | Funções de data intactas. Novas: `stepLabel(stepWeeks)` ("+2 sem", "+1 mês", "+3 meses", "+1 ano"), `yearOf(turn, startYear)` (substitui as 3 cópias locais) e `weeksToText` com décadas e séculos ("3 décadas", "1,2 século") | A |
| `src/core/engine.js` | `clock`, `dt`, passo truncado, `isBlocked 'era'`, `era/continue`, `time/pace`, hooks de era e de ator, `advance` por passos, `SAVE_VERSION = 2` e `deserialize` via `migrate.js`. `MODULES` ganha `lifecycle` (logo depois de politics), `investors` (B), `designs` (B), `colonies` e `eco` (C) | A, B, C |
| `src/core/helpers.js` | `perStep`, `chanceInStep`, `crossed`, `cadence`, `dueIn`, `actorName(state, id)` (nome pela data) | A |
| `src/core/data.js` | Pacotes, manifesto, fusão por id, carregamento preguiçoso por era, `rebuildIndex` (§11) | A |
| `src/core/scenario.js` (novo) | `bootstrap(scenario, data)`: atores vivos, feitos históricos derivados, `vehicleStats` e snapshots | A |
| `src/core/migrate.js` (novo) | Cadeia de migrações de save (§12) | A |
| `src/sim/budget.js` | `yearOf` com fallback 2026 → helper do core. Receita e custo fixo semanais × `dt`. Fechamento de ano por `crossed(52)` | A |
| `src/sim/calendar.js` | `REVISION_PERIOD` por `crossed`. Lançamentos "devidos no passo" por `dueIn`. Fundo comercial × `dt`. **Resolvedor `vehicleDef`/`spacecraftDef`** (inclui `state.designs`). `canon` (§4.3). Hook `onActorGone` reatribui ou cancela itens | A (resolvedor e dt), C (canon) |
| `src/sim/politics.js` | Integrador de pressão de tensão com `dt` (exponencial: `p *= decay^dt`). Eleições por data. Nações genéricas para país criado (B). Nações por era (URSS → Rússia + Ucrânia em 1991) | A, B, C |
| `src/sim/diplomacy.js` | `yearOf` → core. IA de propostas por `cadence`. `seedRelations(actorId)` exportado. Limpeza de relações ao morrer. A Tabela da Era fecha em `onEraEnd` (troféu por era) | A |
| `src/sim/research.js` | Progresso × `dt`. Nós com `era` já existem (`tech.json` tem `era: 4`). A árvore filtra por era vigente ± 1 e acumula as anteriores | A, C |
| `src/sim/crew.js` | `sy ?? 2026` → core. Envelhecimento e aposentadoria por idade (1050 anos = gerações). **Herdeiros** (legado de sobrenomes do GDD) na Fase C | A, C |
| `src/sim/missions.js` | Item 9 (§8). Ofertas de oportunidade por `cadence`. `untilYear: 2030` nas fontes de contrato vira `from/until` por era em dados. Mandatos (B) como nova fonte de briefing `kind: 'mandate'`. Missões "de geração" (trânsito de décadas) nas Eras 6 e 7 | A (9 e dt), B, C |
| `src/sim/risk.js` | `startYear ?? 2026` → core. Veículo pelo resolvedor | A |
| `src/sim/launch.js` | Nada de tempo (o Dia de Lançamento é intra-passo). Veículo pelo resolvedor | A |
| `src/sim/narrative.js` | `trigger.minTurn/maxTurn` (relativos ao início) passam a aceitar `fromYear/untilYear/era` (absolutos). `{year}` pelo core. Chance por `chanceInStep`. Pesos e cooldowns em semanas continuam valendo | A |
| `src/sim/lifecycle.js` (novo) | §5 | A |
| `src/sim/investors.js` (novo) | §6.2 | B |
| `src/sim/designs.js` (novo) | §7 | B |
| `src/sim/colonies.js` (novo) | Estágios de colonização do GDD, suprimentos, opinião, independência → `lifecycle.birth` | C |
| `src/sim/eco.js` (novo) | Peças do Eco por era (`state.eco.pieces`), o Colégio Silêncio, o capítulo final de 3000 com 3 desfechos | C |
| `src/ui/app.js` | Casca nova (§10): registro de telas, gaveta, barra de 4 + disco, rótulo do passo, `RUN_MAX_STEPS`, cena de era | A |
| `src/ui/store.js` | Slots de save (auto, era, manuais), `ensureEra(eraId)` (carrega pacote), mensagens de save recusado em pt-BR, ritmo | A |
| `src/ui/newgame.js` | Tela inicial com **Campanha** / **Cenários** / **Continuar**, seletor de ritmo e de história. Assistente de criação na Fase B | A, B |
| `src/ui/dashboard.js` | Cartão de era e capítulo ("Era 1 · Capítulo Sputnik · 1958"), cartão Conselho (B) | A, B |
| `src/ui/missions-tab.js` | Item 9: entrar no passo 2, sugestão sem seleção, selo "falta o veículo". Projetos do Hangar na lista de veículos (B) | A, B |
| `src/ui/map.js` | Níveis por era (Setor e Galáxia nas Eras 6 e 7), névoa de guerra, rotas de colônias (B4, C) | B, C |
| `src/ui/worldmap.js` | Sedes que nascem e morrem com a linha do tempo, blocos históricos (OTAN/Pacto de Varsóvia até 1991 por tingimento de países, sem fronteiras históricas), modo "escolher sede" (B1) | B |
| `styles.css` | Tokens por era (`body[data-era="1".."7"]`): só acento, textura e tom de superfície mudam; o sistema de DESIGN.md continua. Estilos da gaveta | A (gaveta), C (paletas) |
| `sw.js` | Nada estrutural (o crawl segue `import()`). Os pacotes de era entram no precache preguiçoso: o primeiro uso grava a cópia | A |

---

## 10. Navegação: barra inferior, gaveta e registro de telas (item 8)

### 10.1 Casca (espelho de `movel.css` e `responsivo.tsx` do CSmanager)

```
┌───────────────────────────────────────────┐
│ ☰  Missões                 ⟨emblema⟩ mar/1962 │  topo compacto: hambúrguer, título da tela, emblema e data
│ ▸ ticker de manchetes                      │
│                                           │
│               (tela)                      │
│                                           │
├───────────────────────────────────────────┤
│ Painel  Missões   (◉ +2 sem)  Mapa  Mundo  │  4 destinos + disco = 5 slots iguais; disco no centro
└───────────────────────────────────────────┘
```

- **Barra inferior com 5 slots** (hoje são 7: 6 abas + disco). Alvos maiores, o disco segue no centro exato.
  `DISC_AT = 2`, e o teste `ui-play-disc.test.mjs:71` que fixa `DISC_AT = 3` muda (atualização de teste por
  mudança de layout pedida no roteiro).
- **Gaveta** (`.gaveta` entra pela esquerda, `.veu` escurece e fecha ao toque, fecha com arrasto horizontal, foco no
  destino atual, `Esc` fecha, o voltar do Android fecha primeiro a gaveta). Grupos:
  - **Agência**: Painel, Equipe, Hangar (B), Conselho (B, só com patronos), Finanças, Instalações (C).
  - **Operações**: Missões, Calendário de lançamentos (novo, lista `.agenda-do-mes`), Pesquisa.
  - **Universo**: Mapa espacial, Colônias (C).
  - **Mundo**: Mapa-múndi, Notícias, Rivais e diplomacia, Tabela da Era, Linha do tempo (Arquivo de atores, eras e
    feitos).
  - **Legado**: Memorial, Álbum, Arquivo do Eco (C).
  - **Sistema**: Ajustes, Salvar e capítulos, Sair para o título.
- Selos âmbar ("precisa de você") na gaveta e no ícone ☰ quando algo fora da barra pede atenção (mandato vencendo,
  projeto pronto).

### 10.2 Registro de telas (`src/ui/screens.js`)

```js
registerScreen({
  id: 'hangar', title: 'Hangar', icon: 'wrench', group: 'agencia',
  nav: 'drawer',                         // 'bottom' | 'drawer' | 'hidden'
  order: 30,
  available: (state, data) => unlocked(state, 'builder'),   // some da gaveta se false
  badge: (state) => readyDesigns(state).length,               // número ou true
  load: () => import('./hangar.js'),     // render(container, store) → cleanup
});
```

- O `app.js` deixa de ter `TABS`, `SCREEN_TITLES` e `VIEW_PARENT` fixos: roteador (`#id/sub`), título, barra, gaveta e
  selos saem do registro. Telas carregam sob demanda (`import()`), como o mapa já faz.
- **Adicionar uma tela = 1 arquivo + 1 `registerScreen`** num único lugar (`src/ui/screens.js` importa só os
  descritores, não os módulos). Isso permite builders paralelos sem disputar o `app.js`.
- Teste estático novo: toda tela registrada tem `title` em pt-BR, `icon` existente em `components.ICONS` e `load` que
  resolve.

### 10.3 Cena de transição de era (`src/ui/era-scene.js`)

Overlay de tela cheia, 4 cartões com deslize (botões "Próximo" para quem não desliza):
1. **"Fim da Era 1: A Corrida"**: troféu da Tabela da Era e posição da agência.
2. **"O que você fez"**: até 3 feitos ("primeiro a…"), a melhor carta do Álbum e o número de lançamentos.
3. **"Quem ficou"**: rostos de quem está desde o início da era, nomes no Memorial e o "herdeiro" se houver (C).
4. **"A próxima era"**: o que muda: "Agora cada toque = 1 mês", sistemas liberados ("Construção de foguetes",
   "Colônias"), atores que nasceram ou morreram, e uma peça do Eco (texto curto). Botão "Começar a Era 2".

Respeita reduzir movimento (sem deslize animado), não tem som obrigatório e grava o checkpoint de era antes do
cartão 4. Enquanto a cena está aberta, o `store` carrega o pacote da era seguinte. Se falhar (offline sem cópia), o
botão mostra "Baixando a próxima era…" e tenta de novo; o save fica parado na fronteira, sem estado meio aplicado.

---

## 11. Pacotes de dados e carregador

### 11.1 Estrutura

```
data/
  scenario.json            ← cenário lunar_race (caminho antigo; continua)
  actors.json, vehicles.json, ... ← pacote "e4-lunar" (os arquivos de hoje, sem mover na Fase A)
  packs.json               ← manifesto (novo)
  core/                    ← regras e vocabulário independentes de era (Fase A cria vazio; move aos poucos)
    lifecycle.json, procgen/actors.json, logo-parts.json (B), investors.json (B)
  scenarios/
    campaign.json, race_1957.json, ...
  eras/
    e1/era.json, actors.json, vehicles.json, spacecraft.json, calendar.json, events.json, tech.json, politics.json, parts.json
    e2/ ... e7/
```

`data/packs.json`:
```js
{ packs: {
    base: { files: ['bodies','destinations','crew','geopolitics', ...], always: true },
    e4:   { files: { actors: 'actors', vehicles: 'vehicles', calendar: 'calendar', ... }, years: [2026, 2050] },   // aponta para os arquivos na raiz
    e1:   { dir: 'eras/e1', files: [...], years: [1950, 1975] }, ... },
  scenarios: { lunar_race: 'scenario', campaign: 'scenarios/campaign', ... } }
```

### 11.2 Regras do carregador

- `loadData(reader, {scenarioId = 'lunar_race', eras})` → mesmo **formato de saída de hoje** (`data.vehicles.vehicles`,
  `data.index...`). Os módulos não percebem os pacotes.
- **Fusão determinística** por lista com `id`: pacotes na ordem do manifesto, um id repetido sobrescreve campo a campo
  (`"$replace": true` troca inteiro). Listas sem id concatenam. Objetos de config fundem raso.
- **Janela de eras carregadas**: era vigente, anterior (veículos que ainda voam, como a Soyuz de 1966 a 2030+) e
  seguinte (pré-carregada a 85% da era). Um item com `availableUntil` além da era é **copiado** pelo autor para o pacote
  da era seguinte com `"$carry": "e3"` (o validador confere). Isso mantém cada era autossuficiente.
- `loadDataNode(root)` sem opções = exatamente os dados de hoje, e os 327 testes não mudam. `loadDataNode(root,
  {scenarioId: 'campaign', eras: 'all'})` para o bot de campanha.
- `data.index` é reconstruído a cada troca de pacote (`rebuildIndex`). O save grava `state.dataPacks = {e1: hash, ...}`
  e avisa (sem recusar) se o conteúdo mudou entre versões.
- **Validador** (`tools/validate-data.mjs` + teste): ids únicos, referências resolvidas (operador, destino, marco),
  `truthLayer` coerente com o ano (fato ≤ 2025, plano até ~2035, projeção até 2050, especulação depois), textos sem
  "TODO" e datas dentro da era.

### 11.3 Orçamento por pacote

Cada era ≤ **350 KB** de JSON cru (a Era 4 de hoje tem ~560 KB contando `vehicle-art.json` e `events.json`; a arte fica
no pacote base). Na partida: base + 1 era ≤ **700 KB** cru (~150 KB gzip pelo GitHub Pages). `world.json` (147 KB)
continua preguiçoso.

---

## 12. Migração de save

- `SAVE_VERSION = 2`. `src/core/migrate.js` exporta `migrate(raw) → state | throw SaveError(ptMessage)`.
- **v1 → v2** (todo save de hoje é Corrida Lunar):
  `scenarioId ??= 'lunar_race'`;
  `clock = {epochYear: 1950, eraId: 'e4', stepWeeks: 1, paceMult: 1, steps: turn, eraStartTurn: 0, pendingEra: null}`;
  `archive = {actors: {}}`; `cap = {playerShare: 1, holders: [{id: 'gov', kind: 'gov', share: 0}]}` (agência estatal) ou
  `{playerShare: 1, holders: []}` (empresa); `mandates = []`; `designs = {}`; `lifecycle = {applied: [], nextIdx}`
  calculado pela data; `dataPacks = {}`.
- Com `dt = 1` e os mesmos dados, **um save v1 migrado joga igual a antes** (teste com fixture, §13).
- **Recusas com mensagem pt-BR** (o `store.load` mostra num cartão e oferece "Começar de novo" ou "Exportar o save"):
  - versão maior que a do jogo: "Este save é de uma versão mais nova do Ad Astra. Atualize o jogo para continuar.";
  - JSON corrompido ou sem campos mínimos: "Não foi possível ler este save. Ele pode estar corrompido.";
  - cenário desconhecido: "Este save usa um cenário que não existe nesta versão.".
- Chaves do localStorage: `adastra.save.v1` continua sendo lida (migra e regrava em `adastra.save.auto`). A v1 só é
  apagada depois de gravar a v2 com sucesso.
- **Tamanho**: alvo ≤ **400 KB** cru por slot em qualquer ponto da campanha. Medidas: `news` cap 200 (já existe),
  `finance.ledger` cap 300 (já existe), `archive` compacto, e `calendar` com instâncias resolvidas de eras passadas
  compactadas em `archive.calendar` (id, status e ano). Se o navegador oferecer `CompressionStream('gzip')`, os slots
  de era gravam comprimidos (base64), cabendo 5 slots em ~1 MB. Sem a API, gravam cru.

---

## 13. Desempenho e testes

### 13.1 Orçamentos

| Medida | Orçamento | Como medir |
| --- | --- | --- |
| Tempo por passo (Node, qualquer era) | ≤ 4 ms médio, ≤ 15 ms p99 | `campaign-3000.mjs --perf` |
| Toque no celular intermediário (dispatch e render da tela) | ≤ 120 ms p95 | marca `performance` em `app.js`, verificação manual a 4× CPU throttle |
| "Próximo evento" (até 12 passos) | ≤ 1,5 s com o anel animado | idem |
| Campanha sem tela 1950 → 3000 | ≤ 30 s por semente (~3.300 passos) | CI local: 3 sementes ≤ 90 s |
| Atores núcleo vivos | ≤ 12 + jogador | invariante no bot |
| Save | ≤ 400 KB cru | invariante a cada fronteira de era |
| Dados na memória | ≤ 3 eras carregadas | invariante |
| Partida (dados) | ≤ 700 KB cru | teste estático do manifesto |

### 13.2 Estratégia de testes

1. **Determinismo de regressão (a rede de segurança da Fase A)**: antes de qualquer mudança, gravar
   `tests/fixtures/golden-lunar.json` com o hash do estado depois de 260 semanas para 3 sementes × 5 atores, usando a
   política do bot. Depois da Fase A, com `dt = 1`, o hash da **projeção dos slices antigos** tem que ser igual. Os
   campos novos ficam fora do hash.
2. **Fixture de save v1**: `tests/fixtures/save-v1-turn120.json` gerado pela versão atual **antes** da refatoração.
   Teste: migra, joga até o fim, sem exceção, e o resultado bate com o jogo contínuo da v1.
3. **Invariância de taxa**: para cada módulo com taxa, 52 semanas com `dt = 1` contra 13 passos com `dt = 4` e 1 passo
   com `dt = 52`. Verba, pesquisa e tensão média dentro de ±5%; número de eventos dentro de ±15%.
4. **Ciclo de vida**: rodar 1950 → 2030 sem jogador e conferir cada linha de §5.3 (nome certo na data certa, fusões,
   relações semeadas e limpas). Depois de 2030, com 5 sementes: ≥ 1 nascimento procedural e ≥ 1 dissolução; núcleo
   ≤ 12.
5. **Bot de campanha** (`tools/campaign-3000.mjs`): joga como um jogador "esperto" (reusa `sim-campaign.mjs`), escolhe
   veículos pela sugestão, assina investidores até 60%, desenvolve 1 projeto por era a partir da B, faz save e load em
   cada fronteira de era (estado idêntico), atravessa as 7 eras e escolhe um desfecho em 3000. Saída: tabela por era
   com toques, paradas por toque (**alvo 0,15 a 0,35**), lançamentos, mortes, caixa e tamanho do save. Falha por
   exceção, NaN, `log` com "erro", orçamento estourado ou densidade fora do alvo por > 20% da era.
6. **Smoke atual** (`tools/smoke.mjs`) continua na Corrida Lunar. Ganha `--scenario` para rodar os cenários novos.
7. **Testes de UI estáticos**: registro de telas, gaveta (classes, `aria-expanded`, foco), barra de 5 slots, rótulo
   do passo para cada `stepWeeks`, cena de era sem "undefined/NaN".
8. **Validador de dados** (§11.2) como teste.

---

## 14. Fases, entregas e divisão de arquivos para builders em paralelo

Regra geral: **cada arquivo tem um dono por fase**. Arquivos compartilhados recebem mudanças só pelos pontos de
extensão definidos (hooks, registro de telas, resolvedor), nunca por edição cruzada.

### Fase A: fundação (este workflow)

Entrega: engine de eras com `dt`, cenários e campanha (esqueleto jogável 1950 → 3000 com conteúdo mínimo), ciclo de
vida com a lista real de 1950 a 2030, sim independente de era, pacotes de dados, casca com gaveta e registro de telas,
cena de era, save v2. **Mais o item 9 (escolha do veículo).** A Corrida Lunar idêntica.

| Builder | Dono de | Não toca |
| --- | --- | --- |
| **A0 golden** (primeiro, sozinho, ~1 h) | `tests/fixtures/golden-lunar.json`, `tests/fixtures/save-v1-*.json`, `tools/golden.mjs` | todo o resto |
| **A1 core-time** | `src/core/engine.js`, `time.js`, `helpers.js`, `migrate.js` (novo), `scenario.js` (novo), `tests/time-engine.test.mjs`, `tests/migrate.test.mjs` | sim, ui, data |
| **A2 data-pipeline** | `src/core/data.js`, `data/packs.json`, `data/scenarios/*`, `data/eras/e*/era.json` (meta, ritmo, capítulos, paleta), `tools/validate-data.mjs`, `tests/data-packs.test.mjs` | arquivos de conteúdo da raiz `data/*.json` |
| **A3 lifecycle** | `src/sim/lifecycle.js` (novo), `data/core/lifecycle.json`, `data/core/procgen/actors.json`, nomes e snapshots **só dos atores novos** em `data/eras/e1..e3/actors.json` (mínimo para o esqueleto), `tests/lifecycle.test.mjs` | `data/actors.json` (A4a adiciona `names` aos 8 atuais) |
| **A4a sim-mundo** | `src/sim/politics.js`, `diplomacy.js`, `budget.js`, `data/actors.json` (campos `names`/`snapshots`), `data/politics.json` | missions, calendar |
| **A4b sim-agência** | `src/sim/calendar.js` (dt + resolvedor), `missions.js` (dt + **item 9 sim**), `risk.js`, `launch.js`, `crew.js`, `research.js`, `narrative.js`, testes desses módulos (atualizar os que fixam "aceitar já escolhe") | ui |
| **A5 ui-shell** | `src/ui/app.js`, `src/ui/screens.js` (novo), `src/ui/drawer.js` (novo), `src/ui/era-scene.js` (novo), `src/ui/store.js`, `src/ui/newgame.js`, `src/ui/settings.js`, `styles.css` (gaveta e tokens por era), `tests/ui-*.test.mjs` de casca | telas de conteúdo |
| **A6 ui-missões** | `src/ui/missions-tab.js`, `src/ui/decisions.js`, `src/ui/dashboard.js` (item 9 e cartão de era) | app.js (registra via `screens.js` pelo A5) |
| **A7 bot** | `tools/campaign-3000.mjs` (novo), `tools/smoke.mjs`, `tools/sim-campaign.mjs` | src |

Ordem: A0 → (A1 ∥ A2) → (A3 ∥ A4a ∥ A4b ∥ A5 ∥ A6) → A7 → integração. Contratos entre eles: a assinatura de `ctx.dt`
e dos helpers (A1 publica primeiro), o formato de `packs.json` (A2), os hooks `onActorBorn/Gone` (A1 define, A3 chama,
A4 implementa) e `registerScreen` (A5 publica antes do A6).

### Fase B: a agência do jogador

| Builder | Dono de |
| --- | --- |
| **B1 criação e logos** | `src/ui/newgame.js` (assistente), `src/ui/logo.js` (novo), `data/core/logo-parts.json`, `src/core/scenario.js` (`customActor`), nação genérica em `politics.js` (pela função exportada `ensureNation`, combinada com o dono de politics), logos dos atores reais em `data/actors.json` + `data/eras/*/actors.json` |
| **B2 investidores** | `src/sim/investors.js` (novo), `data/core/investors.json`, `src/ui/board.js` (Conselho), fonte `mandate` em `missions.js` (só a função `pushMandateBriefing`, combinada com o dono de missions) |
| **B3 construtor** | `src/sim/designs.js` (novo), `data/eras/*/parts.json`, `parts` nos veículos licenciáveis de `vehicles.json`, `src/ui/hangar.js` (novo), família de pilha em `launch-render/vehicles.js` |
| **B4 mapas** | `src/ui/map.js`, `map.css` (níveis por era, névoa, nascimento de sedes), `src/ui/worldmap.js`, `worldmap.css` (linha do tempo 1950+, blocos históricos, escolher sede) |
| **B5** | item 9, se não entrou na A, nos mesmos arquivos de A4b e A6 |

### Fase C: conteúdo das 7 eras e o final de 3000

Um builder por era, dono exclusivo de `data/eras/eN/*` (atores, veículos, naves, calendário com `canon`, eventos,
tech, política, peças) e do cenário curto da era. **C1** 1950–1975, **C2** 1976–1999, **C3** 2000–2025 (inclui
reconciliar a Era 4 atual com o passado), **C4** 2031–2050 (projeção), **C5** Eras 5 a 7 (especulação e procgen),
**C6** `src/sim/eco.js`, `src/sim/colonies.js`, `src/ui/ending.js`, a cadeia do Eco em `data/core/eco.json` e paletas
por era em `styles.css` (seção marcada). Regras: densidade de paradas no alvo **verificada pelo bot**, texto pt-BR e
datas "conferir" com fonte em `source`.

### Fase D: equilíbrio, revisão e publicação

`tools/campaign-3000.mjs` com 20 sementes × atores jogáveis por era, ajuste de tabelas de ritmo (só dados), revisão de
texto, auditoria de desempenho no celular (throttle 4×), PWA, subir `APP_VERSION`/`SW_VERSION`/`BUILD` e
PROGRESS.md/ARCHITECTURE.md.

---

## 15. Riscos e respostas

| Risco | Resposta |
| --- | --- |
| Varredura `dt` muda a Corrida Lunar sem querer | A0 golden e hash da projeção com `dt = 1`. Nenhuma mudança de balanço na Fase A |
| A campanha fica longa demais e o jogador abandona | Ritmo Rápido, capítulos, cenários de 1 a 2 h, checkpoints por era e o bot medindo toques por era |
| Divergência histórica gera um calendário absurdo | `canon` obrigatório nos itens dependentes e o seletor Fiel/Divergente |
| Explosão de atores procedurais | Teto de 12 núcleo, rebaixamento a fundo, arquivo compacto |
| Conteúdo de 7 eras sem fim | Era 5+ com procedural pesado e eventos modulares; autoral só nos momentos-chave (o GDD já prevê) |
| Investidores viram microgestão | Uma rodada por ~25 a 50 toques, cartão não bloqueante, mandatos limitados pela Agenda |
| Construtor vira KSP no celular | Pilha de cartões com degraus, sem posição livre de peças, 2 toques por mudança, prévia pura |
| Save cresce em 1050 anos | Caps atuais, arquivo por era e gzip opcional; teto testado |

## 16. Perguntas abertas ao usuário

1. Agências estatais reais também recebem rodadas de investidores (parceria público-privada com governo ≥ 51%) a
   partir da Era 3, ou investidores só para agências criadas e empresas? A proposta usa a segunda opção como padrão.
2. Empresa privada criada antes de 1980: bloquear (proposta) ou permitir com dificuldade alta?
3. O seletor "História: Fiel/Divergente" deve existir, ou o passado é sempre fiel?
4. Ritmo Normal ~3.300 toques (~20 h). O alvo está bom, ou a campanha padrão deve ser a Rápida?
