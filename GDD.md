# Ad Astra — Game Design Document (título provisório)

Nov 17, 2026 · @João Vitor

## O que mudou na v2

Quatro decisões novas, aplicadas ao documento inteiro:

- **Naves prontas.** Não há construção de veículos. O jogador escolhe no catálogo (Falcon 9, SLS, Long March, New Glenn e outros) e monta missões, não foguetes.
- **História real até 2050.** O passado é fiel e o futuro próximo segue os planos oficiais de hoje. De 2051 a 3000 é especulação.
- **Política e guerras simuladas.** O mundo tem tensões, sanções e conflitos que o jogador sofre, mas não controla.
- **Vários rivais com diplomacia.** Os atores cooperam, competem, assinam tratados e rompem, como NASA, SpaceX e Blue Origin de um lado e as agências chinesa e indiana de outro.

## Visão e pitch

**Você dirige uma agência espacial do primeiro Sputnik ao ano 3000, e no dia do lançamento tudo o que decidiu vira torcida.**

Ad Astra é um manager 2D para celular. Entre os lançamentos você cuida de orçamento, engenheiros, pesquisa e rotas. No dia do lançamento você assiste ao resultado em tempo real, com poucas intervenções que podem salvar a missão ou perdê-la. Sessões de 3 a 5 minutos, campanha de dezenas de horas, 1950 a 3000.

Pitch em uma frase: *Football Manager com a lógica de engenharia do KSP e a narrativa e o feedback visual de Stellaris.*

| Referência | O que pegamos | O que deixamos de fora |
| --- | --- | --- |
| Football Manager | Dashboards, elenco com personalidade, rivais, o "dia de jogo" como pico emocional | Estatística infinita e menus em profusão |
| Kerbal Space Program | Causa e efeito físico (custo de energia por rota, janelas de lançamento), a falha que ensina | Pilotagem manual e construção de naves (as naves são prontas) |
| Stellaris | Eventos em cadeia, anomalias, facções, mapa vivo, feedback visual do império | 4X pesado, guerra de frotas, microgestão de planetas |

## Pilares de design

Cinco regras que decidem qualquer discussão de design.

1. **Torcer, não pilotar.** Você decide antes. Durante o lançamento só faz 1 a 3 intervenções curtas, e o resto é suspense.
2. **Toda falha tem explicação.** O relatório pós-missão mostra a cadeia de causas, como no KSP. A derrota ensina e dá vontade de tentar de novo.
3. **A sorte vira história.** A aleatoriedade é ponderada pelas suas escolhas. Cada evento tem texto, rosto e consequência, nunca só um número.
4. **O universo reage.** Rivais, política, mídia e descobertas persistem. Seu legado fica registrado no mundo.
5. **Mobile de verdade.** Uma mão, 3 a 5 minutos, retrato, sem timers punitivos. Pausar e fechar o app nunca prejudica o jogador.

## Loop de jogo

Três loops encaixados, cada um com sua emoção: a sessão rápida dá tensão e alívio, a missão dá orgulho ou luto, e a era dá a sensação de construir um legado.

| Camada | Duração | O que o jogador faz | Emoção |
| --- | --- | --- | --- |
| Micro | 3 a 5 min | Um dia de lançamento ou uma decisão de evento | Tensão e alívio |
| Meso | 1 a 3 sessões | Uma campanha de missão: planejar, escolher o veículo, lançar, operar, colher o resultado | Orgulho ou luto |
| Macro | Uma era (muitas horas) | Metas de longo prazo, orçamento político, corrida contra rivais | Legado |

**Loop principal (a missão):**

1. **Briefing.** Chega uma oportunidade: contrato, janela planetária, pressão política ou jogada de rival.
2. **Planejar.** Você escolhe alvo, perfil de missão, equipe e margem de risco.
3. **Escolher o veículo.** Pega um veículo pronto do catálogo e define a configuração da missão (carga, tripulação, margem).
4. **Dia de Lançamento.** A sequência de torcida, descrita na próxima seção.
5. **Operações.** Trânsito, inserção, pouso e experimentos, com eventos aleatórios pelo caminho.
6. **Relatório.** Resultado, causas, reação da mídia e dos rivais.
7. **Impacto.** Reputação, verba, pesquisa e lore mudam, e o briefing seguinte já nasce disso.

O tempo passa em turnos que mudam com a era: semanas nos anos 50, anos no século 30. Entre missões o jogo avança sozinho e mostra um noticiário do mundo com o que os rivais fizeram.

## O Dia de Lançamento

O dia de lançamento é o "dia de jogo" do manager: dura 2 a 4 minutos, é o momento mais animado do jogo e entrega a sensação de torcer pelo seu time. A escalada de tensão é desenhada em seis atos.

