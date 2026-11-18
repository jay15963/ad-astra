# Proposta de arquitetura nº 3 — Expansão 1950–3000 (ótica: pipeline de conteúdo primeiro)

> Arquiteto #3. Documento de proposta, não de contrato: nada aqui foi implementado. Cobre os 9 itens do roteiro do
> usuário e as fases A–D. A ótica é **otimizar a autoria de 1050 anos de dados**: o código vira um motor
> era-agnóstico pequeno e estável, e quase todo o trabalho das fases B–D vira dado validado, escrito em paralelo.
>
> Base lida: `GDD.md`, `ARCHITECTURE.md`, `PROGRESS.md`, `docs/DESIGN.md`, `src/core/*.js`, cabeçalhos e
> suposições de data de `src/sim/*.js`, `src/ui/app.js`, formatos de `data/*.json`, `tools/smoke.mjs`.
> Medições locais (Node 24, nesta máquina): **2,9 ms por tick** semanal no cenário atual (8 atores), save de
> **221 KB** no fim de 2030, dados carregados no boot ≈ **630 KB** (sem `world.json`, 151 KB, carregado sob demanda).

---

## 0. Resumo em 12 linhas

1. **Relógio interno = semana absoluta** (52/ano, calendário simplificado de hoje). `state.turn` continua sendo
   "semanas desde `state.startYear`"; nada de reescrever as centenas de comparações `turn >= x` dos módulos.
2. **Turno do jogador = passo de N semanas que depende da era** (1, 2, 2, 2, 13, 26, 52). O tick do sim anda o
   mesmo passo e entrega `ctx.dt` (semanas) e `ctx.crossed('year'|'quarter'|'month')` aos módulos.
   Campanha 1950→jan/3000 = **5 098 turnos**; Corrida Lunar continua 260 turnos de 1 semana (passo do cenário).
3. **Dados em pacotes por era** (`data/packs.json` + `data/eras/eN-*/…` + `data/core/` + `data/gen/`), mesclados
   por `id` num objeto `data` com **exatamente o mesmo formato de hoje** (`data.vehicles.vehicles`, `data.index`…).
   Os módulos de sim não sabem que pacotes existem.
4. **Fase A não move nenhum arquivo de dados**: o pacote `legacy-e4-lunar` aponta para os `data/*.json` atuais.
   O cenário Corrida Lunar fica bit-a-bit idêntico (teste "golden" de hash de estado).
5. **Validador próprio sem dependências** (`tools/validate/`) com esquemas por tipo de entidade, regras de
   referência cruzada, janela de datas da era, camada de veracidade × data, fonte obrigatória para `fato`/`plano`
   e checagens de texto pt-BR. Roda em `node tools/validate.mjs` e dentro de `node --test`.
6. **Quatro camadas de veracidade com comportamento de sim diferente**: `fato` (ancorado), `plano_oficial`
   (atraso sorteado, como hoje), `projecao` (acontece com chance e janela), `especulacao` (gerado).
7. **Geradores procedurais puros e determinísticos** (`src/gen/*.js`, gramáticas em `data/gen/*.json`) para
   agências, foguetes, destinos, programas e eventos depois de 2030. O que geram vai para `state.gen` e entra no
   `data` por uma **sobreposição** (`overlay`) — o resto do sim continua chamando `vehicleDef(data, id)`.
8. **Ciclo de vida dos atores por dado** (`lifecycle.json`): nascimento, renomeação (mesma linhagem, nova
   identidade), fusão, cisão, dissolução; datas reais 1950–2030, nascimentos procedurais depois.
9. **Agência do jogador tem tabela de participação** (cap table). Missões de programa viram **missões de
   investidor**; ≥ 50% = autonomia; investidores somados ≤ 90%. Agência fundada do zero começa com 100%.
10. **Construtor de foguetes por peças** derivadas dos foguetes reais (`data/core/parts.json` + `design` em cada
    veículo), com equação do foguete calibrada para reproduzir o catálogo (±5%, testado).
11. **Casca de UI com registro de telas** (`src/ui/screens.js`) + **gaveta hambúrguer** (`.gaveta`/`.veu` do
    CSmanager) + barra inferior configurável; telas novas entram só registrando-se.
12. **Escolha de veículo é sempre do jogador**: aceitar missão cria rascunho sem foguete e abre o Montador no
    passo do veículo; a sugestão vira só um destaque.

---

## 1. Princípios da ótica "conteúdo primeiro"

- **Mil anos são dado, não código.** Cada vez que um construtor de conteúdo da fase C precisar mudar `src/sim`,
  é sinal de que faltou um campo de dado ou um gancho genérico na fase A/B. A fase A existe para que a fase C seja
  quase só `data/eras/eN/**`.
- **Um formato, muitas fontes.** Dado escrito à mão, dado gerado e dado criado pelo jogador (foguete projetado,
  agência fundada) têm o **mesmo esquema** e passam pelo **mesmo validador**. O sim não distingue a origem.
- **Pacotes pequenos e independentes por era**, com propriedade clara de arquivo, para que sete autores trabalhem
  ao mesmo tempo sem colisão. Referências entre eras são só para trás (era N cita entidades da era ≤ N) ou via
  vocabulário central congelado.
- **Validação local e barata antes de qualquer teste de jogo.** O validador pega 90% dos erros de conteúdo em
  < 1 s; o smoke de campanha pega o resto.
- **A Corrida Lunar é o canário.** Ela continua jogável e idêntica; toda mudança de motor é provada contra ela.

---

## 2. Modelo de tempo

### 2.1 Unidade interna

**Semana** (52 por ano, 4,33 por mês — `src/core/time.js` atual). Alternativas descartadas:

| Opção | Por que não |
|---|---|
| Dia | Reescreve todas as constantes de semana (`transitWeeks`, `durationWeeks`, `cooldownWeeks`, `standDownWeeks`, `periodWeeks` das janelas…) em ~10 módulos e ~12 arquivos de dados, sem ganho de jogo. |
| Mês | Quebra a Corrida Lunar (1 turno = 1 semana) e as janelas de Marte (113 semanas). |
| Ano fracionário (float) | Não é determinístico entre plataformas em somas longas; JSON com floats de tempo é frágil. |

Semana absoluta cabe folgado: 1950→3000 = 54 600 semanas (inteiro pequeno). `turnToDate(turn, startYear)`
continua valendo; `state.startYear = 1950` na campanha e `2026` na Corrida Lunar.

### 2.2 Passo por era (turno do jogador = tick do sim)

O GDD diz que "a unidade de tempo muda com a era: semanas nos anos 50, anos no século 30". Proposta concreta:

| Era | Anos | Anos | Passo (`turnWeeks`) | Turnos | Rótulo de data na UI | Justificativa |
|---|---|---|---|---|---|---|
| 1 A Corrida | 1950–1975 | 26 | 1 semana | 1 352 | `sem 14 · abr/1957` | Era mais densa em "primeiros" (Sputnik→Apollo-Soyuz, ~60 marcos e ~400 lançamentos reais); é também o tutorial. Semana dá o drama do GDD. |
| 2 Estações e Sondas | 1976–1999 | 24 | 2 semanas | 624 | `quinz. 2 · mar/1986` | Cadência menor de marcos; estações e sondas longas. |
| 3 Era Comercial | 2000–2025 | 26 | 2 semanas | 676 | idem | Muitos lançamentos, poucos marcos novos; contratos comerciais. |
| 4 Década Lunar | 2026–2050 | 25 | 2 semanas (campanha) · **1 semana no cenário Corrida Lunar** | 650 | idem / `sem` | O cenário mantém o seu passo por `scenario.turnWeeks`. |
| 5 Expansão do Sistema | 2051–2199 | 149 | 13 semanas (trimestre) | 596 | `T3 · 2087` | Trânsitos de meses a anos; colônias crescem por trimestre. |
| 6 Interplanetária e Interestelar | 2200–2599 | 400 | 26 semanas (semestre) | 800 | `2º sem · 2340` | Trânsitos de décadas; gerações de tripulação. |
| 7 Galáctica | 2600–2999 | 400 | 52 semanas (ano) | 400 | `2741` | "Anos no século 30". |
| Fim | jan/3000 | — | — | — | — | Turno final = semana 54 600 = **O Grande Silêncio**. |

