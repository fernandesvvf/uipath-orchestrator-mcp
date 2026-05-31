# Aprendendo o MCP (do básico, com paralelos UiPath/REFramework)

Material de **estudo** pra quem entende o básico de programação + RPA e quer
entender bem os conceitos de arquitetura por trás deste MCP. Cada conceito é
explicado do zero e ancorado em algo que você já conhece do REFramework.

> Procurando referência técnica rápida (estrutura, regras, gotchas)? Veja
> `ARCHITECTURE.md`. Este aqui é o caminho longo, didático.

**Roteiro sugerido:**
1. [Entendendo os nomes das camadas](#1-entendendo-os-nomes-das-camadas) (analogia restaurante)
2. [O domain são os "contratos"](#2-o-domain-são-os-contratos)
3. [Glossário de nomes alternativos](#3-glossário-de-nomes-alternativos-das-camadas)
4. [Transporte: stdio, stdout, stderr, JSON-RPC](#4-transporte-stdio-stdout-stderr-json-rpc)
5. [Injeção de dependência](#5-injeção-de-dependência)
6. [Paralelo completo com REFramework](#6-paralelo-completo-com-uipath-reframework)
7. [Encapsulamento](#7-encapsulamento)
8. [Como evoluímos das aulas: auth e rate-limit](#8-como-evoluímos-das-aulas-auth-e-rate-limit)

---

## 1. Entendendo os nomes das camadas

Os nomes `domain` / `application` / `infrastructure` vêm da **Clean
Architecture** (Robert C. Martin, "Uncle Bob"). `mcp` é nosso — a camada de
"entrega"/apresentação. São **convenção**, não lei: outros projetos usam
`core`, `services`, `adapters`, `api`. Mesma ideia, nomes diferentes.

Os nomes confundem porque são abstratos. Tradução pra concreto:

| Nome chique | O que É de verdade | Pergunta que responde |
|-------------|-------------------|----------------------|
| **domain** | as definições / o dicionário | "o que é um Job? o que é uma falha?" |
| **infrastructure** | o encanamento / quem liga pra fora | "como busco isso no Orchestrator?" |
| **application** | o cérebro / as regras | "o que eu FAÇO com esses dados?" |
| **mcp** | a recepção / a porta | "como o agente pede e recebe?" |

### Analogia: restaurante

Pedido chega, comida sai.

```
CLIENTE (agente)
   │  faz pedido
   ▼
GARÇOM .............. = mcp            (recebe pedido, entrega prato, fala a língua do cliente)
   │
COZINHEIRO .......... = application    (a receita, decide COMO preparar, combina ingredientes)
   │
DESPENSEIRO ......... = infrastructure (vai no estoque/fornecedor buscar o ingrediente cru)
   │
RECEITAS/CARDÁPIO ... = domain         (define o que é "risoto", quais ingredientes existem)
```

- **Garçom (mcp)** não cozinha. Só recebe pedido e entrega. Fala a língua do cliente.
- **Cozinheiro (application)** não vai ao mercado. Recebe ingrediente, aplica receita, monta o prato.
- **Despenseiro (infrastructure)** não inventa prato. Só busca o ingrediente cru onde ele está.
- **Cardápio (domain)** é só definição: "risoto = arroz + caldo + queijo". Não cozinha, não busca, não atende. Só DIZ o que as coisas são.

Ninguém faz o trabalho do outro.

### O mesmo, no código (exemplo: `explain_failure`)

```
1. mcp (garçom):
   tools/explain-failure.ts
   "Agente pediu explain_failure do job X. Repasso e devolvo a resposta."
   NÃO sabe de HTTP nem de regra. Só recebe e entrega.

2. application (cozinheiro):
   orchestrator-service.ts → explainFailure()
   "Receita: busco o job E os logs ao mesmo tempo, pego o erro mais recente,
    monto uma frase explicando." ← A INTELIGÊNCIA mora aqui.

3. infrastructure (despenseiro):
   orchestrator-http-client.ts → getJobByKey(), getJobLogs()
   "Vou no Orchestrator via HTTP buscar o job cru e os logs crus." ← O fetch.

4. domain (cardápio):
   orchestrator.ts → o que é um "Job", um "RobotLog", uma "FailureExplanation"
   Só as definições. Zero ação.
```

### Por que separar assim (parece burocracia, mas paga)

Cada camada tem **um motivo só pra mudar**:

- Mudou a API do Orchestrator? → mexe só na **infrastructure** (o despenseiro troca de fornecedor). Resto intacto.
- Mudou a regra ("job preso = 3× a média, não 2×")? → mexe só na **application** (o cozinheiro ajusta a receita).
- Trocou stdio por HTTP? → mexe só no **mcp/index** (o garçom muda o jeito de atender).
- Adicionou campo no Job? → mexe só no **domain** (o cardápio atualiza).

### A regra "aponta pra dentro"

```
mcp → application → infrastructure → domain
```

A seta = "depende de / chama / conhece":

- o garçom conhece o cozinheiro (chama ele)
- o cozinheiro conhece o despenseiro
- todos conhecem o cardápio

**Mas NUNCA o contrário:** o cardápio (domain) não sabe quem é o garçom. O
despenseiro não manda no cozinheiro.

Por quê? O **domain** é o coração estável. Se ele dependesse do garçom, trocar o
garçom quebraria o cardápio. Mantendo-o ignorante do resto, ele nunca quebra
quando você mexe nas bordas.

> Regra mental: **o que é mais importante/estável fica no centro e não conhece
> ninguém. O que é mais volátil (HTTP, protocolo) fica na borda e conhece o
> centro.**

### Resumo de bolso

```
domain         = "o quê é"      (dicionário, núcleo, nunca muda por capricho externo)
infrastructure = "como busco"   (HTTP, o encanamento)
application    = "o que faço"   (regras, o cérebro)
mcp            = "como entrego"  (a porta pro agente)
```

Renomeando mentalmente: **definições → encanamento → cérebro → porta**.

---

## 2. O domain são os "contratos"

Sim — **domain = contratos**. Define **a forma das coisas**: schemas + tipos.
"Job tem Id, State, ProcessName...". Quem fala com o domain concorda com esse
formato. É o contrato compartilhado por todas as camadas.

No nosso: `domain/orchestrator.ts` tem `JobSchema`, `QueueItemSchema`,
`FailureExplanationSchema`, etc. Mais os erros (`domain/errors.ts`) e a
interface de auth (`domain/auth.ts`).

### Afinação 1 — não são "classes", são schemas + tipos

Cuidado com a palavra **classe**. No domain quase tudo é **schema Zod + tipo**,
não classe:

```ts
export const JobSchema = z.object({ Id: z.number(), State: JobStateSchema, /* ... */ });
export type Job = z.infer<typeof JobSchema>;   // tipo derivado do schema
```

`Job` é um **tipo** (a forma de um objeto), não uma classe com métodos. É
proposital: o domain é dado puro, sem comportamento. As exceções com `class` no
domain (`BearerAuth`, `UnauthorizedError`) são casos especiais (estratégia de
auth, erros). O grosso = schema + tipo.

### Afinação 2 — Zod faz dois trabalhos

O schema Zod não é só documentação. Faz **2 coisas**:

1. **Tipo em build** — `z.infer` dá o tipo TypeScript (autocomplete, checagem).
2. **Validação em runtime** — o Zod checa de verdade quando o dado entra/sai.

Por isso o mesmo schema vira o `inputSchema`/`outputSchema` das tools. O contrato
do domain **é** o contrato exposto ao agente. Uma fonte de verdade, dois usos.

### Contrato interno vs externo

| Schema | Onde | Pra quê |
|--------|------|---------|
| `JobSchema` | domain | forma do dado cru do Orchestrator |
| `OrchestratorResultSchema` | domain | contrato de SAÍDA das tools (o "envelope" wide) |

`OrchestratorResultSchema` é especial — é o contrato que o **agente** recebe.
Declara toda chave possível (`jobs`, `incidents`, `isError`, `message`...).
Lembra a regra: `outputSchema` WIDE, senão o SDK rejeita com
`data must NOT have additional properties`.

### Resumo

```
domain = contratos =
   schemas Zod (forma)
   + tipos derivados (z.infer)
   + erros nomeados
   + interface de auth
   = a fonte de verdade que todo mundo respeita, zero comportamento de negócio
```

Mental certo: **"o dicionário de formas que o resto do código respeita."**
Só troque "classes" por "schemas/tipos", e lembre que o Zod também valida em
runtime, não só documenta.

---

## 3. Glossário de nomes alternativos das camadas

Os nomes que usamos (`domain`/`application`/`infrastructure`/`mcp`) são UMA
convenção (Clean Architecture). Outros projetos chamam as mesmas camadas de
outros nomes. Use esta tabela pra reconhecer "ah, esse `core/` é o domain" ao ler
qualquer codebase.

| Nossa camada | Também chamada de | Onde aparece | Sinaliza |
|--------------|-------------------|--------------|----------|
| **domain** | `core`, `entities`, `model(s)`, `schemas`, `types` | DDD, Clean Arch; Node/TS pragmático usa `schemas/` | o núcleo: formas + regras do negócio |
| **application** | `services`, `use-cases`/`usecases`, `business`, `logic` | NestJS/Spring usam `services/`; Clean Arch explícito usa `use-cases/` | a lógica / orquestração |
| **infrastructure** | `adapters`, `clients`, `gateways`, `data`/`dal`, `external`, `integrations` | Hexagonal usa `adapters/`; quando é só API, `clients/` | tudo que fala com o mundo externo |
| **mcp** (entrega) | `api`, `presentation`, `interface`, `handlers`, `controllers`, `transport` | nosso caso é específico do protocolo MCP | a porta pra quem consome |

### Qual é o mais comum no mercado

- **domain** — forte em backend sério / DDD / Clean Arch (nome canônico do
  núcleo). No dia-a-dia Node/TS pragmático, vira `schemas/` ou `models/`.
- **application** — `services/` é disparado o mais comum (Node, NestJS, Spring).
  `application/` é mais "livro de arquitetura".
- **infrastructure** — comum em arquitetura formal (é guarda-chuva: cobre HTTP +
  DB + fila). Quando é só chamada de API, `clients/` ou `adapters/` é mais preciso.

### Cuidado com `repositories`

`repositories/` é um nome específico pra **persistência / banco de dados**
(salvar/buscar entidades num DB). Nosso `infrastructure` chama uma **API REST**,
não um banco — então `clients/`/`adapters/` cabe, mas `repositories/` seria
tecnicamente **errado** aqui. Só use `repository` quando houver banco.

### Pares consistentes (não misture estilos)

Se for renomear, mantenha um estilo só — `domain/` + `services/` fica esquisito
(um nome formal, outro pragmático):

```
DDD / formal (nosso)        Pragmático TS           Hexagonal
─────────────────           ─────────────           ─────────
domain/                     schemas/ (models/)      domain/
application/                services/               application/ (use-cases/)
infrastructure/             clients/                adapters/ (outbound)
mcp/                        mcp/                    adapters/ (inbound)
```

(No Hexagonal, `mcp` e `infrastructure` são ambos "adapters" — um de entrada,
outro de saída — daí `adapters/inbound` e `adapters/outbound`.)

**Recomendação enquanto aprende:** mantenha os nomes formais
(`domain`/`application`/`infrastructure`). São os canônicos, você vai reencontrar
em todo material de arquitetura — e este doc já traduz cada um pra leigo.

---

## 4. Transporte: stdio, stdout, stderr, JSON-RPC

O agente (cliente) e o teu MCP (servidor) são **dois processos separados** que
precisam conversar. **Transporte** = o CANO por onde as mensagens passam. O nosso
é **stdio** (local); a alternativa seria HTTP/SSE (rede/remoto).

### stdin / stdout / stderr — os 3 canos de TODO processo

Não é coisa de MCP — todo programa de terminal nasce com 3 "tubos" (streams),
do sistema operacional:

```
            ┌─────────────┐
 stdin  →→→ │             │  →→→ stdout   (saída normal / resultado)
 (entrada)  │  processo   │
            │             │  →→→ stderr   (saída de erro / log)
            └─────────────┘
```

| Stream | Nome | Pra quê | Em Node |
|--------|------|---------|---------|
| **stdin** | standard input | o que ENTRA | — |
| **stdout** | standard output | saída NORMAL / resultado | `console.log` |
| **stderr** | standard error | erros / logs (cano à parte) | `console.error` |

### stdio = stdin + stdout juntos

"stdio" = **std**ard **i**nput/**o**utput — usar stdin+stdout como cano de
comunicação. No transporte stdio do MCP:

```
agente ──escreve pedido no stdin──→ [teu MCP] ──responde pelo stdout──→ agente
```

Sem rede, sem porta. Por isso "não fica no ar": o agente spawna o MCP como
subprocesso e fala pelos tubos; fecha o processo, acabou.

### A regra de ouro: stdout é SAGRADO

No stdio, o **stdout só pode trafegar protocolo**. Se você der `console.log`, o
texto cai no MESMO cano das mensagens → vira lixo no meio do JSON-RPC →
**corrompe a conversa** → o agente quebra.

```ts
console.error("...")   // ✅ vai pro stderr — cano SEPARADO, log seguro
console.log("...")     // ❌ vai pro stdout — corrompe o protocolo
```

No `index.ts` o log de boot usa `console.error` de propósito: você vê no
terminal, mas o stdout fica limpo só pro protocolo. **stderr = onde o MCP
"resmunga" sem atrapalhar a conversa oficial.**

> Paralelo RPA: é como não jogar `Log Message` de debug no MESMO output que outro
> sistema lê pra parsear — você manda o ruído pra um canal à parte, não pro
> resultado oficial.

### JSON-RPC — o IDIOMA falado dentro do cano

Transporte (stdio) = o CANO. JSON-RPC = a LÍNGUA falada nele. JSON-RPC é um
padrão simples de "chamar função remota usando JSON" (RPC = Remote Procedure
Call).

**Pedido** (agente → MCP):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "find_folders", "arguments": { "query": "compras" } }
}
```

**Resposta** (MCP → agente):
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "..." }],
    "structuredContent": { "folders": [] }
  }
}
```

- `id` — casa pedido↔resposta (pergunta 1 → resposta 1)
- `method` — o que fazer (`tools/call`, `tools/list`, `resources/read`...)
- `params` — argumentos · `result`/`error` — a volta

**Você nunca escreve esse JSON.** O `@modelcontextprotocol/sdk` monta/lê tudo:
traduz `tools/call` → chama o teu handler → empacota o retorno em JSON-RPC.

### Camadas mentais

```
1. stdio     = o cano físico (stdin entra, stdout sai)
2. JSON-RPC  = a língua falada no cano
3. MCP       = o vocabulário dessa língua (tools/call, resources/read...)
4. teu código= só implementa as tools; o SDK cuida de 1–3
```

> Resumo: **stdio** = 3 tubos do processo (entra/sai/erro). **stdout sagrado** —
> só protocolo; log vai no **stderr** (por isso `console.error`, nunca
> `console.log`). **JSON-RPC** = o idioma "chama função X com args Y" em JSON; o
> SDK fala por você.

### stdio vs HTTP — trocar o cano

O `index.ts` liga o transporte. Hoje stdio (tubos locais do processo). Trocar pra
HTTP = ligar um servidor que escuta uma porta — aí sim "botar no ar":

```ts
// hoje (stdio): tubos do processo, local
const transport = new StdioServerTransport();
await server.connect(transport);

// HTTP (hipotético): abre porta, fica no ar
const transport = new StreamableHTTPServerTransport({ /* ... */ });
// + app.listen(3000)  ← agora SIM escuta porta, vários clientes, remoto
```

**Só o `index.ts` muda.** server.ts, service, client e tools ficam intactos — o
transporte é plugável. (É exatamente por isso que index e server são arquivos
separados: trocar o cano sem mexer no miolo.)

| | stdio (hoje) | HTTP (se mudar) |
|---|---|---|
| Cano | tubos do processo | rede / porta |
| Quem liga o MCP | o agente (spawn) | você (deploy/run) |
| Fica "no ar"? | não — vive com o agente | sim — escuta porta |
| Onde roda | mesma máquina | pode ser remoto |
| Quantos clientes | 1 (quem spawnou) | vários ao mesmo tempo |
| Monitorar uptime | não | sim |

Quando trocar: agente em máquina diferente do MCP, vários agentes compartilhando
1 MCP, ou MCP como serviço central. Pro caso local (agente LangGraph.js na mesma
máquina), stdio basta — nada "no ar".

> Nota: "stdio = terminal" é só atalho mental. No uso real não há terminal
> humano — o agente spawna o MCP e fala pelos tubos stdin/stdout (processo↔
> processo). O terminal é só onde VOCÊ vê quando testa na mão.

---

## 5. Injeção de dependência

### O que é (analogia)

Duas formas de um objeto conseguir o que precisa pra trabalhar:

- **SEM injeção:** o cozinheiro entra na cozinha e ELE MESMO vai ao mercado
  comprar o ingrediente.
- **COM injeção:** o ingrediente JÁ ESTÁ na bancada, entregue. Ele não sabe de
  onde veio. Só usa.

**Injeção de dependência = entregar pra um objeto as coisas que ele precisa, em
vez de ele criar/buscar essas coisas por conta própria.** "Dependência" = o que
o objeto precisa pra funcionar (cliente HTTP, auth, config). "Injeção" = passar
isso de fora (pelo construtor/parâmetro).

### Em código — sem vs com

```ts
// SEM injeção (ruim): o service cria o próprio client, hardcoded
class OrchestratorService {
  #client;
  constructor() {
    this.#client = new OrchestratorHttpClient("https://cloud.uipath.com/...", /* ... */);
  }
}

// COM injeção (nosso jeito): recebe as peças DE FORA
class OrchestratorService {
  #client;
  constructor(baseUrl, auth, limiter, defaultFolderId) {
    this.#client = new OrchestratorHttpClient(baseUrl, auth, limiter, defaultFolderId);
  }
}
```

O service não decide a URL nem o tipo de auth. **Recebe.** Quem manda é quem chama.

### Onde ocorre no nosso MCP (3 pontos)

**1. Composition root monta tudo** (`server.ts`):
```ts
const auth = UIPATH_PAT ? new BearerAuth(UIPATH_PAT) : new NoAuth();  // escolhe a peça
const limiter = rateLimiterFromEnv();                                  // cria a peça
const service = new OrchestratorService(BASE_URL, auth, limiter, ORG_UNIT_ID);  // INJETA
```

**2. Service injeta no client** (`orchestrator-service.ts`):
```ts
constructor(baseUrl, auth, limiter, defaultFolderId) {
  this.#client = new OrchestratorHttpClient(baseUrl, auth, limiter, defaultFolderId);
}
```

**3. Tools recebem o service** (cada `tools/*.ts`):
```ts
export function registerListFailedJobsTool(server, service) {  // service INJETADO
  // ... usa o service que recebeu, não cria um
}
```

Fluxo: tudo nasce em `server.ts` e é **empurrado pra dentro**. Nada se cria
sozinho no meio do caminho.

### Por que importa (3 razões concretas)

1. **Testável** (a maior). Os testes fazem
   `new OrchestratorService("http://x/orchestrator_", new NoAuth())` — injetam
   um auth fake + URL fake e stubam o `fetch`. Sem injeção, o service criaria
   `BearerAuth` real e bateria na API verdadeira → impossível testar offline.
2. **Trocável** (Strategy). `auth` é `BearerAuth` OU `NoAuth`, decidido no
   `server.ts`. Trocar PAT por OAuth = nova classe, injeta no root, service intacto.
3. **Explícito.** Todas as dependências aparecem no construtor
   `(baseUrl, auth, limiter, folder)`. Sem `new` escondido criando conexão surpresa.

> Frase-chave: **"não chame você, eu te chamo"** (Hollywood Principle). O objeto
> não vai buscar — recebe.

### Por que o client é criado DENTRO do service (e não no `server.ts`)?

Olhando o código, o `new OrchestratorHttpClient(...)` está no construtor do
service, não no composition root:

```ts
// service.ts — o service cria o próprio client
constructor(baseUrl, auth, limiter, defaultFolderId) {
  this.#client = new OrchestratorHttpClient(baseUrl, auth, limiter, defaultFolderId);
}
```

Pela DI **purista**, o client deveria ser criado no `server.ts` e injetado
pronto (`new OrchestratorService(client)`). Aqui é uma **escolha de trade-off**:

- **Por quê assim:** o client é detalhe INTERNO do service — ninguém além dele
  usa. Esconder a criação dentro do service deixa o `server.ts` mais limpo (não
  precisa conhecer o client) e a assinatura do service mais simples (recebe as
  peças brutas `baseUrl/auth/limiter`, não um client já montado). Menos cerimônia.
- **O custo:** DI **parcial** — o service ainda cria UMA coisa. Por isso os
  testes stubam o `fetch` global em vez de injetar um client fake:
  ```ts
  new OrchestratorService("http://x/orchestrator_", new NoAuth());
  globalThis.fetch = stub(...);   // mocka o nível mais baixo (HTTP)
  ```
  Com DI total seria `new OrchestratorService(fakeClient)` — mais limpo, mas mais
  cerimônia no root.

Nenhum dos dois é errado. O template optou pelo pragmático ("DI boa o
suficiente"); os testes provam que funciona. Se um dia o client ganhar variações
(HTTP, cache, mock), aí compensa puxar a criação pro root e injetar.

**Paralelo REFramework:** é como um `Process.xaml` que recebe `in_Config`
injetado (DI), mas lá dentro ele mesmo dá `Invoke` num sub-workflow auxiliar
fixo. O Config vem de fora (injetado), mas o sub-workflow interno é criado/
chamado pelo próprio Process. Não é "errado" — só não é injeção até o último
nível. O service aqui faz igual: recebe as peças injetadas, mas monta o client
(seu "sub-workflow") por conta própria.

---

## 6. Paralelo completo com UiPath REFramework

Se você vem de RPA/UiPath, já fazia tudo isto sem o nome de software.

### Init All Settings = Composition Root

| REFramework | Nosso MCP |
|-------------|-----------|
| `InitAllSettings` | `server.ts` |
| lê `Config.xlsx` (Settings, Constants, Assets) | lê `process.env` (UIPATH_PAT, BASE_URL...) |
| monta o `Config` dictionary UMA vez | monta `auth`, `limiter`, `service` UMA vez |
| resto do framework recebe `Config` pronto | resto recebe `service` pronto |
| credencial vem de Asset (não hardcoded) | PAT vem do env (não hardcoded) |

Init All Settings **é** o composition root do REFramework: um ponto de montagem,
no início, e o resto só consome.

### Main.xaml = index.ts + server.ts (entrada + montagem)

`index.ts` é o ponto de entrada (o que `node` roda primeiro) — bate com o
Main.xaml ser o que o robô executa primeiro. Mas Main.xaml é **gordo**: ele
arranca, monta config (chama Init), roda a state machine e orquestra o loop. O
nosso código **divide** isso em dois:

| REFramework | Nosso MCP | Papel |
|-------------|-----------|-------|
| Main.xaml — parte "arranca o robô" | **index.ts** | só liga o transporte (stdio) |
| Main.xaml — parte "Init + monta tudo" | **server.ts** | composition root (config/auth/service, registra tools) |

```ts
// index.ts INTEIRO (resumido) — só dá a partida, não orquestra nada:
const transport = new StdioServerTransport();
await server.connect(transport);   // "abre a porta de comunicação" e liga
```

Por que dividir: dois motivos de mudança diferentes →

- **index.ts** muda se trocar o TRANSPORTE (stdio → HTTP). Só isso.
- **server.ts** muda se trocar o que é MONTADO (nova tool, novo auth).

Analogia: Main.xaml = ligar o carro E configurar o GPS E dirigir, tudo num
arquivo. Aqui: **index.ts = girar a chave** (partida), **server.ts = configurar
GPS/bancos antes de sair** (montar tudo), tools/service = dirigir (a lógica).

Resumo: **Main.xaml ≈ index.ts (partida) + server.ts (Init/wiring) juntos.** O
index é só a menor parte (arrancar); o miolo "montar" do Main é o server.ts.

### Argumentos de workflow = Injeção de dependência

O workflow `Process.xaml` não cria o Config — recebe `in_Config`. Não sabe de
onde veio (o Init montou). Só usa e foca na lógica. Idêntico ao service receber
`(baseUrl, auth, limiter)` e só orquestrar.

Nuance: argumentos de workflow misturam 2 coisas que no código separamos —

```
in_Config (longa vida, montado no Init)   = DI clássica   → new Service(baseUrl, auth, limiter)
in_TransactionItem (muda por iteração)    = parâmetro      → service.explainFailure(jobKey, folderId)
```

DI = peças montadas uma vez e reusadas. Parâmetro = o dado específico de cada
execução. Workflow args carregam os dois; no código ficam em lugares diferentes
(construtor vs método).

### Peças separadas vs `in_Config` único

Uma distinção fina. No REFramework, `in_Config` é **um dicionário só** (tudo
dentro). No nosso `server.ts` passamos **peças separadas e tipadas**, não um
objeto `config` único:

```ts
// Nosso jeito — peças separadas (mais type-safe)
const service = new OrchestratorService(BASE_URL, auth, limiter, ORG_UNIT_ID);

// Estilo REFramework ao pé da letra — um "config" só
const config = { baseUrl, auth, limiter, orgUnitId };  // = in_Config dictionary
const service = new OrchestratorService(config);
```

Trade-off:

- **Peças separadas (nosso):** o construtor mostra EXATAMENTE o que o service
  precisa; o compilador checa cada uma. Mais explícito e seguro.
- **Dicionário `in_Config` (REFramework):** mais flexível, mas você perde a
  checagem — precisa saber as chaves certas na mão (`Config("BaseUrl").ToString`)
  e um erro de digitação só aparece em runtime.

Ambos são DI válida — mesma filosofia ("recebe pronto de fora"), forma
diferente. O `server.ts` "carrega o config e já passa url/auth/etc. pro service"
exatamente como o Init monta o `Config` e o passa pro `Process.xaml`.

### `Get Transaction Data` = infrastructure (mas só a parte de BUSCAR)

`infrastructure` é a única parte que pega dados externos — igual o
`Get Transaction Data` ser o ponto que busca a transação no Orchestrator/fila/
sistema externo. A essência bate.

**Afinação importante da fronteira:** `Get Transaction Data` no REFramework
mistura 2 coisas —

1. **buscar** o dado (pega queue item / lê Excel / chama API) → isto é **infrastructure**
2. **decidir/montar** o `TransactionItem`, e depois o `Process.xaml` processa → isto é **application**

No nosso MCP esses dois ficam separados e nítidos:

```
BUSCAR (infrastructure)          DECIDIR / PROCESSAR (application)
─────────────────────            ────────────────────────────────
orchestrator-http-client.ts      orchestrator-service.ts
  getJobByKey()                    explainFailure() — busca job+logs,
  getJobLogs()                     escolhe o erro principal, monta o resumo
  fetch() cru, devolve cru         a INTELIGÊNCIA do que fazer com o dado
```

Infrastructure **só traz o dado cru** ("aqui está o job, aqui estão os logs").
Não decide nada. O que FAZER com isso (correlacionar, filtrar, agrupar) =
application.

| REFramework | Nosso MCP | O que faz |
|-------------|-----------|-----------|
| invoke que lê fila/API dentro do `Get Transaction Data` | **infrastructure** (`http-client`) | só BUSCA o dado cru |
| montar o `TransactionItem` + `Process.xaml` | **application** (`service`) | DECIDE e PROCESSA |

Mental fino: **infrastructure = "o braço que estende pra fora e traz".** Não
pensa, não decide. Só busca e entrega cru pra application pensar. No REFramework
essa fronteira (buscar vs processar) é borrada; no código ela é limpa.

### Quem faz o HTTP: o service PEDE, o client EXECUTA

Distinção fina mas que mantém a fronteira limpa: **o `fetch` (HTTP de verdade)
acontece SÓ no client (infrastructure).** O service NÃO faz HTTP — ele chama um
*método* do client, e esse método é que faz o fetch lá dentro.

```
service:  await this.#client.getJobByKey(key)   ← chama um MÉTODO (não vê HTTP)
              │
client:     fetch(`${baseUrl}/odata/Jobs...`)    ← o HTTP real mora SÓ aqui
```

O service "pede o dado" ao client. Não sabe que é HTTP — podia ser banco,
arquivo, gRPC. Essa ignorância é de propósito (encapsulamento + camadas): se o
service soubesse de URL/fetch, a fronteira vazaria.

Resumindo a divisão de trabalho:

```
infrastructure (client)          application (service)
─────────────────────            ─────────────────────
SÓ HTTP / fetch / OData          regra de negócio
busca dado CRU                   limpa, organiza, agrupa
1 endpoint → 1 método            encadeia N chamadas do client
devolve cru                      entrega output PRONTO
não pensa                        a inteligência
EXECUTA                          PEDE / orquestra
```

Exemplos reais no service: `summarize_incidents` (agrupa jobs falhos por
processo), `explain_failure` (busca job + logs, correlaciona, monta resumo),
`get_folder_overview` (4 chamadas em paralelo, consolida). Em todos, o client só
trouxe os pedaços crus; a inteligência é do service.

> Frase certa: ~~"o service faz a chamada HTTP"~~ → **"o service chama o client,
> que faz o HTTP"**.

### Mapa completo

| REFramework | Nosso MCP | Conceito |
|-------------|-----------|----------|
| Init All Settings | `server.ts` | Composition Root |
| `in_Config` injetado | `auth`/`limiter` injetados | Dependency Injection |
| `Config.xlsx` / Assets | `process.env` | config externalizada |
| workflow só com lógica | service só com lógica | Single Responsibility |
| `Get Transaction Data` separado do Process | `infrastructure` (busca) separado de `application` (lógica) | separação de camadas |
| `SetTransactionStatus` (Business vs System exception) | `#assertOk` (erro de domínio nomeado) | erro estruturado |
| invoke workflow por nome | `register...(server, service)` por arquivo | composição modular |
| `Try/Catch` + retry no Process | `try/catch` → `isError` + token bucket | resiliência |

O REFramework é Clean Architecture aplicada a RPA: Init=root, Config=DI,
workflows=SRP, Get-Transaction/Process separados=camadas. A intuição que você já
tem de RPA transfere direto — só faltava o vocabulário de software.

---

## 7. Encapsulamento

### O que é

**Encapsulamento = esconder o "como" por trás de um "o quê".** O objeto expõe o
que faz (interface pública) e esconde como faz (detalhes internos). Quem usa não
precisa — nem consegue — mexer nas tripas.

Analogia: no carro você usa volante, pedal, chave. Não mexe na injeção
eletrônica nem no timing da ignição. O "como o motor funciona" está
encapsulado — escondido atrás de uma interface simples. Você dirige sem ser
engenheiro mecânico. Se o painel expusesse 200 fios do motor, qualquer um
mexeria errado e quebraria.

### No nosso MCP

**1. Campos `#private`** (`infrastructure/orchestrator-http-client.ts`) — o `#`
do JS torna o campo/método inacessível de fora:

```ts
class OrchestratorHttpClient {
  #baseUrl; #auth; #limiter; #defaultFolderId;   // privados — ninguém de fora lê
  #request(...) { }    // método interno
  #assertOk(...) { }   // interno
  // SÓ estes são a "porta" pública:
  async listFailedJobs(...) { }
  async getJobByKey(...) { }
}
```

O service chama `client.listFailedJobs()` (a porta). NÃO consegue tocar
`client.#baseUrl` nem `client.#assertOk()` — são tripas.

**2. O service esconde o client inteiro** — as tools chamam
`service.explainFailure()` e não sabem que por baixo existe um
`OrchestratorHttpClient`, OData, `fetch`. Tudo encapsulado.

**3. A cadeia toda é encapsulamento em camadas:**

```
agente    → vê só nomes de tools          (não sabe que existe service/client/OData)
tool      → vê só service.explainFailure() (não sabe como o service correlaciona)
service   → vê só client.getJobByKey()     (não sabe do $filter/headers/fetch)
client    → esconde tudo de HTTP
```

Cada camada esconde a de baixo. Quem está em cima só vê a porta, nunca as tripas.

### Por que importa

1. **Troca segura** — mudar o `#assertOk` ou o `$filter` interno não quebra
   ninguém de fora (ninguém depende deles).
2. **Menos erro** — impossível setar `client.#baseUrl` errado no meio do código;
   não há acesso.
3. **Simplicidade pra quem usa** — a tool vê `service.explainFailure(jobKey)`,
   não 5 chamadas HTTP + correlação.

### Paralelo REFramework / UiPath

| UiPath / REFramework | Conceito |
|----------------------|----------|
| **variáveis internas** de um workflow (não são argumentos) | campos `#private` — invisíveis de fora |
| **argumentos `in_`/`out_`** (a porta do workflow) | métodos públicos — o contrato |
| **invoke `Process.xaml`** sem abrir pra ver o que tem dentro | chamar `service.explainFailure()` sem saber do HTTP |
| **`Config` dictionary** — você usa `Config("X")`, não sabe se veio de Excel ou Asset | service esconde de onde/como busca |

**O paralelo mais direto — variáveis vs argumentos:** quando você monta um
workflow e decide "isto vira argumento (porta), isto fica variável interna
(tripa)", você JÁ está encapsulando. Argumentos `in_`/`out_` = a interface
pública (como outros workflows falam com ele). Variáveis internas = detalhe que
ninguém de fora vê. É a mesma decisão de `public` vs `#private`.

**Invoke é consumir algo encapsulado:** quando você dá `Invoke Workflow File`,
passa argumentos e recebe resultado sem abrir o workflow pra ver as tripas.
Confia na interface. Igual a tool chamar `service.explainFailure()` sem saber
que lá dentro tem fetch + OData + correlação.

### Como conversa com o resto

Encapsulamento **habilita** os outros conceitos: as **camadas** só funcionam
porque cada uma esconde a de baixo; a **DI** injeta pela porta (construtor) e o
resto fica escondido; o **client privado dentro do service** (visto na seção 5)
é encapsulamento puro.

> Resumo: **esconder o "como", expor só o "o quê".** `#private` = tripas;
> métodos públicos = a porta. No REFramework: variáveis internas = privado;
> argumentos `in_/out_` = porta pública. Invocar um workflow sem abri-lo é
> confiar na interface — consumir algo encapsulado.

---

## 8. Como evoluímos das aulas: auth e rate-limit

Este MCP nasceu do template, que foi destilado das aulas 06/07 (o MCP de
`customers` + uma API Fastify de exemplo). A BASE veio dali; dois pontos
evoluíram bastante por causa do UiPath. Entender a diferença ajuda a ver *por
que* o código ficou como ficou.

### 8.1. Auth — service-token (aula) vs PAT (nosso)

**Na aula**, o token é **emitido pelo backend via login**. Os testes fazem:

```ts
// aula 07 — tests/helpers.ts
const res = await fetch(`${API_URL}/auth/service-token`, {
  method: 'POST',
  body: JSON.stringify({ username: 'erickwendel', password: '123123', adminSuperSecret: '...' }),
})
const { serviceToken } = await res.json()   // backend EMITE o token após login
```

E o client da aula monta o header **direto** (string → Bearer):

```ts
// aula 07 — customer-http-client.ts
constructor(baseUrl: string, serviceToken: string) {
  this.authHeaders = { Authorization: `Bearer ${serviceToken}` };   // cravado, sem abstração
}
```

**No nosso**, o token (PAT) **já existe** — criado no portal UiPath, colado no
env. Não há endpoint de login. E o auth é abstraído com **Strategy**
(`AuthProvider` / `BearerAuth` / `NoAuth`), injetado.

| | Aula (customers) | Nosso (UiPath) |
|---|---|---|
| Origem do token | gerado em runtime (POST `/auth/service-token` com user/senha) | pré-existente (PAT do portal), via env |
| Quem cria | o backend, sob demanda (login) | você, manual, antes |
| Estrutura no código | header montado **direto no client** (string) | **Strategy** (`AuthProvider` injetado) |
| Trocar de auth | edita o client | troca a classe injetada, client intacto |
| Sem token | quebra | cai pra `NoAuth` (dev) |

**Por que evoluímos:** UiPath usa PAT/OAuth, não user+senha→token — por isso o
nosso `tests/helpers.ts` **removeu** o `getServiceToken()`. E o Strategy deixa
trocar PAT→OAuth amanhã sem tocar no client (a aula cravava a string no client).
O que herdamos igual: o `#assertOk` mapeando 401→Unauthorized, 403→Forbidden,
429→RateLimit, e o `domain/errors.ts` (veio quase idêntico).

### 8.2. Rate-limit — backend (aula) vs client-side (nosso)

Aqui está a diferença GRANDE. **Lados opostos da conexão.**

**Na aula, o rate-limit mora no BACKEND** (a API Fastify, não o MCP):

```js
// aula 07 — nodejs-fastify-mongodb-crud-z/src/auth.js (a API)
export const rateLimitOptions = { max: REQUESTS_PER_MINUTE, timeWindow: '1 minute', /* ... */ }
// index.js:
await fastify.register(fastifyRateLimit, rateLimitOptions)   // plugin NO SERVIDOR
```

O **MCP da aula não tem rate-limiter** — ele só **reage** ao 429 que o backend
devolve (`#assertOk` → `RateLimitError`).

**No nosso, o rate-limit é CLIENT-SIDE** — um token bucket DENTRO do MCP
(`middleware/rate-limiter.ts`), que gasta um token antes de cada `fetch`:

```ts
// nosso — orchestrator-http-client.ts
this.#limiter?.take();   // throws RateLimitError se vazio — ANTES de bater na rede
return fetch(...)
```

E também tratamos o 429 do backend (igual a aula). Dois guardas.

| | Aula 07 | Nosso MCP |
|---|---|---|
| Rate-limit DENTRO do MCP? | **não** | **sim** (token bucket) |
| Rate-limit no backend | sim (`@fastify/rate-limit`) | sim (Orchestrator tem o dele) |
| MCP trata o 429? | sim (`#assertOk`) | sim (igual) |
| Barra ANTES da rede? | não | **sim** (`limiter.take()`) |
| Config | `REQUESTS_PER_MINUTE` no servidor | `RATE_LIMIT_BURST`/`PER_SEC` no env do MCP |

**Por que evoluímos:**

1. **Não controlamos o backend.** Na aula o Fastify era *dele* — dava pra pôr o
   limit lá. O Orchestrator é da UiPath; o limit é fixo deles, você não mexe.
2. **Agente em loop é perigoso.** Um agente de IA pode chamar uma tool 100×/seg
   sem querer. O token bucket no MCP barra ANTES de martelar a API da UiPath —
   mais rápido (não espera a rede) e protege a cota do teu tenant.
3. **Defense in depth.** Guarda client-side + 429 do backend tratado. Dois níveis.

Como diz o `PATTERNS.md` do template: *"rate-limit client-side é guarda, não
fonte da verdade"*. O backend (Orchestrator) é a verdade; o nosso bucket é
proteção adicional.

### Resumo da evolução

```
                     AULA 06/07                  NOSSO MCP
auth: origem         login → backend emite       PAT pré-existente (env)
auth: estrutura      string cravada no client    Strategy (AuthProvider injetado)
rate-limit: onde     no BACKEND (Fastify)         no MCP (token bucket) + trata 429
herdado igual        #assertOk, errors.ts, shape de tool, camadas
```

A aula ensinou a base (Bearer, mapear 401/403/429, camadas, shape). Adaptamos
auth e rate-limit ao mundo real do UiPath: token externo + Strategy, e proteção
client-side porque o backend não é nosso.

---

## Próximo passo

Com esses conceitos firmes, leia o `ARCHITECTURE.md` — agora cada seção técnica
(fluxo, regras das tools, patterns) vai fazer sentido imediato, sem precisar das
analogias.