1. **Pré-lançamento (a escalação).** Você escolhe diretor de voo, comandante, estratégia (conservadora, equilibrada, agressiva) e margem de combustível. O jogo mostra a **chance estimada** como uma faixa, por exemplo 62 a 78%, porque seus engenheiros nunca têm certeza. Quanto melhor a equipe e a pesquisa, mais estreita a faixa.
2. **Contagem.** Sala de controle em 2D: rostos da equipe, telemetria, clima, uma barra de **nervosismo** e a multidão do lado de fora. Se o clima ou um sensor falhar, você decide entre segurar, adiar ou lançar assim mesmo.
3. **Ascensão.** Foguete subindo em vista lateral, com câmera que acompanha. Cada marco (Max-Q, separação de estágio, órbita) funciona como um "gol": o jogo rola o dado ali, com rádio narrando em frases curtas e a barra de confiança oscilando.
4. **Intervenções.** Em 1 a 3 momentos aparecem cartões de decisão de 5 segundos, como as substituições do manager. Exemplo: "pressão oscilando no estágio 2" com as opções reduzir empuxo (menos risco, menos delta-v), manter ou abortar. Cada intervenção gasta **pontos de Comando**, um recurso escasso que cresce com a experiência da sala de controle.
5. **Clímax.** Pouso, inserção orbital ou falha. Slow motion, silêncio no rádio, câmera na equipe. Essa é a hora da reação do público.
6. **Resultado.** Sucesso total, sucesso parcial, falha recuperável ou falha catastrófica. O **relatório de causas** mostra a cadeia: qual peça, qual decisão, qual dado de sorte. Depois vêm manchetes, reação de política e rivais, e o replay da linha do tempo.

**O que faz o jogador torcer:**

- A chance é visível antes do lançamento, então toda sobrevivência improvável e toda tragédia "quase certa" têm peso.
- A equipe tem rosto, história e lealdade. Perder um engenheiro veterano dói, e o comandante pode virar lenda.
- Som adaptativo (música de tensão que é cortada no pico), vibração do celular nos marcos e comemoração ou luto animados na sala de controle.
- O **Álbum da Agência** guarda os momentos marcantes como cartas colecionáveis, com a data e a manchete do dia.

## As Eras: de 1950 a 3000

Sete eras, em quatro camadas de veracidade: **fato** (até 2025), **plano oficial** (2026 até cerca de 2035), **projeção plausível** (cerca de 2036 a 2050) e **especulação** (2051 a 3000). Até 2050 os atores são os reais. Depois deles entram sucessores fictícios, o que dá liberdade narrativa.

| Era | Anos | Camada | Tom e visual | Marco de fechamento |
| --- | --- | --- | --- | --- |
| 1. A Corrida | 1950 a 1975 | Fato | Heroico, TV em preto e branco, painel analógico | Pouso na Lua e missão Apollo-Soyuz |
| 2. Estações e Sondas | 1976 a 1999 | Fato | Industrial, cinzento, burocrático | Primeiros módulos da ISS |
| 3. A Era Comercial | 2000 a 2025 | Fato | Limpo, corporativo, cores vivas | Reutilização de foguetes vira rotina |
| 4. A Década Lunar | 2026 a 2050 | Plano oficial e projeção | Disputa entre blocos, poeira lunar, urgência | Base lunar permanente em operação |
| 5. Expansão do Sistema | 2051 a 2199 | Especulação | Fronteira, improviso, mineração | Primeira colônia autônoma |
| 6. Interplanetária e Interestelar | 2200 a 2599 | Especulação | Habitats vivos, escalas enormes, contemplativo | Primeiro pouso em outro sol |
| 7. Galáctica | 2600 a 3000 | Especulação | Místico, estranho, cheio de silêncio | O Grande Silêncio (capítulo final) |

A cada era o jogo troca de pele: interface, paleta, trilha e até a unidade de tempo mudam. A transição é uma cena de reflexão, com resumo do que a agência fez e quem sobrou do time original.

## Calendário vivo: missões reais até 2050

As datas abaixo são os planos publicados até 17 de novembro de 2026, e eles mudam o tempo todo. Por isso entram no jogo como dados atualizáveis, com atraso sorteado a partir do histórico real: a Artemis II estava prevista para setembro de 2025 e voou em abril de 2026, e a Gaganyaan, planejada para 2022, ainda não tem voo tripulado.