**Total: 5 098 turnos.** Por que esse número é o certo:

- O que custa tempo do jogador não é o turno, é o **evento** (o disco central já avança até o próximo evento,
  `stopOnEvent`). O alvo de design é **~1 evento relevante a cada 2–4 turnos** em todas as eras; com isso cada era
  dá 4–10 h e a campanha dá **40–60 h** ("dezenas de horas" no GDD). Turnos maiores em eras longas mantêm a
  densidade de eventos constante sem inflar o conteúdo necessário.
- O que custa tempo de CPU é o **tick**. 5 098 ticks × ~4–6 ms (mais atores) ≈ **20–30 s** de campanha headless
  sem lançamentos interativos — viável para um smoke completo por semente (§13).
- **Todos os passos dividem 52 e as fronteiras de era caem no início de ano**: 1976 ⇒ semana 1 352 (par),
  2000 ⇒ 2 600 (par), 2026 ⇒ 3 952 (par), 2051 ⇒ 5 252 (= 13·404), 2200 ⇒ 13 000 (= 26·500),
  2600 ⇒ 33 800 (= 52·650), jan/3000 ⇒ 54 600. Logo todo tick cai num limite de mês/trimestre/ano e `jan/3000`
  é exatamente o último turno.

### 2.3 O que muda no motor

```js
// src/core/time.js (novo)
export function eraAt(data, turn, startYear) -> eraDef            // de data/core/eras.json
export function stepWeeks(state, data) -> n                       // scenario.turnWeeks ?? era.turnWeeks
export function crossed(prevTurn, turn, unit) -> bool             // 'year'|'quarter'|'month'|'week'
export function formatTurnEra(turn, startYear, era) -> string     // rótulos da tabela acima
// src/core/engine.js
tick(state, data):  dt = stepWeeks(state, data); ctx.dt = dt; ctx.prevTurn = turn;
                    ctx.crossed = (u) => crossed(turn, turn + dt, u); ctx.perWeek = (p) => 1 - (1 - p) ** dt;
                    ... módulos ...; state.turn += dt; state.step += 1;
```

- `state.step` (novo) conta turnos do jogador; `state.turn` conta semanas. `advance(state, data, n)` passa a
  significar **n turnos** (a UI chama `{type:'time/advance', turns}`; `weeks` fica como alias para dt=1).
- Regras de migração dos módulos (auditoria automatizável por `tools/audit-dt.mjs`, que grepa os padrões):

| Padrão hoje | Vira | Onde aparece (amostra) |
|---|---|---|
| `x / WEEKS_PER_YEAR` como taxa por tick | `x * ctx.dt / 52` | calendar.js 892/1023/1396, budget.js |
| `turn % 52 === 0`, `turn % WEEKS_PER_YEAR === 51` | `ctx.crossed('year')` | crew.js 792, calendar.js 1450 |
| `rng.chance(pSemanal)` | `rng.chance(ctx.perWeek(p))` | narrative, politics, diplomacy |
| `x === state.turn` (evento "neste turno") | `x <= state.turn` + flag de consumido ("vencido") | missions/calendar (chegadas, janelas) |
| `(state.startYear ?? 2026)` | `state.startYear` (sempre presente; migração preenche) | budget 38, diplomacy 39, crew 634, narrative 334, risk 466 |
| `Math.floor(turn / 52)` para ano | `turnToDate(...).year` | diplomacy, crew, narrative |
| `expiresTurn: turn + 4` em decisões | `expiresTurn: turn + ctx.weeksFor(turns)` (mínimo 1 passo) | pushDecision em todos |
| janela com `openWeeks < dt` | aberta durante o tick que a contém | calendar.js 276, missions.js 284 |

- **Com dt = 1 todos os caminhos novos se reduzem exatamente aos atuais** — é isso que o teste golden prova.

---

## 3. Cenários e campanha

### 3.1 Arquivo de cenário

`data/scenarios/<id>.json` (o atual `data/scenario.json` vira `data/scenarios/lunar_race.json`; o caminho antigo
fica como **alias** lido pelo pacote legado até a fase D):

```jsonc
{ "id": "campaign", "kind": "campaign",            // 'campaign' | 'scenario'
  "name": "Campanha", "subtitle": "1950 a 3000",
  "start": {"year": 1950, "month": 1}, "end": {"year": 3000, "month": 1},
  "turnWeeks": null,                               // null = o da era; lunar_race usa 1
  "packs": ["core", "e1", "e2", "e3", "e4", "e5", "e6", "e7", "gen"],   // ordem de mescla
  "snapshot": "e1",                                // de qual pacote vêm as condições iniciais
  "playable": {"actors": ["nasa", "roscosmos"], "found": true},          // found = pode fundar agência
  "outcomeMode": "historical",                     // fato de rivais segue o resultado real
  "ending": "eco",                                 // fim em jan/3000 pelo módulo eco
  "victory": { ... }, "historicalFirsts": { ... }  // só cenários que começam no meio da história
}
```

Cenários previstos (fase C, um por era, 1–2 h cada): *A Corrida Espacial* 1957–1969, *Estações* 1981–1998,
*Nova Economia Espacial* 2008–2020, **Corrida Lunar 2026–2030 (existente)**, *Cinturão* 2090–2110,
*Primeira Estrela* 2380–2420, *O Grande Silêncio* 2950–3000. Um cenário que começa no meio da história usa o
`snapshot` da era (orçamentos, relações, frotas, `historicalFirsts`) — exatamente como `actors.json` faz hoje
para 2026.

### 3.2 Campanha vs cenário no motor

- `createState` lê `scenario.start/end` (com fallback para `startYear/endYear` do formato atual) e grava
  `state.scenarioId`, `state.startYear`, `state.endTurn`, `state.eraId`, `state.step`.
- A campanha só usa o snapshot da era 1. As eras seguintes **não** re-snapshot: aplicam **deltas** (novos atores
  pelo ciclo de vida, novos veículos pela data, novos ramos da tech tree, calendário da era) e **âncoras suaves**
  (§3.3). Assim a história do jogador persiste através das eras.

### 3.3 Fidelidade histórica vs divergência

`outcomeMode: 'historical'` (padrão de eras 1–3): um item de calendário `fato` de **rival** sai na data real com o
`historicalOutcome` real (o campo já existe em `calendar.json`). Diverge apenas quando uma causa simulada
interfere (guerra no nível 4 entre as partes, ator dissolvido, jogador tomou o recurso exclusivo). Itens `fato`
**do jogador** viram missões de investidor (§6): se o jogador falhar, a história diverge dali em diante — é o
ponto do jogo. Âncoras suaves: orçamentos de atores `fato` puxam 10%/ano em direção à série real
(`budgetSeries` no pacote), para o mundo não derivar demais em 75 anos de história real.

### 3.4 Transições de era

Novo `src/core/era.js` (chamado pelo motor no começo do tick):

