# Architecture — UiPath Orchestrator MCP

Referência técnica da arquitetura deste MCP — estrutura, fluxo, regras e gotchas.
Assume familiaridade com Clean Architecture e MCP.

> **Novo nos conceitos?** Material didático (camadas explicadas do zero, injeção
> de dependência, encapsulamento, transporte, paralelos com UiPath/REFramework)
> está em `LEARNING.md`. Aqui é só a referência seca.

---

## 1. O que é, em uma frase

**Adaptador fino** entre um agente de IA e a API REST do UiPath Orchestrator.
Traduz "intenção do modelo" → "chamada OData" → "resposta legível pro modelo".

```
[agente IA] ⇄ MCP (stdio/JSON-RPC) ⇄ este MCP ⇄ HTTPS ⇄ Orchestrator
```

---

## 2. Os 3 primitivos MCP

| Primitivo | Quando | Quem chama | Temos |
|-----------|--------|-----------|-------|
| **Tool** | modelo faz algo (computa/efeito) | o modelo, no loop | 14 |
| **Resource** | contexto read-only, sem gastar tool call | app/usuário anexa | 2 (`api-info`, `glossary`) |
| **Prompt** | workflow templado reutilizável | usuário dispara | 2 (`triage`, `daily-report`) |

Mnemônico: **Tool = verbo. Resource = substantivo de leitura. Prompt = receita.**

---

## 3. Camadas (Clean Architecture)

Regra de ouro: **dependência sempre aponta pra DENTRO.**

```
mcp  →  application  →  infrastructure  →  domain
(fora)                                      (núcleo)
```

| Camada | Pasta | Responsabilidade | Importa | NUNCA importa |
|--------|-------|------------------|---------|---------------|
| **domain** | `domain/` | schemas Zod, tipos, erros, interface auth | nada | ninguém |
| **infrastructure** | `infrastructure/` | ÚNICO lugar com `fetch`/HTTP; mapeia status→erro | domain | application, mcp |
| **application** | `application/` | regra de negócio, orquestração (service) | domain, infra | mcp |
| **mcp** | `mcp/` | server + tools/resources/prompts + middleware | todas | — |
| **index.ts** | raiz | só o transporte (stdio) | mcp | — |

**Por que importa:** o `domain` não sabe que existe HTTP, nem MCP. Dá pra trocar
Orchestrator por gRPC, ou stdio por HTTP, sem tocar no núcleo.

> Camadas explicadas do zero (analogia, "domain = contratos", nomes alternativos,
> qual evitar): `LEARNING.md` §1–3.

### Mapa de arquivos por camada

```
domain/
  orchestrator.ts   ← TODOS os schemas Zod + tipos (Job, QueueItem, FailureExplanation...)
  errors.ts         ← UnauthorizedError, ForbiddenError, RateLimitError
  auth.ts           ← interface AuthProvider + BearerAuth + NoAuth

infrastructure/
  orchestrator-http-client.ts  ← TODO o fetch, OData, unwrap {value}, #assertOk

application/
  orchestrator-service.ts      ← lógica: agrupar, baselines, correlacionar, multi-call

mcp/
  server.ts                    ← composition root (monta tudo)
  middleware/rate-limiter.ts   ← token bucket
  tools/*.ts                   ← 1 arquivo por tool
  resources/*.ts               ← api-info, glossary
  prompts/*.ts                 ← triage, daily-report

index.ts                       ← transporte só
```

### A pasta `mcp/` na Clean Architecture

`mcp/` é a camada **mais externa** — apresentação / interface adapters.

```
        ┌─────────────────────────────────────┐
        │  mcp/  ← a mais externa (apresentação)│
        │   ┌─────────────────────────────┐    │
        │   │  application/ (service)     │    │
        │   │   ┌─────────────────────┐   │    │
        │   │   │ infrastructure/     │   │    │
        │   │   │   ┌─────────────┐   │   │    │
        │   │   │   │  domain/    │   │   │    │
        │   │   │   └─────────────┘   │   │    │
        │   │   └─────────────────────┘   │    │
        │   └─────────────────────────────┘    │
        └─────────────────────────────────────┘
```