| Quando | Missão | Quem | Estado em nov/2026 |
| --- | --- | --- | --- |
| Abr/2026 | Artemis II, sobrevoo lunar tripulado | NASA e CSA | Realizada: lançada em 1º de abril, amerissagem em 10 de abril ([fonte](https://spacepolicyonline.com/?p=88152)) |
| 2º semestre/2026 | Chang'e-7, polo sul da Lua (orbitador, pouso, rover e saltador) | China | Lançamento adiado em 23 de agosto por tempestade tropical; nova data a confirmar ([fonte](https://www.natureworldnews.com/articles/73200/20260826/change-7-launch-postponed-tropical-storm-narra.htm)) |
| 2027 | Gaganyaan, primeiro voo tripulado indiano | ISRO | Meta de 2027, depois de voos não tripulados ([fonte](https://www.businesstoday.in/science/story/crewed-moon-landing-by-2040-gaganyaan-in-2027-isro-outlines-roadmap-for-next-space-frontier-498336-2025-10-15)) |
| Meados de 2027 | Artemis III, teste em órbita terrestre com trajes e landers | NASA | Meta da reestruturação de fevereiro de 2026 ([fonte](https://www.theregister.com/2026/03/02/nasa_artemis_reshuffle/)) |
| Início de 2028 | Artemis IV, primeiro pouso lunar tripulado do programa | NASA, SpaceX, Blue Origin | Landers não ficam prontos antes do fim de 2027 ([fonte](https://cislunarspace.cn/en/space-news/2026/04/2026-04-29-artemis-hls-starship-blue-origin-delay/)) |
| Fim de 2028 | Artemis V, segundo pouso | NASA | Meta de fevereiro de 2026 |
| 2028 a 2029 | Chang'e-8, teste de uso de recursos lunares | China | Planejada ([fonte](https://news.cgtn.com/news/2026-04-24/China-Space-Day-How-far-have-we-come-toward-a-manned-lunar-landing--1MBhqOD8nQs/share_amp.html)) |
| 2028 | Dragonfly (Titã), Rosalind Franklin (Marte), Tianwen-3 (amostras de Marte) | NASA, ESA, China | Lançamentos planejados ([fonte](https://en.wikipedia.org/wiki/List_of_proposed_Solar_System_probes)). A SpaceX adiou os planos de Marte de 2026 e não se comprometeu com a janela de 2028 ([fonte](https://www.analyticsinsight.net/news/spacex-delays-2026-mars-mission-shifts-starship-focus-to-nasa-moon-landing)) |
| 2029 | Tianwen-4, Júpiter e Calisto | China | Planejada |
| Até 2030 | Pouso tripulado chinês na Lua | China | Meta oficial reafirmada ([fonte](https://www.aol.com/articles/factbox-chinas-crewed-lunar-programme-114353660.html)) |
| Fim de 2030 | Fim da ISS, com reentrada controlada em 2031 por veículo da SpaceX | NASA e parceiros | Planejado; estações comerciais (Vast, Axiom, Starlab, Orbital Reef) disputam a sucessão ([fonte](https://orbitalintel.pages.dev/space-station-race)) |
| Julho de 2031 | JUICE chega a Júpiter | ESA | Em trânsito ([fonte](https://www.wikiwand.com/en/articles/List_of_planned_future_spaceflight_launches)) |
| Cerca de 2033 | Retorno de amostras de Marte (NASA e ESA) | EUA e Europa | Em pausa indefinida ([fonte](https://planetary.org/articles/the-new-faces-of-mars)) |
| 2035 | Estação espacial indiana (BAS) | ISRO | Meta oficial (mesma fonte do Gaganyaan) |
| 2040 | Astronauta indiano na Lua | ISRO | Meta oficial (mesma fonte do Gaganyaan) |
| 2036 a 2050 | Base lunar permanente, rotas a Marte | Vários | Projeção plausível, gerada pelo simulador a partir de tendências, sem calendário oficial detalhado |

## Gestão da agência

O dashboard é a tela inicial: cinco números que importam e uma fila de decisões. O jogador deve entender o estado da agência em 10 segundos.

| Sistema | O que controla | Tensão de design |
| --- | --- | --- |
| Orçamento | Verba anual, contratos, caixa | Gastar em pesquisa agora ou em lançamento agora |
| Política e opinião | Apoio do governo, mídia, público | Missões ousadas rendem apoio, mas falhas custam caro |
| Equipe | Engenheiros, diretores de voo, tripulantes, com traços e lealdade | Contratar estrelas ou formar talentos |
| Instalações | Bases de lançamento, laboratórios, fábricas | Capacidade e especialização por era |
| Reputação | Confiança de parceiros e prestígio global | Abre contratos e acordos, cai com cada tragédia |
| Cultura | Cautela contra ousadia, que muda o perfil da agência | Define quais eventos e escolhas aparecem |

A equipe é o centro do vínculo emocional: cada pessoa tem uma ficha curta (especialidade, traços, ambição) e uma história que cresce a cada missão. Isso é o equivalente ao elenco do manager, e aposentar ou perder alguém tem consequência de narrativa.

## Frota, missões e simulação

O jogador não projeta foguetes. Ele escolhe veículos prontos de um catálogo e monta missões. A inspiração em KSP fica só na lógica: custo de energia por rota, janelas e falhas que têm causa.

**Catálogo de veículos.** Cada veículo é uma ficha com capacidade de carga por destino, custo, cadência, confiabilidade e datas de disponibilidade. Na história real são os veículos reais (Saturn V, Soyuz, Space Shuttle, Falcon 9, SLS, Starship, New Glenn, Long March, LVM3 e outros), que entram e saem do catálogo nas datas oficiais. Depois de 2050 entram veículos especulativos, liberados pela tech tree.

**Montagem da missão em 3 passos.** (1) Alvo e tipo: satélite, sonda, tripulada, carga ou estação. (2) Veículo e espaçonave do catálogo, mais a configuração: tripulação, carga e margem. (3) Resumo com o que o veículo cumpre, o custo, a janela e a chance estimada.

**Rotas e janelas.** As rotas aparecem como um mapa de metrô, com o custo de energia de cada trecho em barras, sem fórmulas na tela. Alinhamentos planetários criam janelas de lançamento, e perder uma custa meses ou anos (para Marte, uma janela surge a cada cerca de 26 meses).

**Confiabilidade e risco.** Cada veículo tem confiabilidade histórica, medida quando existe e estimada quando é novo, que melhora com voos e pesquisa. O risco da missão combina veículo, clima, equipe, cultura e prazo. Existem cinco tipos de falha (propulsão, estrutura, software, fator humano e ambiente), e o relatório sempre aponta qual atuou.

**Atrasos realistas.** O calendário oficial é só uma intenção. O jogo sorteia atrasos a partir do histórico de cada programa, e o jogador sente isso como pressão política e de orçamento.

**Justiça da sorte.** A semente aleatória é fixada na contagem final. Fechar o app ou recarregar não muda o resultado, e a sorte nunca é manipulada depois que o jogador vê a chance estimada.

## Tech tree

Seis ramos, travados por era. Na história real a pesquisa melhora o que a agência já opera (confiabilidade, custo, capacidade de carga) e sempre traz risco de atraso. Depois de 2050 ela também libera veículos especulativos.

| Ramo | Eras 1 e 2 | Eras 3 e 4 | Eras 5 a 7 |
| --- | --- | --- | --- |
| Propulsão | Motores líquidos, estágios | Reutilização, ion, fusão inicial | Fusão madura, velas, antimatéria |
| Estruturas e materiais | Aço, alumínio, escudos térmicos | Compósitos, impressão orbital | Habitats vivos, estruturas autônomas |
| Suporte de vida | Cápsulas curtas | Habitats fechados, cultivo | Ecossistemas, crescimento de colônias |
| Computação e IA | Computador de bordo | Autonomia, robótica | IA coletiva, comunicação interestelar |
| Energia | Painéis, baterias | Reatores, orbitais | Redes planetárias e estelares |
| Ciência e observação | Telescópios, sondas | Laboratórios, amostras | Detecção de anomalias e contato |

**Como a pesquisa funciona:**

- Pontos de ciência vêm de missões, laboratórios e dados de anomalias.
- Cada projeto de P&D escolhe uma abordagem, segura (mais lenta) ou ousada (mais rápida, com chance de resultado inesperado, bom ou ruim).
- Algumas descobertas só aparecem por eventos, como o estudo de uma anomalia, e abrem nós secretos.
- Rivais pesquisam em paralelo. Patentes, licenciamento e espionagem entram no jogo de competição.

## Aleatoriedade, eventos e narrativa

Três camadas de acaso, todas explicáveis ao jogador depois que acontecem.

| Camada | Quando acontece | Exemplo | Efeito |
| --- | --- | --- | --- |
| Falhas técnicas | Nos marcos do lançamento | Vazamento no estágio 2 | Mudança na missão ou falha |
| Eventos de operação | Durante trânsito e operações | Tempestade solar, cometa na rota | Perda de tempo, de recurso ou oportunidade |
| Eventos narrativos | Entre missões, por gatilhos de estado | Um engenheiro vende planos ao rival | Escolhas com consequência de longo prazo |

**Cartões de evento (estilo Stellaris).** Um retrato, 3 a 5 linhas de texto, 2 a 4 escolhas e um efeito visível antes de confirmar. Os efeitos são mistos e raramente puramente bons. Algumas escolhas só aparecem se a agência tem determinada cultura, tecnologia ou pessoa.

**Cadeias.** Um evento abre o próximo. Exemplo de uma cadeia de 4 passos: uma sonda capta um sinal periódico em uma lua gelada, a equipe discute se divulga ou esconde, um rival descobre, e uma segunda missão decide se vai olhar de perto. Cada passo tem ramificações que mudam o lore da campanha.

**Regras de acaso:**

1. Probabilidades visíveis sempre que o jogador pode agir sobre elas.
2. Sem repetição: eventos têm histórico e peso que cai depois de aparecer.
3. Sorte com memória leve: três falhas seguidas não causam uma quarta, mas aumentam a chance de eventos de recuperação, para evitar frustração.
4. Todo evento muda algo no estado do mundo, nunca é só texto.

## Mapa do universo e colonização

O mapa é o equivalente do mapa de Stellaris: o lugar onde o jogador vê o que sua agência fez ao universo.

**Três níveis de zoom, por pinça:** o sistema (órbitas e janelas em esquema 2D), o setor (estrelas vizinhas e rotas) e a galáxia (nós de coloniação). Tocar em um corpo abre uma ficha com tipo, gravidade, atmosfera, recursos, perigos e história.

**Névoa de guerra.** O que não foi visitado fica escuro. Sondas revelam o mapa, e cada descoberta vira uma pequena cena com texto e imagem.

**Estágios de colonização:**

1. **Reconhecimento.** Sonda ou fly-by.
2. **Posto avançado.** Um módulo e poucas pessoas.
3. **Base.** Energia, suporte de vida e produção local.
4. **Colônia.** População crescente, com necessidades e opinião própria.
5. **Cidade-estado.** Economia própria, gera eventos e missões.
6. **Mundo independente ou aliado.** A colônia pode se separar ou virar facção poderosa.

Cada estágio exige logística: linhas de suprimento no mapa com tempo de viagem e risco. Visualmente, a coloniação aparece como luzes que crescem no lado noturno do planeta e linhas pulsando entre os mundos. Colônias são o seu segundo "time": você torce por elas também, e as crises delas são as melhores histórias do jogo.

## Atores, rivais e diplomacia

O mundo tem vários atores simulados, não um rival só. Cada um tem metas, orçamento, humor político e relações com os demais. Até 2050 são os atores reais, e eles cooperam e competem ao mesmo tempo, como no mundo de hoje.

**Quem você dirige.** No início da campanha o jogador escolhe o ator: uma potência (EUA, URSS e depois Rússia, China), uma média (Europa, Japão, Índia), uma emergente (Brasil, Emirados) ou, a partir da Era 3, uma empresa privada. Isso define dificuldade, orçamento e aliados iniciais.

| Ator | Papel no jogo | Estilo | Relações em 2026 |
| --- | --- | --- | --- |
| EUA: NASA e empresas (SpaceX, Blue Origin, Axiom, Vast) | Lidera o programa Artemis e contrata empresas | Cooperam e competem: SpaceX e Blue Origin disputam o pouso e entram juntas no teste da Artemis III | Bloco dos Acordos Artemis |
| China: CNSA e CMSA | Pouso tripulado até 2030 e base lunar | Metódica, prazos firmes | Rival principal dos EUA; lidera o bloco ILRS com a Rússia |
| Índia: ISRO | Gaganyaan, estação BAS e Lua em 2040 | Frugal e persistente | Coopera com NASA e Axiom, estuda missão com o Japão e rivaliza com a China |
| Europa: ESA | Ciência e parcerias | Consenso lento | Parceira dos EUA, perdeu a cooperação russa no ExoMars em 2022 |
| Rússia: Roscosmos | Estação própria e bloco ILRS | Isolada, orgulhosa | Aliada da China |
| Japão: JAXA | Parceiro do programa lunar americano | Preciso e discreto | Bloco dos Acordos Artemis, com estudos com a Índia |
| Empresas privadas | Cadência e preço, estações comerciais | Rápidas, arriscadas | Cooperam com governos e rivalizam entre si |

**Diplomacia.** O jogador pode propor parcerias de missão, dividir custos, trocar tripulantes, acordar transferência de tecnologia, aderir a blocos e assinar tratados (uso pacífico, recursos lunares, tráfego orbital). Aceitar ou romper tem custo de reputação e pode virar notícia. Os outros atores fazem o mesmo entre si, sem script: uma aliança nasce, esfria e se rompe conforme confiança, dependência e rivalidade.

**Formas de competição:**

- **Os Primeiros.** Primeiro a chegar a cada marco ganha prestígio permanente, e o segundo ganha bem menos.
- **Leilões de contratos.** Preço, prazo e reputação decidem.
- **Tabela da Era.** Classificação das agências, com troféu ao fim de cada era, como uma liga.
- **Espionagem e sabotagem.** Existem como eventos de risco, com custo de reputação e chance de ser descoberto.

**Depois de 2050.** Os atores reais se transformam em sucessores especulativos: consórcios planetários, corporações-estado, colônias independentes e o misterioso Colégio Silêncio.

## Política e guerras simuladas

O jogador não declara nem conduz guerras. Ele sofre as consequências e decide como a agência responde. Guerras aparecem como notícias, cartas de evento e efeitos de gestão, sem cenas de combate.

| Camada | O que simula | Como chega ao jogador |
| --- | --- | --- |
| Economia | PIB, crises, orçamento público | Verba anual sobe ou cai |
| Política interna | Eleições, trocas de governo, prioridades | Apoio e cancelamento ou revisão de programas |
| Relações internacionais | Tensões, alianças, sanções | Parcerias congeladas, acesso a lançadores e rotas |
| Conflitos | Guerras regionais e globais | Perda de parceiros, verba desviada, programas suspensos |

**Escala de tensão** (de 0 a 4, para cada par de atores): 0 normal, 1 tensão (parcerias esfriam), 2 crise (sanções e cortes de verba), 3 conflito regional (rotas e parceiros perdidos) e 4 guerra aberta (programas suspensos e prioridade militar).

**Regras de simulação:**

1. Até 2025 os grandes eventos políticos são fatos históricos e acontecem como no mundo real.
2. A partir de 2026 o mundo diverge: o simulador gera cenários plausíveis ancorados em tendências reais, e cada campanha é diferente.
3. Conflitos nascem do estado do mundo (rivalidade, instabilidade, provocações), nunca por script.
4. O jogador influencia por diplomacia, tratados e reputação, mas nunca controla o desfecho.

## UI/UX mobile, feedback visual e animações

**Estrutura.** Retrato, uso com o polegar, cinco abas na base: Painel, Missões, Pesquisa, Mapa e Mundo (notícias e rivais). Qualquer ação importante está a no máximo dois toques do painel. Em vez de tabelas densas, usa cartões, chips e barras de tendência.

**Painel.** Cinco números grandes (verba, apoio, reputação, equipe, próxima janela) e uma fila de decisões pendentes ordenada por urgência. Um ticker de manchetes anima por cima.

**Feedback visual (o que Stellaris faz bem):**

- Ao decidir, algo se move: números contam, barras enchem, ícones pulsam no mapa.
- Cada era tem paleta, tipografia, sons e moldura de interface próprios.
- No lançamento, partículas, câmera com tremor, telemetria viva e rostos na sala de controle.
- Resultados têm cena: comemoração, luto, manchete e replay.

**Arte.** 2D flat com ilustração estilizada (retrofuturismo gráfico, cartazes de propaganda e blueprints), com sprites e shaders leves para rodar bem em celulares medianos. Os retratos das pessoas são ilustrações compostas por peças para gerar muitos rostos com pouco custo.

**Acessibilidade.** Texto escalável, modo daltonismo, opção de reduzir movimento e vibração, e nenhuma informação importante só por som.

## Worldbuilding e narrativa

**Premissa.** Até 2050 o jogo segue a história real e os planos oficiais de hoje, e depois disso é especulação. A humanidade sai do berço em 1957 e, mil anos depois, encontra o limite do que é possível. O tom é de esperança com custo humano: coragem tem preço, e o jogo não esconde isso.

**O mistério de fundo: o Eco.** Sinais fracos que só aparecem quando a humanidade alcança certos marcos. A cada era, a agência recebe uma peça nova, e o Colégio Silêncio parece sempre saber mais. Em 3000 o jogador escolhe entre três desfechos: **Contato** (responder), **Silêncio** (calar e seguir sozinho) ou **Herança** (deixar tudo preparado para quem vier depois).

**Legados.** Os sobrenomes das pessoas que você formou voltam gerações depois: a neta de uma comandante vira diretora de voo, o engenheiro que morreu em 1967 dá nome a um laboratório em 2210. Esse eco do passado é a principal ferramenta de emoção do jogo.

**Formas narrativas:**

- Rádio da missão, diário de bordo e cartas de família.
- Manchetes e matérias, no estilo e na linguagem de cada era.
- O **Memorial**: parede com o nome de quem morreu a serviço, que cresce ao longo da campanha.
- Relatórios de colônias, escritos pelas próprias colônias.

**Cultura das colônias.** Cada grande mundo desenvolve costumes, sotaque e política próprios. Marcianos, cinturões e estelares divergem de forma que o jogador percebe nos eventos e nas escolhas disponíveis.

## Progressão, retenção e modos de jogo

| Modo | O que é | Para quem |
| --- | --- | --- |
| Campanha | 1950 a 3000 em sete eras, com o mistério do Eco | Quem quer a história completa |
| Cenários | Uma era isolada, como a corrida lunar, em 1 a 2 horas | Sessões curtas e novos jogadores |
| Desafio da semana | A mesma missão para todos, com ranking de torcida | Competição e comparação |
| Modo Lenda | Sem recarregar, perdas permanentes | Quem quer tensão máxima |

**Meta-progressão.** O prestígio da agência, entre campanhas, desbloqueia fundadores com traços, cosméticos da agência e o Álbum completo.

**Retenção sem manipulação.** Sessões curtas com final claro. Notificações só avisam o que o jogador pediu, como "sua sonda chegou a Marte". Nada de espera paga: avançar o tempo é sempre grátis e opcional.

**Social assíncrono.** Amigos podem "torcer" antes do lançamento e enviar um moral extra, replays se compartilham como vídeo curto e as ligas semanais comparam a mesma missão.

**Modelo de negócio sugerido.** Compra única com expansões de eras e cenários, sem vantagem paga. Combina com o público de manager e simulação, que rejeita pay-to-win.

## MVP, roadmap técnico, riscos e perguntas em aberto

**MVP (corte vertical).** O cenário Corrida Lunar (2026 a 2030), para provar duas coisas: o dia de lançamento faz o jogador torcer, e rivais com diplomacia e política simulada deixam o mundo vivo. Inclui o mapa Terra-Lua, veículos reais do catálogo, uma equipe com rostos, cinco blocos de atores (EUA, China, Índia, Europa e empresas privadas), tratados, eventos autorais e o ciclo completo de missão com relatório de causas.

&#91;embedded content: roadmap · 5 fases, 2 critérios de passagem\]

O caminho é protótipo feio primeiro, o cenário Corrida Lunar polido depois. Só se avança se os testers torcem de verdade e a sessão de 5 minutos fecha sem confusão.

**Tecnologia sugerida.**

- **Cliente:** Godot 4 em 2D, com exportação para Android e iOS, pelo bom suporte a animação, partículas e UI responsiva.
- **Simulação:** núcleo determinístico e separado da interface, alimentado por semente, testável por planilha antes de existir qualquer tela.
- **Conteúdo orientado a dados:** eventos, módulos, tech tree e rivais em JSON ou YAML, para escrever e balancear sem recompilar.
- **Backend:** Supabase (Postgres, autenticação e realtime) para saves na nuvem, ligas semanais e replays.

**Riscos e respostas:**

| Risco | Resposta |
| --- | --- |
| Escopo de mil anos e sete eras | Fechar o cenário Corrida Lunar (2026 a 2030) como corte vertical e tratar as outras eras como expansões de conteúdo |
| Sorte que parece injusta | Chance visível, semente fixa, relatório de causas e recuperação leve |
| Volume de texto narrativo | Escrita autoral nos momentos-chave e eventos modulares recombináveis para o resto |
| Complexidade de UI no celular | Cartões, 5 abas, nada a mais de 2 toques e teste de usabilidade com a Era 1 |
| Uso de nomes e marcas reais (NASA, SpaceX, CNSA, ISRO) | Revisão jurídica, identidade visual própria e nenhum logotipo oficial |

**Perguntas em aberto:**

- O tom deve ser mais realista (ficção científica hard) ou mais estilizado e pulp?
- Compra única ou free-to-play?
- Arte vetorial flat ou pixel art?
- As sete eras saem no lançamento ou entram como expansões?
- Nomes reais até 2050 (com revisão jurídica) e fictícios depois, como proposto?
- Há espaço para multiplayer assíncrono mais profundo, além das ligas?

## Plano de desenvolvimento em 10 turnos de prompt

Cada etapa é um turno: um prompt que termina com algo rodando. A ordem constrói primeiro o que é invisível (simulação, atores, política) e só depois a parte que se vê, porque o jogo vive de um mundo que reage. Os turnos 1 a 5 cobrem o balanço em planilha, o 6 e o 7 o Dia de Lançamento, o 8 e o 9 o corte vertical da Corrida Lunar e o 10 o polimento.

**Regras de todo turno:**

1. Termina com algo que roda e com o arquivo PROGRESS.md atualizado (o que existe, o que falta, decisões tomadas).
2. O prompt seguinte começa colando o link deste documento e o PROGRESS.md.
3. Se o critério de pronto não bater, repete o turno antes de avançar.
4. A simulação nunca depende da interface, e os dados nunca ficam escritos dentro do código.

### Turno 1: Fundação do projeto e dos dados

- **Entregável:** projeto Godot 4 para celular em retrato, pastas separadas para dados, regras e interface, estado global do jogo e arquivos JSON de atores, veículos, missões e eventos.
- **Pronto quando:** o projeto abre, carrega os dados e passa em um teste automático que valida o esquema dos JSON.
- **Conceito de arquitetura:** separar dados, regras e interface.
- **Prompt:** *Leia o GDD do Ad Astra. Crie o projeto Godot 4 para celular em retrato, com pastas separadas para dados, regras e interface, um estado global do jogo e JSON para atores, veículos, missões e eventos. Adicione um teste que valida o esquema e crie o PROGRESS.md.*

### Turno 2: Núcleo de simulação, sem tela

- **Entregável:** tempo em turnos, orçamento, semente fixa, cálculo de risco da missão com cinco tipos de falha e quatro níveis de resultado.
- **Pronto quando:** a mesma semente dá sempre o mesmo resultado, e um script que simula 10 mil lançamentos mostra taxas de sucesso coerentes por veículo.
- **Conceito de arquitetura:** determinismo e testes em lote.
- **Prompt:** *Implemente o núcleo de simulação sem interface: turnos, orçamento, semente fixa, risco de missão com cinco tipos de falha e quatro níveis de resultado. Crie um script que simula 10 mil lançamentos e imprime as taxas por veículo.*

### Turno 3: Catálogo de veículos e calendário vivo (2026 a 2030)

- **Entregável:** veículos e missões reais da tabela do calendário em JSON, com camada de veracidade em cada item e atraso sorteado a partir do histórico.
- **Pronto quando:** uma simulação de 5 anos com 20 sementes mostra quando cada missão realmente acontece, e as datas oficiais ficam só nos dados.
- **Conceito de arquitetura:** dados como fonte de verdade e versionados.
- **Prompt:** *Carregue o calendário vivo de 2026 a 2030 do GDD em JSON, com camada de veracidade por item e atraso sorteado pelo histórico. Simule 5 anos com 20 sementes e imprima quando cada missão acontece.*

### Turno 4: Atores, relações e diplomacia

- **Entregável:** sete atores com relações (confiança, dependência, rivalidade), blocos (Acordos Artemis e ILRS), propostas de parceria e tratados, com IA baseada em utilidade.
- **Pronto quando:** uma simulação de 10 anos gera um log de alianças e rupturas, e rivais cooperam em um programa e competem em outro sem script.
- **Conceito de arquitetura:** IA baseada em utilidade e estado de relacionamento.
- **Prompt:** *Implemente os sete atores com relações, blocos, propostas de parceria e tratados, com IA por utilidade. Simule 10 anos e gere um log de alianças e rupturas.*

### Turno 5: Política e guerras simuladas

- **Entregável:** economia, política interna, escala de tensão de 0 a 4 entre pares de atores, eventos exógenos, efeitos em verba e parcerias e um noticiário em texto.
- **Pronto quando:** 20 sementes geram mundos diferentes e plausíveis, com notícias legíveis, e nenhuma delas trava o jogo.
- **Conceito de arquitetura:** estado global e eventos desacoplados.
- **Prompt:** *Implemente economia, política interna e a escala de tensão de 0 a 4 entre atores, com eventos exógenos e efeito em verba e parcerias. Gere um noticiário em texto e rode 20 sementes para provar que os mundos divergem sem travar.*

### Turno 6: Interface mobile base

- **Entregável:** cinco abas, painel com cinco números, fila de cartões de decisão, ticker de manchetes, tema visual por era e layout responsivo, ligados à simulação.
- **Pronto quando:** qualquer decisão importante está a no máximo dois toques do painel e o build roda em três tamanhos de tela.
- **Conceito de arquitetura:** interface que observa o estado, sem alterá-lo diretamente.
- **Prompt:** *Crie a interface mobile base: cinco abas, painel, cartões de decisão, ticker e tema por era, conectados à simulação. Gere um build Android.*

### Turno 7: Dia de Lançamento

- **Entregável:** cena 2D com os seis atos, telemetria, de 1 a 3 cartões de intervenção, som, vibração, resultado e relatório de causas.
- **Pronto quando:** testers dizem que torceram e querem repetir (o primeiro critério do roadmap).
- **Conceito de arquitetura:** cena que só apresenta o resultado calculado pela simulação.
- **Prompt:** *Crie a cena do Dia de Lançamento em 2D com os seis atos do GDD, telemetria, cartões de intervenção, som e vibração, resultado e relatório de causas, usando a simulação existente.*

### Turno 8: Mapa e operações

- **Entregável:** mapa 2D Terra, Lua e Marte com zoom, janelas de lançamento, missões em trânsito, névoa de guerra e eventos de operação.
- **Pronto quando:** uma missão lunar roda de ponta a ponta e perder a janela tem consequência clara na tela.
- **Conceito de arquitetura:** camadas de visualização sobre o mesmo estado.
- **Prompt:** *Crie o mapa 2D Terra, Lua e Marte com zoom por pinça, janelas, missões em trânsito, névoa de guerra e eventos de operação. Faça uma missão lunar completa de ponta a ponta.*

### Turno 9: Eventos narrativos, equipe e legados

- **Entregável:** cartões de evento com cadeias, equipe com rostos e história, Memorial, Álbum da Agência e o primeiro conteúdo autoral da Corrida Lunar.
- **Pronto quando:** três campanhas diferentes de 2026 a 2030 contam histórias diferentes.
- **Conceito de arquitetura:** conteúdo modular com peso, histórico e gatilhos.
- **Prompt:** *Implemente cartões de evento com cadeias, equipe com rostos, Memorial e Álbum. Escreva os primeiros eventos autorais da Corrida Lunar, ligados ao estado do mundo.*

### Turno 10: Backend, balanceamento e teste fechado

- **Entregável:** Supabase com login, saves na nuvem, ligas semanais e replays, telemetria básica, balanceamento em lote, otimização para celular intermediário e builds Android e iOS.
- **Pronto quando:** uma sessão de 5 minutos fecha sem confusão (o segundo critério do roadmap), e sai um relatório do teste com o backlog das outras eras.
- **Conceito de arquitetura:** backend como camada fina, com a simulação rodando no cliente e validada por semente.
- **Prompt:** *Integre o Supabase (login, saves, ligas semanais e replays), telemetria básica e balanceamento em lote. Otimize para celular intermediário, gere builds Android e iOS para teste fechado e escreva o relatório e o backlog das outras eras.*

## Fontes

Consultadas por busca na web em 17 de novembro de 2026. As páginas não foram lidas na íntegra e os planos mudam com frequência, então confirme as datas antes de fixá-las nos dados do jogo.

- [Artemis II: retorno da tripulação (Space Policy Online)](https://spacepolicyonline.com/?p=88152)
- [Reestruturação do Artemis (The Register)](https://www.theregister.com/2026/03/02/nasa_artemis_reshuffle/)
- [Landers atrasados até o fim de 2027 (Cislunar Space)](https://cislunarspace.cn/en/space-news/2026/04/2026-04-29-artemis-hls-starship-blue-origin-delay/)
- [SpaceX adia Marte de 2026 (Analytics Insight)](https://www.analyticsinsight.net/news/spacex-delays-2026-mars-mission-shifts-starship-focus-to-nasa-moon-landing)
- [Programa lunar tripulado da China (Reuters, via AOL)](https://www.aol.com/articles/factbox-chinas-crewed-lunar-programme-114353660.html)
- [Chang'e-7 adiado por tempestade (Nature World News)](https://www.natureworldnews.com/articles/73200/20260826/change-7-launch-postponed-tropical-storm-narra.htm)
- [Roteiro da ISRO até 2040 (Business Today)](https://www.businesstoday.in/science/story/crewed-moon-landing-by-2040-gaganyaan-in-2027-isro-outlines-roadmap-for-next-space-frontier-498336-2025-10-15)
- [Corrida das estações comerciais e fim da ISS (Orbital Intel)](https://orbitalintel.pages.dev/space-station-race)
- [Missões planetárias propostas (Wikipedia)](https://en.wikipedia.org/wiki/List_of_proposed_Solar_System_probes)
- [Mars Sample Return em pausa (The Planetary Society)](https://planetary.org/articles/the-new-faces-of-mars)