1. Se o tick cruza `era.start` da próxima era: **exige o pacote carregado** (`data.packsLoaded`). Se não estiver
   (navegador ainda baixando), o motor devolve `stoppedBy: 'loading'` e não avança — o sim nunca roda com dado
   parcial, o que mantém o determinismo.
2. `onEraEnd(state, data, ctx, era)` em cada módulo que exporta: troféu da Tabela da Era, crônica.
3. **Compactação**: notícias, log, ledger e álbum da era viram `state.chronicle[eraId]` (resumo ≤ 20 KB:
   manchetes top-30, marcos, mortos, campeão). Isso mantém o save limitado em 1050 anos (§12).
4. `state.eraId = next`; `onEraStart(...)` (tech tree destrava o nível, calendário instancia o da era, geradores
   rodam o lote da era, tema da UI troca).
5. Decisão `era/transition` bloqueante com a "cena de reflexão" do GDD (resumo, quem sobrou do time original).

O marco de fechamento de cada era é narrativo (prestígio, cena), **não** trava a passagem: a era é pela data.

---

## 4. Pipeline de dados

### 4.1 Layout

```
data/
  packs.json                  manifesto: pacotes, arquivos, ordem, era, tamanho estimado
  core/                       vocabulário e regras era-agnósticas (dono: steward de vocabulário)
    eras.json                 7 eras: id, anos, turnWeeks, tema, camada padrão, marco de fechamento
    vocab.json                ids globais: destinos, marcos (firsts), tipos de missão, kinds de nave, ramos, papéis
    truth-layers.json         camadas, faixas de ano válidas, comportamento no sim
    parts.json                (fase B) peças do construtor de foguetes
    investors.json            (fase B) arquétipos de investidor e modelos de contrato
    emblems.json              (fase B) gramática de logos (formas, campos, cargas, paletas)
    eco.json                  (fase C) fragmentos do Eco e os 3 desfechos
  eras/
    e1-corrida/               1950–1975
      era.json                metadados do pacote (id, janela de datas, depende de)
      snapshot.json           condições iniciais se um cenário começar nesta era (orçamentos, relações, blocos)
      lifecycle.json          nascimentos/renomeações/fusões/dissoluções de atores e nações nesta janela
      actors.json             definições de linhagem (identidades por data) dos atores que nascem aqui
      vehicles.json  spacecraft.json  destinations.json  calendar.json  tech.json
      events.json  politics.json  geopolitics.json  crew.json  bodies.json  news.json
      investors.json          (fase B) investidores reais/típicos da era
      patches.json            alterações em entidades de eras anteriores (ex.: Soyuz ganha nova versão)
    e2-estacoes/ … e7-galactica/
  gen/                        gramáticas dos geradores (especulação)
    agencies.json  vehicles.json  destinations.json  programs.json  events.json  names-ptbr.json
  scenarios/  lunar_race.json  campaign.json  …
  world.json                  contornos (lazy, como hoje)   world-eras.json  agrupamentos históricos de países
  vehicle-art.json            arte dos foguetes (só UI)
  *.json (atuais)             fase A: continuam aqui, referenciados pelo pacote legacy-e4-lunar
```

### 4.2 Manifesto e mescla

```jsonc
// data/packs.json
{ "version": 1,
  "packs": [
    {"id": "core", "files": {"eras": "core/eras.json", "vocab": "core/vocab.json"}},
    {"id": "legacy-e4-lunar", "era": "e4", "files": {"scenario": "scenario.json", "actors": "actors.json",
       "vehicles": "vehicles.json", "...": "..."}},          // fase A: os arquivos de hoje, sem mover
    {"id": "e1", "era": "e1", "dir": "eras/e1-corrida/", "files": ["actors", "vehicles", "..."]},
    {"id": "gen", "files": {"genAgencies": "gen/agencies.json", "...": "..."}}
  ] }
```

Regras de mescla (`src/core/packs.js`, ~200 linhas, puro):

- Cada arquivo de pacote tem a **mesma forma** do arquivo legado correspondente (`{vehicles: [...]}` etc.);
  listas com `id` são mescladas por `id` na ordem dos pacotes; objetos de configuração (`crewCertRules`,
  `budgetModel`…) são mesclados profundamente (pacote posterior sobrescreve chave a chave).
- Operações explícitas por item: `"$op": "patch"` (padrão quando o id já existe só em `patches.json`),
  `"replace"`, `"remove"`. Um id repetido **fora** de `patches.json` é erro de validação — evita que duas eras
  redefinam o mesmo foguete sem querer.
- Saída: o objeto `data` com o formato de hoje + `data.index` (como `buildIndex`) + `data.eras`,
  `data.packsLoaded`, `data.vocab`. **Nenhum módulo de sim muda por causa da mescla.**
- `loadData(readJson, {scenario = 'lunar_race'})`: sem argumento carrega a Corrida Lunar como hoje — **os 327
  testes que chamam `loadDataNode(root)` continuam iguais.**

### 4.3 Carregamento preguiçoso

- No navegador, carrega `core` + pacotes até a era do turno atual + `gen`; o pacote da próxima era é pré-buscado
  quando a campanha passa de 90% da era atual (e já está no cache do service worker). Em Node carrega tudo.
- Determinismo: o sim só vê pacotes com `era ≤ state.eraId` (o `data` é filtrado por `activeEras`); pré-busca não
  muda resultado. Validador garante que nenhuma entidade de `eN` tenha data efetiva anterior a `eN.start` (exceto
  `patches.json`, que só pode mexer em entidades anteriores).
- Save grava `state.packs = [{id, hash}]`; ao carregar, se o hash do conteúdo de um pacote **já usado** mudou,
  o jogo carrega mesmo assim (conteúdo corrigido é bem-vindo) mas registra em `state.log`; o golden test usa hash
  fixo.

### 4.4 Sobreposição (overlay) de entidades geradas e criadas pelo jogador

`src/core/overlay.js`: `gameData(state, baseData)` devolve um `data` derivado onde `index.actors/vehicles/
spacecraft/destinations/events` e as listas correspondentes incluem `state.gen.*` e `state.designs` (foguetes do
jogador). Implementação: `Object.create(baseIndex.vehicles)` + atribuição dos gerados, memorizado por
`state.gen.rev`. O motor passa esse `data` como `data`/`ctx.data` aos módulos; o store da UI também. Assim:

- `vehicleDef(data, id)`, `spacecraftDef(data, id)` e `data.index.*` funcionam para gerados sem mudar assinatura;
- o save carrega a definição (o gerado não existe em arquivo nenhum), então load é idêntico;
- o validador roda os mesmos esquemas sobre `state.gen` no smoke (gerador que produz lixo falha o teste).

### 4.5 Esquemas e validador

Sem dependências npm: `tools/validate/schema.js` implementa um subconjunto de JSON Schema (type, required, enum,
min/max, pattern, items, properties, `$ref` local) em ~150 linhas, e `tools/validate/rules.js` as regras que
esquema não expressa. Esquemas em `data/core/schemas/*.schema.json` (um por tipo: actor, lineage, lifecycleEvent,
vehicle, spacecraft, part, destination, calendarItem, techNode, event, investor, emblem, scenario, era).

Regras (cada uma com mensagem pt-BR e caminho `arquivo#id.campo`):