| Subpasta | Papel | O que é |
|----------|-------|---------|
| **server.ts** | Composition Root / Main | monta deps + registra tudo |
| **tools/** | Interface Adapter / Controller | traduz pedido do agente → `service.x()` → resposta |
| **resources/** | Interface Adapter | idem, read-only |
| **prompts/** | Interface Adapter | idem, workflow templado |
| **middleware/** | Cross-cutting | rate-limiter (transversal) |

`mcp/` é o **driving adapter** (input externo entra); `infrastructure/` é o
**driven adapter** (núcleo chama o externo). Ambos na borda, sentidos opostos:

```
agente →→ [mcp/ ENTRADA] →→ application →→ [infrastructure/ SAÍDA] →→ Orchestrator
          (driving)                         (driven)
```

---

## 4. Fluxo da informação (uma chamada, ponta a ponta)

Agente chama `list_failed_jobs`:

```
1. agente → JSON-RPC pela stdin
2. index.ts (StdioServerTransport) recebe, passa pro server
3. server.ts roteia pro handler registrado de "list_failed_jobs"
4. tools/list-failed-jobs.ts (HANDLER FINO):
     valida input (Zod) → chama service.listFailedJobs(...) → try/catch formata
5. application/orchestrator-service.ts: aplica regra (default 24h) → chama client
6. infrastructure/orchestrator-http-client.ts:
     monta $filter OData → #request (rate-limit + headers auth/folder) → fetch()
     → #assertOk (401→Unauthorized, 403→Forbidden, 429→RateLimit) → unwrap {value}
7. volta subindo: client → service → handler
8. handler monta { content:[{text}], structuredContent:{jobs, count} }
9. server → index.ts → JSON-RPC pela stdout → agente
```

**Regra crítica:** stdout É o canal do protocolo. `console.log` corromperia o
JSON-RPC → todo log vai em `console.error` (stderr).

> Transporte explicado do zero (stdio/stdout/stderr/JSON-RPC, stdio vs HTTP):
> `LEARNING.md` §4.

---

## 5. Anatomia de uma tool

Toda tool segue o MESMO molde — uma **ficha de cadastro + handler fino**:

```ts
export function registerListFailedJobsTool(server, service) {
  server.registerTool(
    "list_failed_jobs",                    // nome snake_case, verbo primeiro
    {
      description: "...quando chamar...",  // única dica pro modelo decidir
      inputSchema: { since, top, folderId },  // Zod, cada campo .describe()
      outputSchema: OrchestratorResultSchema.shape,  // WIDE (success + erro)
    },
    async ({ since, top, folderId }) => {
      try {
        const jobs = await service.listFailedJobs(since, top, folderId);  // DELEGA
        return {
          content: [{ type: "text", text: JSON.stringify(jobs) }],
          structuredContent: { jobs, count: jobs.length },
        };
      } catch (err) {
        const message = `Failed to ... ${...}`;
        return {
          content: [{ type: "text", text: message }],
          structuredContent: { isError: true, message },   // RETORNA, não lança
        };
      }
    },
  );
}
```

**4 regras inquebráveis:**

1. **Handler fino** — chama service, formata, captura. Zero lógica de negócio
   (a inteligência vive no service; a tool só delega + formata + captura).
2. **Shape de retorno fixo** — `content[]` (texto pro LLM) + `structuredContent`.
3. **Erro = retorno, não throw** — `isError: true` + message legível.
4. **outputSchema WIDE** — `OrchestratorResultSchema` declara TODAS as chaves
   (success E erro), senão o SDK rejeita: `data must NOT have additional properties`.

O handler é fino porque é um **controller**: recebe input externo, traduz, chama
o caso de uso, traduz a resposta. `inputSchema`/`outputSchema`/`description` =
a interface; `service.x()` = o trabalho real. Registrar a tool a deixa disponível
**pro agente** — o `server.ts` é quem chama cada `registerXTool`.

> Detalhamento didático de um arquivo de `tools/` + paralelo REFramework
> (assinatura + Invoke): `LEARNING.md` §6.

---

## 6. Os níveis de tool (a tese do MCP)

| Nível | Exemplo | O que faz | Por que existe |
|-------|---------|-----------|----------------|
| **Primitiva** | `list_failed_jobs`, `get_job_logs`, `get_queue_backlog`, `get_robot_health` | 1 GET, esconde OData | tijolos pro agente compor |
| **Manipulação** | `summarize_incidents`, `find_stuck_jobs`, `find_stalled_queue_items`, `get_throughput`, `find_folders` | 1-2 calls + lógica (grupo/baseline/sort/série) | conveniência que a API não dá pronta |
| **Multi-call (joia)** | `get_folder_overview`, `explain_failure`, `diagnose_queue_stall` | N calls correlacionadas | raciocínio que nenhum endpoint faz |

**Lição:** o valor concentra nas joias. Primitivas são tijolos necessários, não
"inteligência". O UiPath nativo (Insights/alerts) já faz muito — o diferencial
deste MCP é tudo ser consumível por um **agente**, com correlação e
resolução-por-nome.

---

## 7. Patterns aplicados

| Pattern | Onde | Por quê |
|---------|------|---------|
| **Composition Root** | `server.ts` | único lugar que monta deps (`config→auth→limiter→service`). Declarativo. |
| **Dependency Injection** | service recebe `(baseUrl, auth, limiter, folder)`; tools recebem `(server, service)` | testável, sem singleton escondido |
| **Strategy** | `AuthProvider` (`BearerAuth`/`NoAuth`) | troca auth sem tocar no client |
| **Adapter** | `orchestrator-http-client.ts` | isola backend; trocar HTTP→gRPC sem mexer no resto |
| **Factory por arquivo** | `registerXTool(server, service)` | 1 tool/arquivo, composição explícita |
| **Token Bucket** | `middleware/rate-limiter.ts` | rate-limit client-side previsível |
| **Error Translation** | `#assertOk` | HTTP→erro de domínio nomeado → mensagem legível |
| **Encapsulamento** | campos `#private` no client/service | esconde tripas; expõe só a "porta" pública |

> DI e encapsulamento explicados do zero (analogias, por que importam, por que o
> client é criado no service, paralelos REFramework): `LEARNING.md` §5 e §7.
> Paralelo completo Clean Arch ↔ REFramework: `LEARNING.md` §6.

---

## 8. Segurança (3 camadas)

1. **Auth via env** — `UIPATH_PAT` nunca hardcoded. `BearerAuth` injeta
   `Authorization: Bearer`. Sem token → `NoAuth` (dev, 401 garantido).
2. **Rate-limit client-side** — token bucket no MCP guarda o Orchestrator ANTES
   da rede. Backend 429 também mapeado. É guarda, não fonte da verdade.
3. **Erro nomeado** — 401→`UnauthorizedError`, 403→`ForbiddenError`,
   429→`RateLimitError`. A tool expõe via `isError + message`.

Princípio do menor privilégio: PAT read-only reforça o design read-only do MCP.

---

## 9. Folder scoping híbrido

```ts
#folderHeader(folderId?) {
  const id = folderId ?? this.#defaultFolderId;   // arg vence, senão env
  return id ? { "X-UIPATH-OrganizationUnitId": id } : {};
}
```

- env `ORG_UNIT_ID` = default (caso comum, config simples)
- tool `folderId` opcional sobrescreve (dinâmico)
- usuário NUNCA digita id → `find_folders` resolve nome→id

Esconde a complexidade do Orchestrator do agente — o trabalho do adapter.

---

## 10. Stack e por que "no build"

- Node ≥22.6, **TS nativo** (`--experimental-strip-types`) — roda `.ts` direto,
  sem compilar.
- `@modelcontextprotocol/sdk` + Zod + stdio + `node:test`.
- Sem build = ótimo pra local/dev (atrito pra publicar no npm).

Gotcha: **sem `constructor(private x)`** (o modo strip-only rejeita). Por isso
campos `#private` + atribuição no corpo.

---

## 11. Como tudo se conecta (visão de cima)

```
                    index.ts  (transporte stdio)
                        │
                    server.ts  (composition root)
              ┌─────────┼─────────────────┐
           tools/    resources/        prompts/
              │
        orchestrator-service.ts  (lógica, multi-call, agregação)
              │
        orchestrator-http-client.ts  (ÚNICO fetch, OData, #assertOk)
              │            │
          domain/      ←───┘
        (schemas, errors, auth — núcleo, zero deps)
```

---

## 12. Resumo de uma frase por camada

- **domain** = a verdade (o que as coisas são)
- **infrastructure** = como falar com o mundo (HTTP)
- **application** = a inteligência (o que fazer com os dados)
- **mcp** = a porta pro agente (como expõe)
- **index** = liga a porta (transporte)

---

## 13. Como rodar / conectar

- **Inspecionar tools sem cliente:** `npm run mcp:inspect`
- **Testes:** `npm test` (unit stuba `fetch`; e2e roda só com `UIPATH_*` setado)
- **VS Code:** abrir esta pasta como workspace → reconhece `.vscode/mcp.json`
- **LangGraph.js:** `@langchain/mcp-adapters` → `MultiServerMCPClient` (transport
  `stdio`, `command: node`, args apontando pro `src/index.ts` com path absoluto)
- **Não precisa estar "no ar":** stdio = o agente spawna o MCP como subprocesso
  local sob demanda; sem porta, sem deploy.

---

## Docs relacionados

- `README.md` — uso, tools, config (operacional)
- `LEARNING.md` — conceitos do zero + paralelos UiPath/REFramework (didático)
- `VALIDATION.md` — checklist de validação contra tenant real
- `../mcp-template/PATTERNS.md` — regras e checklist de PR do template