| Grupo | Regra |
|---|---|
| Ids | únicos globalmente por tipo; padrão `^[a-z0-9_]+$`; ids novos de vocabulário só em `core/vocab.json` |
| Referências | `operator`, `owner`, `partners`, `vehicleId`, `spacecraftId`, `destination`, `milestone`, `requires`, `prerequisites`, `into` resolvem — considerando o ciclo de vida (não referenciar ator antes de nascer ou depois de dissolvido, salvo `successor`) |
| Datas | toda data dentro da janela da era do pacote; `availableUntil ≥ availableFrom`; meses 1–12 (`monthBase` 1, como hoje) |
| Veracidade | `fato` ⇒ data ≤ 2025 e `source` obrigatório; `plano_oficial` ⇒ 2026–2035 e `source`; `projecao` ⇒ 2026–2050 e `chance`+`window`; `especulacao` ⇒ ≥ 2031 (gerado ou escrito) |
| Texto | pt-BR: campos `name/description/text/headline` sem palavras inglesas frequentes (lista curta), tamanho máximo por campo, placeholders `{person}`, `{rival}`… só os conhecidos por `narrative.js`, sem emoji em texto (flag é campo próprio) |
| Densidade | por ano da era: ≥ N eventos elegíveis, ≥ M itens de calendário, ≥ 1 veículo disponível por classe de capacidade por bloco; tech tree sem nó órfão; todo marco do vocabulário alcançável por algum destino |
| Física | `capacity` monotônica (`leo ≥ gto ≥ tli ≥ mars ≥ outer`); `design` do veículo reproduz `capacity` ±5% (fase B) |
| Ciclo de vida | sem ciclos de fusão; toda identidade cobre um intervalo contínuo; ator jogável do cenário existe na data inicial |

Saída: `node tools/validate.mjs [--pack e2] [--json]` → lista de erros/avisos e um resumo de cobertura por ano
(gráfico ASCII de densidade, útil para o autor ver o "buraco" de 1983).

### 4.6 Camadas de veracidade no sim

| Camada | Anos típicos | Comportamento | Campos |
|---|---|---|---|
| `fato` | ≤ 2025 | Ancorado: data e resultado reais para rivais (`outcomeMode`), slip 0 | `historicalOutcome`, `source` |
| `plano_oficial` | 2026–~2035 | Atraso sorteado pelo histórico (modelo atual do `calendar.js`) | `delay`, `source`, `statusNov2026` |
| `projecao` | ~2036–2050 | Acontece com `chance`, data sorteada em `window`, pode ser substituído por rival | `chance`, `window: {from, to}`, `requires` |
| `especulacao` | ≥ 2031 | Produzido por gerador a partir de gramática e estado do mundo | gerado, `genSeed` |

A UI mostra a camada como selo (já existe o conceito); a crônica marca "aqui a história real acaba" em 2025.

### 4.7 Geradores procedurais (`src/gen/`, puros, só `rngFor`)

| Gerador | Entrada | Saída (mesmo esquema do dado manual) | Quando roda |
|---|---|---|---|
| `agencies.js` | arquétipos (`data/gen/agencies.json`: potência emergente, megacorporação, consórcio de mineração, governo colonial, ordem/fundação, cooperativa de arca), economia/tensão/colônias do estado, gramática de nomes pt-BR | linhagem + identidade + logo (§7) + IA + finanças | taxa de risco (hazard) por tick ≥ 2031, e lote no início de cada era |
| `vehicles.js` | peças disponíveis pela tech (`parts.json`), famílias, operador | veículo com `design` → capacidade calculada | quando um ator destrava uma combinação nova (era ≥ 5) e pelo "programa" da IA |
| `destinations.js` | estrelas reais próximas (fato: α Cen, Barnard, Wolf 359, Lalande 21185, Sirius, ε Eri, τ Ceti…) + planetas gerados | destino + corpo + marcos de chegada | início das eras 6–7 (setor e galáxia do mapa) |
| `programs.js` | metas dos atores, `projecao` | itens de calendário dos rivais | anual |
| `events.js` | modelos de evento com lacunas (`{colony}`, `{body}`) | evento concreto | quando o narrativo pede e o pool manual da era é fraco |

Determinismo: semente `rngFor(seed, 'gen', kind, eraId, k)`; geração só dentro do tick (nunca no load); cada
gerado leva `genSeed` para reprodução em teste (`tools/gen-preview.mjs --kind agencies --era e5 --n 20` imprime
amostras para o autor revisar o "tom").

### 4.8 Trabalho paralelo por era na fase C

- **Congelamento do vocabulário no início da fase C** (passo C0, um dono): todos os ids de destino, marco, tipo de
  missão, kind de nave, ramo/nível de tech e família de peça das 7 eras entram em `core/vocab.json`. Depois disso
  cada era só **usa** ids; precisar de um novo vira pedido ao steward (arquivo `eras/eN/vocab-requests.json`,
  que o validador lista como aviso).
- **Entidades que atravessam eras pertencem à era do primeiro uso** (Soyuz em e1; em e2/e3 só `patches.json`).
- **Cada era tem seu teste** (`tests/pack-eN.test.mjs`: validador + `tools/smoke-campaign.mjs --from eN --to eN`)
  e seu tema CSS (`src/ui/css/era-N.css`). Um autor nunca precisa rodar a campanha inteira para trabalhar.
- **Fronteiras entre eras**: o snapshot de `eN` deve ser consistente com o fim de `eN−1`; o validador compara
  atores vivos/orçamentos do snapshot de `eN` com a lista de ciclo de vida até `eN.start` (aviso, não erro).

---

## 5. Ciclo de vida dos atores

### 5.1 Modelo

**Linhagem** = id estável do ator no estado (relações, crew, prestígio continuam). **Identidade** = nome,
sigla, bandeira, país, cor, logo, `kind` num intervalo de datas. Renomear é trocar identidade; fundir e cindir
criam/encerram linhagens.

```jsonc
// eras/e1-corrida/actors.json
{ "lineages": [
  { "id": "nasa", "kind": "agency", "playable": true,
    "identities": [
      {"from": {"year": 1950, "month": 1}, "name": "NACA (EUA)", "short": "NACA", "country": "EUA", "flag": "🇺🇸"},
      {"from": {"year": 1958, "month": 10}, "name": "NASA (EUA)", "short": "NASA"} ],
    "ai": {...}, "finance": {"budgetSeries": [[1959, 145], [1966, 5900], ...]} } ] }

// eras/e1-corrida/lifecycle.json
{ "events": [
  {"id": "naca_to_nasa", "date": {"year": 1958, "month": 10}, "kind": "rename", "actor": "nasa", "truthLayer": "fato", "source": "..."},
  {"id": "abma_into_nasa", "date": {"year": 1960, "month": 7}, "kind": "merge", "from": ["abma"], "into": "nasa",
   "inherit": {"crew": "transfer", "cash": "sum", "prestige": "sum", "relations": "max"}},
  {"id": "esa_born", "date": {"year": 1975, "month": 5}, "kind": "merge", "from": ["esro", "eldo"], "into": "esa", "newLineage": true} ] }
```

Tipos: `birth`, `rename`, `merge` (vários → um, com regra de herança), `split`, `dissolve` (`successor?`),
`nationalize`/`privatize` (troca `kind`). Nações usam o mesmo motor (`kind: 'nation'`: URSS → Rússia +
Ucrânia + Cazaquistão… em dez/1991, com o Baikonur passando a sítio arrendado).

### 5.2 Datas reais 1950–2030 (lista para a fase C validar com fonte)

| Data | Evento | Linhagem |
|---|---|---|
| 1950 | Programa soviético (OKB-1 de Korolev, desde 1946) | `roscosmos` (identidade "Programa espacial soviético") |
| 1950 | NACA (desde 1915) | `nasa` |
| 1956-02 | ABMA (Exército dos EUA, von Braun) | `abma` → funde em `nasa` 1960-07 (Marshall) |
| 1956-10 | Quinta Academia (China) | `cnsa` (identidades: 7º Ministério de Máquinas 1965, Min. da Indústria Aeroespacial 1982, CNSA 1993-04) |
| 1958-10 | NACA → NASA | `nasa` rename |
| 1961-12 | CNES (França) | `cnes` |
| 1962-02 | INCOSPAR (Índia) | `isro` (rename para ISRO 1969-08) |
| 1964 | ESRO e ELDO | `esro`, `eldo` → ESA 1975-05 (fusão, nova linhagem `esa`) |
| 1964 | ISAS (Univ. de Tóquio; nacional em 1981) | `isas` → JAXA 2003-10 |
| 1969-10 | NASDA (Japão) | `nasda` → JAXA 2003-10 (com ISAS e NAL) |
| 1980-03 | Arianespace | `arianespace` (empresa, operadora do Ariane) |
| 1982 | Orbital Sciences | `orbital` → Orbital ATK 2015 → Northrop Grumman 2018 (renames) |
| 1983 | ISA (Israel) | opcional, não jogável |
| 1989 | CSA (Canadá); KARI (Coreia do Sul) | `csa`, `kari` (KARI → KASA 2024-05) |
| 1991-12 | Fim da URSS | nação; `roscosmos` vira "Agência Espacial Russa" 1992-02, Roscosmos 2004/2015 |
| 1992-02 | Agência Espacial Russa | `roscosmos` rename |
| 1992 | CMSA / Projeto 921 (China) | sub-identidade de `cnsa` (programa tripulado) |
| 1993-04 | CNSA | `cnsa` rename |
| 1994-02 | AEB (Brasil; COBAE desde 1971) | `aeb` (jogável "emergente" do GDD) |
| 2000-09 | Blue Origin | `blueorigin` |
| 2002-03 | SpaceX | `spacex` |
| 2003-10 | JAXA | fusão `isas` + `nasda` (+ NAL) → `jaxa` |
| 2006 | Rocket Lab; ULA (dez/2006, Boeing + Lockheed) | `rocketlab`, `ula` |
| 2014 | Agência Espacial dos Emirados (MBRSC desde 2006) | `uaesa` (jogável "emergente") |
| 2015–2018 | LandSpace, iSpace (China), Firefly, Relativity, Isar, Skyroot | empresas não jogáveis ou jogáveis na era 3 |
| 2016 / 2021 | Axiom / Vast; Sierra Space (2021) | empresas de estação |
| 2023 | Agência Espacial Africana (AfSA, sede no Cairo) | `afsa` |
| 2026–2030 | itens `plano_oficial` (ex.: estações comerciais substituindo a ISS) | do pacote e4 |

Todas as linhas `fato` entram com `source` e são checadas pelo validador; datas marcadas aqui são do
conhecimento do arquiteto e **devem ser confirmadas** pelo construtor da era.

### 5.3 Nascimentos especulativos (≥ 2031)

`src/sim/lifecycle.js` roda uma taxa de risco por tick: `λ = base_era × f(economia mundial, tensão, nº de
colônias, nº de atores vivos)`, com piso de **6** e teto de **24** atores vivos (perf §12 e legibilidade da
Tabela da Era). Mortes: caixa negativo por 3 anos, apoio < 10, ou aquisição aceita na diplomacia (nova proposta
`acquire`). Colônias no estágio 5–6 do GDD geram governos coloniais como atores. A Ordem/Colégio Silêncio do
mistério do Eco nasce por marco narrativo, não por sorteio.

### 5.4 Ganchos nos módulos

O motor emite `onActorBorn(state, data, id, ctx)` e `onActorRetired(state, data, id, {into}, ctx)` em ordem de
`MODULES`. Cada módulo que tem slice por ator (politics, diplomacy, budget `finance.rivals`, research `rivals`,
crew `rivalCrew`, calendar) cria/funde/limpa o seu. Ator aposentado continua em `state.actors[id]` com
`status: 'retired'`, `retiredTurn`, `into` (para notícias antigas e memorial), mas `liveActors(state)` (novo
helper) o exclui — **todo `Object.keys(state.actors)` dos módulos (≈ 175 ocorrências) passa a `liveActors`**,
trabalho mecânico da fase A.

---

## 6. Agência do jogador, investidores e missões

### 6.1 Modos de jogador

`state.player = {actorId, mode: 'existing'|'founded', cap: CapTable|null}`. `state.playerId` continua igual.
Cenário legado (save antigo / Corrida Lunar com `cap: null`) mantém o fluxo atual — nenhum teste quebra.

### 6.2 Fundar agência (fase B)

Ação `'agency/found' {name, short, kind: 'agency'|'company', country, hqId|city{lat,lon}, emblem, startPackage}`,
só no turno 0 (newgame). `lifecycle.js` cria a linhagem com identidade do jogador, finanças iniciais pelo
`startPackage` do cenário (capital semente, 1 sítio de lançamento alugado, 4 pessoas), relações neutras com
todos, bloco pelo país (`geopolitics.blocMap`). HQ e país vêm de `geopolitics.foundingSites` (novo, por era:
lista de cidades com lat/lon e país) ou toque no mapa-múndi. O ator fundado tem as mesmas regras de qualquer
ator; não existe "ator especial" no sim.

### 6.3 Tabela de participação

```jsonc
CapTable = { holders: [{id, kind: 'player'|'government'|'investor', name, pct, since, contractId}],
             contracts: [{id, holderId, missions: [MissionDemand], perYear, penalty, until}],
             board: {confidence: 0..100}, nextRoundTurn }
```

- **Investidores somados ≤ 90%** (jogador ≥ 10%). **Jogador ≥ 50% = autonomia**: missões de investidor viram
  ofertas que ele pode recusar com custo pequeno de confiança. **< 50%**: são obrigatórias, com prazo; perder prazo
  custa confiança do conselho; confiança 0 = demissão (`gameOver: 'fired'`, que já existe).
- **Uma rodada por ano** (`ctx.crossed('year')`): decisão com 1–3 propostas (`data/core/investors.json` +
  `eras/eN/investors.json`: fundo soberano, telecom, defesa, mineração lunar, turismo, fundação científica…),
  cada uma `{pct, cashM, contrato}`; avaliação da agência = f(prestígio, reputação, frota, caixa).
- **Pressão de missões**: demanda anual do contrato = `perYear × pct/10`; o planejador limita as missões próprias
  do jogador a `slots × (playerPct/100)^0.7` por ano (com 10% sobra ~20% dos slots: "quase nenhum espaço").
- **Agência real (NASA, CNSA…)**: o governo é um holder (`kind: 'government'`) com `pct` do snapshot
  (ex.: 60% em 1958) e o **calendário de programa da era é o contrato desse holder**. É assim que "as missões
  da história viram missões de investidor": `calendar.json` não muda; o `missions.js` só troca a origem do
  briefing de `calendar` para `investor` com `holderId`. Agência fundada começa com 100% e sem calendário.

> Decisão para o usuário: a fatia inicial do governo nas agências nacionais (proposta: 60% NASA/URSS/CNSA,
> 40% ESA/JAXA/ISRO, 0% empresas). Isso define se o jogo começa com ou sem autonomia.

### 6.4 Escolha de veículo é do jogador (item 9)

Hoje `pickConfig` escolhe foguete/nave em quatro caminhos: `calendarDraft` (só completa o que falta),
`pushOpportunity` (oportunidades), `awardToPlayer` (contrato vencido) e o `briefing accept`. Mudança:

- Esses caminhos criam a missão em `planning` com `vehicleId: null`, `spacecraftId` só se o contrato exigir, e
  `suggestion: {vehicleId, spacecraftId, why}` (o `pickConfig` vira **sugestão**).
- `scheduleMission` recusa sem veículo ("Escolha o foguete antes de agendar."); a decisão de aceitar devolve
  `{openBuilder: missionId, step: 'veiculo'}` e a UI navega para `#missoes/montar/<id>/veiculo`, com a sugestão
  marcada "Sugerido" (não pré-selecionada).
- Missões de programa (`fato` com foguete histórico) também deixam escolher; o veículo real aparece como
  "Histórico". **Só a demo de certificação** trava o foguete (já é a regra hoje).
- Bot do smoke e IA: `missions/draftOptions` → escolhe o primeiro válido. Testes que assumem foguete preenchido
  no aceite são atualizados (e listados) na fase B.

---

## 7. Logos (itens 4 e 5)

Gramática declarativa em `data/core/emblems.json`, renderizada por `src/ui/emblem.js` (extraído de
`portrait.js/emblemSVG`): `{shape: 'roundel'|'shield'|'meatball'|'chevron'|'ring'|'star', field: {color,
pattern}, charges: [{kind: 'orbit'|'rocket'|'star'|'wing'|'globe'|'arrow'|'letters', color, x, y, s, r}],
text: {short, arc?}, palette}`. Agências reais recebem um `emblem` no dado **inspirado mas não copiado** (sem
reproduzir marca registrada: formas genéricas + sigla). Agências geradas sorteiam pela gramática do arquétipo;
a fundada é editada num editor de 4 passos (forma → campo → símbolo → texto) que só monta esse JSON. Cada
identidade tem seu `emblem`, então o logo muda com o rename. SVG puro, sem arquivos externos.

---

## 8. Construtor de foguetes (item 7)

### 8.1 Dados

```jsonc
// data/core/parts.json
{ "parts": [
  {"id": "merlin1d_stage1", "kind": "stage", "family": "falcon", "era": "e3", "truthLayer": "fato",
   "dryT": 25.6, "propT": 395, "isp": [282, 311], "thrustKN": 7607, "engines": {"id": "merlin1d", "n": 9},
   "d": 3.66, "len": 46.5, "reusable": true, "heritage": {"flights": 580, "failures": 2},
   "costM": 45, "techReq": ["prop_reuse_ops"], "art": {"from": "falcon9.s1"}} ,
  {"kind": "booster" ...}, {"kind": "upper" ...}, {"kind": "fairing" ...}, {"kind": "engine" ...} ] }
// vehicles.json (campo novo, fase B):  "design": {"stages": ["merlin1d_stage1", "merlin_vac_s2"], "boosters": [], "fairing": "f9_fairing", "calib": 0.97}
```

### 8.2 Regras (`src/sim/rocketry.js`, puro)

- Δv por classe (`leo` 9,4; `gto` 11,8; `tli` 12,4; `mars` 13,0; `outer` 14,5 km/s, em `core/vocab.json`);
  equação de Tsiolkovsky estágio a estágio → carga máxima por classe → `capacity`. `calib` por família ajusta
  perdas; **teste: todo `design` real reproduz o `capacity` do catálogo ±5%**.
- Confiabilidade estimada = média ponderada da herança das peças × penalidade de novidade (peças nunca voadas
  juntas). Custo = soma das peças × escala de cadência.
- **Comprar e editar**: licença do foguete existente (custo da operadora, exige confiança/embargo como o
  `access`/`embargo` atuais) → projeto do jogador com `baseVehicleId`. **Do zero**: qualquer peça destravada.
  Desenvolvimento = programa com custo e semanas ∝ novidade, voos de teste opcionais (reusa o modelo da
  certificação tripulada: `crewCert` se aplica ao projeto).
- Estado: `state.designs[id] = {id, name, operator, baseVehicleId, parts, emblem, paint, status:
  'draft'|'dev'|'testing'|'active'|'retired', program}` → entra no catálogo pela sobreposição (§4.4) como
  veículo normal. A IA da era ≥ 5 usa o mesmo construtor via gerador (§4.7).
- Arte: `launch-render/vehicles.js` ganha um adaptador `artForDesign(design, data)` que monta `parts/segs` a
  partir de dimensões das peças e reaproveita marcas/materiais do `art.from`.

---

## 9. Mapas (item 1, fase B)

- **Espacial**: os 3 níveis do GDD por pinça — sistema (o `map.js` atual), **setor** (estrelas próximas, fato
  + gerado, eras 6–7) e **galáxia** (nós de colonização, era 7). `bodies.json` ganha `level: 'sector'|'galaxy'`
  e o gerador de destinos preenche. Névoa de guerra por `state.reveal` (slice do módulo de mapa no sim: só ids).
- **Mapa-múndi**: `world-eras.json` define agrupamentos históricos sobre os contornos modernos (URSS = união de
  15 ISO3; Iugoslávia; Tchecoslováquia; Alemanhas mostradas juntas com rótulo — simplificação declarada, porque
  dividir a DEU exigiria outro arquivo de contornos). O agrupamento ativo vem do ciclo de vida das nações.
- Ambos lêem só `store.query`; o tamanho do `world.json` não cresce.

---

## 10. Módulos que mudam

| Arquivo | Mudança | Fase |
|---|---|---|
| `src/core/time.js` | eras, `stepWeeks`, `crossed`, rótulos por era, `weeksToText` com décadas/séculos | A |
| `src/core/engine.js` | `dt`, `state.step`, era via `era.js`, ganchos `onEraStart/End`, `onActorBorn/Retired`, `stoppedBy: 'loading'`, `time/advance {turns}`, `SAVE_VERSION = 2` | A |
| `src/core/era.js` (novo) | transição, compactação/crônica | A |
| `src/core/data.js` + `packs.js` (novo) + `overlay.js` (novo) | manifesto, mescla, carga preguiçosa, sobreposição | A |
| `src/core/migrate.js` (novo) | cadeia de migrações de save | A |
| `src/core/helpers.js` | `liveActors`, `actorIdentity(state, id, turn)`, `perWeek` | A |
| `src/sim/lifecycle.js` (novo) | ciclo de vida (dado + hazard), `agency/found` (B) | A/B |
| `src/sim/diplomacy.js` | relações/blocos para nascidos/fundidos; blocos por era (Ocidente/Intercosmos → Artemis/ILRS); proposta `acquire` | A/C |
| `src/sim/politics.js` | nações por era (lifecycle de nação), dt | A |
| `src/sim/calendar.js` | `outcomeMode`, `projecao` (chance/janela), dt, sem `2026`; ponto de entrada para programas gerados | A |
| `src/sim/budget.js` | dt, anos por `crossed`, holders/cap table (B) | A/B |
| `src/sim/research.js` | nós por era (`era` já existe), nível destravado na transição | A/C |
| `src/sim/crew.js` | envelhecimento e aposentadoria por década, gerações/legados (sobrenomes que voltam) | A/C |
| `src/sim/missions.js` | dt, `endTurn` genérico, escolha de veículo (B), origem `investor` (B) | A/B |
| `src/sim/narrative.js` | gatilhos por data absoluta (`fromYear/toYear`, `era`) além de `minTurn`; Eco (C) | A/C |
| `src/sim/risk.js`, `launch.js` | `startYear` sem default; marcos de subida por era (C: lançamento orbital de estação, propulsão de fusão…) | A/C |
| `src/sim/investors.js` (novo), `rocketry.js` (novo) | §6, §8 | B |
| `src/sim/colonies.js` (novo), `eco.js` (novo) | estágios de colonização do GDD; fragmentos e fim em jan/3000 | C |

Ordem nova de `MODULES`: `lifecycle → politics → diplomacy → calendar → budget → investors → research → crew →
missions → colonies → launch → narrative → eco`. Grafo de imports: `lifecycle ← helpers, rng`; `investors ←
helpers, budget`; `rocketry ← helpers` (puro, sem slice — `designs` pertence a `missions`/catálogo);
`colonies ← helpers, budget`; `eco ← helpers, narrative`.

Eventos narrativos: `minTurn` continua relativo ao início do cenário (Corrida Lunar); eventos das eras novas
usam `trigger.fromYear/toYear/era`. O validador proíbe `minTurn` em pacotes `e1–e3, e5–e7`.

---

## 11. Navegação da UI (item 8)

### 11.1 Registro de telas

```js
// src/ui/screens.js
registerScreen({ id: 'investidores', label: 'Investidores', icon: 'cap', group: 'agencia',
  tab: false, drawer: true, minEra: null, when: (state) => !!state.player?.cap,
  parent: null, load: () => import('./investors-view.js') });   // render(root, store, sub, nav) -> cleanup
```

- `app.js` deixa de ter `TABS/SCREEN_TITLES/VIEW_PARENT` fixos: lê do registro. Rotas `#id/sub` continuam
  (botão voltar do Android). Telas carregam por `import()` dinâmico — menos JS no boot.
- **Barra inferior**: 4 destinos + disco central (tempo): Painel · Missões · ⏵ · Mapa · Mundo. Configurável por
  `tab: true` (máx. 4) — a regra de "disco no centro" do DESIGN.md continua.
- **Gaveta hambúrguer** (botão à esquerda no topo, `.gaveta` entra pela esquerda, `.veu` escurece e fecha ao
  toque, arrastar horizontal fecha — o comportamento do `useGaveta` do CSmanager, portado para JS puro em
  `src/ui/drawer.js`), com grupos:
  - **Agência**: Painel, Equipe, Investidores, Identidade e logo, Finanças
  - **Operações**: Missões, Frota, Construtor de foguetes, Pesquisa
  - **Universo**: Mapa espacial, Colônias (era ≥ 5)
  - **Mundo**: Mapa-múndi, Notícias, Diplomacia, Tabela da Era, Crônica (eras passadas)
  - **Sistema**: Salvar/carregar (slots), Ajustes, Ajuda
- `docs/DESIGN.md` §7 ("Not ported: drawer") é atualizado pela fase A: a gaveta passa a ser portada.
- Tela inicial: **Campanha 1950–3000**, **Cenários** (lista do `data/scenarios`), **Continuar** (3 slots).

---

## 12. Save, migração e desempenho

### 12.1 Migração

- `SAVE_VERSION 1 → 2`. `src/core/migrate.js`: `migrations[1] = (s) => ({...s, version: 2, step: s.turn,
  eraId: 'e4', packs: [{id: 'legacy-e4-lunar'}], gen: {rev: 0}, chronicle: {}, player: {actorId: s.playerId,
  mode: 'existing', cap: null}, designs: {}})`. `deserialize` aplica a cadeia; versão desconhecida ou JSON
  inválido lança `SaveError` com mensagem pt-BR: **"Este save é de uma versão do Ad Astra que não dá para abrir.
  Você pode exportá-lo como arquivo ou começar uma nova campanha."** A tela inicial oferece "Exportar" e
  "Apagar".
- `SAVE_KEY` passa a `adastra.save.v2.slot<N>`; na primeira abertura o `adastra.save.v1` é migrado para o slot 1
  e mantido como backup até o próximo salvamento bem-sucedido.
- Teste: um save v1 real (fixture gravada hoje, turno 120 da Corrida Lunar) carrega, joga 20 turnos e grava.

### 12.2 Orçamentos de desempenho

| Medida | Orçamento | Hoje |
|---|---|---|
| Tick médio, Node desktop | ≤ 5 ms com 24 atores vivos | 2,9 ms com 8 |
| Tick médio, celular intermediário (`data-perf="lite"`) | ≤ 15 ms; turno de 1 ano ≤ 15 ms (é 1 tick) | — |
| Campanha headless 1950→3000, 1 semente, bot | ≤ 90 s | — |
| Atores vivos | 6–24 (relações ≤ 276 pares) | 8 |
| Save serializado | ≤ 800 KB em qualquer ponto (3 slots < 5 MB do localStorage) | 221 KB em 5 anos |
| Crônica por era | ≤ 20 KB | — |
| Boot: dados carregados | ≤ 1,2 MB não comprimidos (core + era atual + gen) | ~630 KB |
| Pacote de era | ≤ 700 KB (o `events.json` atual sozinho tem 211 KB: eventos são o maior custo) | — |
| Primeira tela no celular | ≤ 2,5 s com SW quente | — |

O crescimento do save é controlado por: caps existentes (news 200, ledger 300), compactação por era (§3.4),
instâncias de calendário resolvidas há > 2 anos viram contadores, `firsts` só guarda {actorId, turn},
memorial guarda só nomes (o legado precisa deles). O smoke de campanha **falha** se o save passar de 800 KB.

---

## 13. Estratégia de testes

1. **Golden da Corrida Lunar** (fase A, primeiro arquivo a ser escrito, antes de mexer no motor):
   `tests/golden-lunar.test.mjs` grava hoje o hash de `serialize(state)` nos turnos 26/52/260 para 3 sementes e
   uma sequência fixa de ações; depois da refatoração o hash tem de ser idêntico. Prova que dt=1 + pacotes +
   overlay não mudaram nada.
2. **Validador** em `tests/packs.test.mjs` (todos os pacotes) e `tests/pack-eN.test.mjs` (um por era, dono do
   construtor da era).
3. **Tempo**: `tests/time-era.test.mjs` — fronteiras de era, `crossed`, rótulos, alinhamento dos passos, último
   turno = jan/3000.
4. **Ciclo de vida**: rodar 1950→2031 headless e conferir que cada evento `fato` acontece no mês exato
   (NASA em 1958-10, ISRO em 1969-08, ESA em 1975-05, CNSA em 1993-04, JAXA em 2003-10, Blue Origin 2000-09,
   SpaceX 2002-03…) e que a herança da fusão soma prestígio/crew.
5. **Determinismo**: mesma semente + mesma sequência = mesmo hash, com save/load a cada 50 turnos, com e sem
   pré-busca de pacote, com overlay reconstruído do zero.
6. **Migração**: fixture v1 carrega; JSON quebrado e versão 99 dão a mensagem pt-BR.
7. **Smoke de campanha** `tools/smoke-campaign.mjs [seeds] [--from e1] [--to e7] [--actor nasa|found]`:
   bot joga, resolve decisões, escolhe veículo, assina investidores; invariantes por era (nada `NaN`, caixa
   finito, 6 ≤ atores vivos ≤ 24, save ≤ 800 KB, 6 transições de era, fim em jan/3000 com exatamente um dos
   3 desfechos, tempo total ≤ 90 s). Versão curta (1950→1962, ~620 ticks, < 5 s) roda dentro de `node --test`;
   a completa roda como `npm run smoke:campaign`.
8. **Geradores**: amostras de 200 entidades por era passam no esquema; distribuição de nomes sem repetição
   exagerada; `gen-preview` para revisão humana do tom.
9. **Física do construtor**: todo `design` real dentro de ±5%; peças trocadas mudam capacidade no sentido certo.
10. **UI**: testes estáticos do registro de telas (toda tela registrada tem `load` que exporta `render`), da
    gaveta (abre/fecha/véu) e do fluxo de aceite → Montador no passo do veículo.

Testes atuais: ~23 arquivos citam 2026/260/`startYear`; com o pacote legado e o default `lunar_race` eles
seguem válidos. Só são alterados os que testam aceite com foguete preenchido (fase B) — lista no relatório da
fase B.

---

## 14. Fases e divisão de arquivos para construtores paralelos

Regra geral: cada arquivo tem **um dono por fase**; um construtor que precisa de mudança num arquivo alheio
escreve o pedido no relatório (ou usa o gancho previsto). Ninguém faz `git commit`.

### Fase A — fundação (6 construtores)

| Construtor | Arquivos (dono exclusivo) | Entrega |
|---|---|---|
| **A1 Tempo e motor** | `src/core/time.js`, `engine.js`, `era.js`*, `migrate.js`*, `helpers.js`; `tests/time-era`*, `tests/migrate`*, `tests/golden-lunar`* (escreve o golden **primeiro**) | dt, step, eras, ganchos, SAVE v2 |
| **A2 Pipeline de dados** | `src/core/data.js`, `packs.js`*, `overlay.js`*; `data/packs.json`*, `data/core/**`*, `data/scenarios/**`*; `tools/validate.mjs`*, `tools/validate/**`*, `tools/gen-preview.mjs`*; `tests/packs.test.mjs`* | manifesto com pacote legado, mescla, validador e esquemas |
| **A3 Ciclo de vida e diplomacia** | `src/sim/lifecycle.js`*, `src/sim/diplomacy.js`, `data/eras/e1-corrida/{actors,lifecycle,snapshot}.json`* (esqueleto com a lista §5.2), `tests/lifecycle.test.mjs`* | nascimento/rename/fusão/dissolução por dado; `liveActors` em diplomacy |
| **A4a Sim era-agnóstico: operações** | `src/sim/calendar.js`, `missions.js`, `launch.js`, `risk.js`, `src/core/outcome.js`; `tools/audit-dt.mjs`* | dt/crossed/perWeek, `outcomeMode`, `projecao`, `liveActors` |
| **A4b Sim era-agnóstico: mundo e agência** | `src/sim/budget.js`, `politics.js`, `crew.js`, `research.js`, `narrative.js` | idem; gatilhos por ano em narrative; envelhecimento em crew |
| **A5 Casca de UI** | `src/ui/app.js`, `screens.js`*, `drawer.js`*, `store.js`, `newgame.js`, `components.js`, `styles.css`, `sw.js`, `index.html`, `docs/DESIGN.md`; `tests/ui-*` | registro de telas, gaveta + véu, barra configurável, seletor de cenário/campanha, slots, mensagem de save incompatível |
| **A6 Ferramentas de teste** | `tools/smoke.mjs`, `tools/smoke-campaign.mjs`*, `tests/determinism.test.mjs`*, `tests/campaign-short.test.mjs`* | smoke com `--scenario`; campanha 1950→1962 com conteúdo esqueleto |

(* = arquivo novo.) Dependências: A1 e A2 começam juntos; A3/A4a/A4b começam quando a assinatura de `ctx`
(dt, crossed, perWeek, liveActors) estiver publicada por A1 (primeira hora) — a mudança é mecânica. A5 só
depende do registro. A6 integra no fim. **Critério de pronto da fase A**: golden idêntico; 327+ testes
passando; validador limpo; campanha esqueleto (era 1 com ~10 atores/veículos/itens reais e eras 2–7 vazias mas
válidas, geradores-stub) roda 1950→3000 headless sem erro e dentro do orçamento.

### Fase B — jogador e ferramentas (5 construtores)

| Construtor | Arquivos |
|---|---|
| **B1 Fundação de agência + logos** | `src/ui/found-agency.js`*, `src/ui/emblem.js`*, `src/ui/portrait.js`, `data/core/emblems.json`*, ação `agency/found` em `lifecycle.js` (dono passa de A3 para B1) |
| **B2 Investidores** | `src/sim/investors.js`*, `data/core/investors.json`*, `src/ui/investors-view.js`*, `src/sim/budget.js` (só holders) |
| **B3 Construtor de foguetes** | `src/sim/rocketry.js`*, `data/core/parts.json`*, campo `design` em `data/vehicles.json`, `src/ui/builder-view.js`*, `src/ui/launch-render/vehicles.js` |
| **B4 Missões: escolha de veículo e origem investidor** | `src/sim/missions.js`, `src/ui/missions-tab.js`, `tools/smoke*.mjs` (bot) — expõe `createInvestorMission(state, data, demand)` para B2 |
| **B5 Mapas** | `src/ui/map.js`, `map.css`, `worldmap.js`, `worldmap.css`, `data/bodies.json`, `data/world-eras.json`*, `data/core/stars.json`* |

### Fase C — conteúdo das 7 eras + fim (10 construtores)

- **C0 Steward de vocabulário** (curto, primeiro): `data/core/vocab.json`, `truth-layers.json`, `eras.json`;
  congela ids.
- **C1…C7 uma era cada**: dono exclusivo de `data/eras/eN-*/**`, `tests/pack-eN.test.mjs`, `src/ui/css/era-N.css`.
  C4 também migra o conteúdo do pacote legado para `eras/e4-lunar/` (o legado vira alias até a fase D).
- **C8 Geradores**: `src/gen/**`, `data/gen/**`.
- **C9 Eco e o fim**: `src/sim/eco.js`, `data/core/eco.json`, `src/ui/ending.js` (cena de jan/3000 com
  Contato/Silêncio/Herança, ligada aos fragmentos coletados).
- **C10 Colônias**: `src/sim/colonies.js`, `src/ui/colonies-view.js`, `data/core/colonies.json`.

Cada era entrega: atores e ciclo de vida, veículos/naves com `design`, destinos, calendário (camada certa),
nós de tech do nível, ≥ 120 eventos com gatilho por ano, notícias/manchetes no tom da era, investidores,
elenco inicial, snapshot e um cenário de 1–2 h. Sempre com `node tools/validate.mjs --pack eN` limpo.

### Fase D — equilíbrio, revisão, publicação

- `tools/sim-era.mjs --era eN --seeds 20` (por era, paralelizável: um construtor por par de eras) mede
  vitórias, mortes, caixa, densidade de eventos por turno (alvo 1 a cada 2–4), tempo médio por era.
- Revisão de texto pt-BR por era; auditoria de fontes `fato`.
- Remoção do alias legado; precache do SW por era; versão 1.0.

---

## 15. Riscos e decisões em aberto

| Risco | Mitigação |
|---|---|
| Refatoração dt muda a Corrida Lunar sem ninguém perceber | Golden escrito antes de tudo; dt=1 reduz exatamente ao código atual |
| 1050 anos de conteúdo escrito à mão é impossível | Eras 5–7 são ~70% geradas; autor escreve gramática, âncoras e eventos-chave (Eco) |
| Save cresce sem limite | Compactação por era + orçamento testado no smoke |
| Pacotes editados em paralelo colidem | Dono por pasta, vocabulário congelado, `patches.json`, ids duplicados = erro |
| História real "trava" o jogador | Só itens de rivais ficam ancorados; os do jogador divergem por falha/sucesso |
| Marcas reais nos logos | Gramática genérica + sigla, nada copiado |

Decisões para o usuário: (1) os passos por era da tabela §2.2; (2) a fatia inicial do governo nas agências
nacionais (§6.3); (3) quais atores são jogáveis em 1950 (proposta: EUA/NASA e URSS; Europa/Japão/Índia/China
entram como jogáveis quando nascem, em cenários; fundar agência disponível sempre).
