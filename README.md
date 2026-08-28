# CrowdOS 

![CrowdOS Banner](assets/banner.png)

> **Operating system for collective intelligence.**

CrowdOS is a provider-agnostic sandbox for building, orchestrating, and governing hierarchical AI agent ecosystems.

Instead of treating AI as a single assistant, CrowdOS treats intelligence as a structured society of specialized entities capable of collaboration, delegation, reasoning, execution, and self-organization.

Built around a Discord-inspired interaction model, CrowdOS enables users to create persistent AI workspaces with channels, roles, hierarchy, memory scopes, governance systems, and collaborative agent communities.

---

## Philosophy

Most AI systems today are built around a single-agent interaction model.

CrowdOS explores a different idea:

> intelligence emerges through coordination.

Instead of one monolithic assistant handling everything, CrowdOS enables structured ecosystems where agents operate as collaborative entities inside programmable social environments.

The platform is designed around:

* collective intelligence
* hierarchical orchestration
* instruction-first architecture
* governance-driven systems
* persistent agent societies
* provider-agnostic execution
* observability and delegation transparency

---

# Why CrowdOS Exists

Most multi-agent frameworks today are:

* workflow-centric
* graph-heavy
* YAML-driven
* CLI-oriented
* developer-only environments

CrowdOS takes a different approach.

Rather than building another orchestration pipeline, CrowdOS introduces:

> a social-native operating environment for AI ecosystems.

Inspired by familiar collaborative platforms like Discord, CrowdOS lowers the interaction barrier between humans and autonomous agent systems.

Users interact through:

* workspaces
* categories
* channels
* mentions
* permissions
* delegation chains
* organizational structures

Instead of writing orchestration graphs manually.

---

# Core Concepts

## Governance Intelligence (Lv0)

At the center of CrowdOS is the Lv0 governance layer.

Lv0 agents are not traditional assistants.

They function as:

* ecosystem architects
* orchestration governors
* workspace administrators
* organizational intelligence systems

Responsibilities include:

* creating agent profiles
* managing hierarchy
* assigning permissions
* organizing channels and categories
* installing tools and MCP integrations
* generating instructions and skills
* arranging context and memory scopes
* coordinating delegation systems

CrowdOS treats orchestration itself as an intelligent capability.

---

## Hierarchical Agent Architecture

CrowdOS separates intelligence by responsibility and computational cost.

### Raven — Lv0–1

High-level reasoning and strategic intelligence.

Used for:

* planning
* architecture
* governance
* coordination
* complex reasoning

These agents operate in focused reasoning councils called:

## Conspiracy

A Conspiracy is a coordinated high-context reasoning group designed for deliberate and intelligence-dense collaboration.

---

### Crow — Lv2–3

Lightweight execution-oriented operational agents.

Optimized for:

* parallel execution
* summarization
* scraping
* classification
* transformation
* distributed workloads

Large-scale operational swarms are called:

## Murder

A Murder is a distributed execution swarm designed for scalable coordinated workloads.

---

# Discord-Native UX

CrowdOS is intentionally built around a social workspace metaphor.

The platform uses familiar collaborative structures:

```text
Workspace
 ├── Categories
 │    ├── Channels
 │    │    ├── Human Users
 │    │    ├── Specialist Agents
 │    │    └── Worker Swarms
```

This creates a more intuitive interaction model compared to traditional orchestration systems.

Users can:

```text
@ResearchLead analyze this paper
```

instead of writing complex orchestration logic manually.

---

# Observability First

CrowdOS emphasizes transparent orchestration and delegation visibility.

Users should be able to observe:

* delegation chains
* active reasoning flows
* swarm activity
* task routing
* token allocation
* provider utilization
* hierarchy interactions

Example:

```text
@Architect
 └── delegated to @BackendSpecialist
      └── delegated to @APIWorker
           └── delegated to @ValidationWorker
```

The goal is to make collective intelligence visible.

---

# Instruction-First Architecture

CrowdOS exposes behavioral governance directly to users.

Instead of relying entirely on hidden system prompts, agents are shaped through explicit natural-language instructions.

Users can:

* define organizational behavior
* customize hierarchy
* create governance rules
* design collaboration patterns
* generate specialized agent ecosystems

This improves:

* transparency
* experimentation
* reproducibility
* adaptability
* debugging

---

# Provider Agnostic

CrowdOS is designed to work across multiple providers and execution environments.

Possible providers include:

* OpenAI
* Anthropic
* Gemini
* DeepSeek
* local models
* future inference providers

This enables hybrid intelligence allocation strategies such as:

```text
Lv0 → frontier reasoning model
Lv1 → advanced specialist model
Lv2 → optimized orchestration model
Lv3 → lightweight low-cost workers
```

The platform prioritizes flexibility over lock-in.

---

# Example Use Cases

## Software Engineering

* autonomous dev teams
* architecture planning
* review swarms
* testing ecosystems
* documentation pipelines

## Research

* source collection
* summarization
* contradiction analysis
* citation verification
* collaborative reasoning

## Data Engineering

* scraping swarms
* cleaning pipelines
* distributed processing
* classification systems

## Learning Environments

* tutoring systems
* curriculum planning
* Socratic learning agents
* collaborative study ecosystems

## Simulations & Roleplay

* DnD ecosystems
* AI civilizations
* autonomous factions
* narrative societies
* persistent simulation worlds

---

# Technical Direction

Current architectural direction (implemented through Remediation Spec Phases 0–7):

## Frontend

* React 19 + TypeScript + TailwindCSS v4 + Zustand + Socket.io
* Workspace shell with 3-panel layout + mobile drawers, diff viewer, approval cards, delegation timeline, virtualized paginated history, omni-search

## Backend

* Node.js + Fastify 5 + TypeScript + Drizzle ORM + Postgres 16
* EventBroker with durable_events (ordered, replayable, idempotent) + run state machine (17 states) + context pipeline (10 middlewares, parallel lane)
* 4 provider adapters (OpenAI/Anthropic/Google/Ollama/Custom) with real token accounting + model routing (MODEL-1)

## Infrastructure

* PostgreSQL 16 (primary) + Redis 7 + BullMQ 6 (durable execution since Phase 4 — `QUEUE_MODE=bullmq` with `api` + `worker` processes, repeatable maintenance jobs, 3× exponential backoff, 7d DLQ, graceful drain)
* WebSockets (Socket.io) with per-socket token bucket rate limiting + room isolation
* Docker Compose with `api` + `worker` + health checks (see `docker-compose.yml`)

---

# Design Principles

CrowdOS prioritizes:

* modular orchestration
* realtime collaboration
* observability
* rapid iteration
* adaptive governance
* ecosystem flexibility

The platform intentionally avoids premature infrastructure complexity during early development stages.

---

# Current Status

CrowdOS has completed Remediation Spec Phases 0–7 (46 days, see `REMEDIATION_SPEC.md`). Durable, observable, and resumable execution is now real — not prototype.

| Phase | What shipped | Flag |
|---|---|---|
| 0 | CI, `/metrics`, event envelope (seq), `runs` ledger, gate linter | `METRICS_ENABLED` |
| 1 | Key-based auth (`api_keys`, `AUTH_STRICT=true`), socket trust, Guard hardening (realpath, process-group kill), encrypted secrets, rate limiting, MCP hygiene | `AUTH_STRICT`, `LEGACY_GUARD` |
| 2 | Run state machine (17 states), cancellation (AbortSignal array-safe), transactional writes (ULID + `channel_sequences`), structured `tool_calls` jsonb, memory lifecycle caps | — |
| 3 | Parallel dispatch (`MAX_PARALLEL_AGENTS=4`), bounded queries, per-iteration budget, delta librarian, keyset pagination, stream coalescing, HNSW-ready indexes, tool R/W classifier, Undici keep-alive, model routing (`MODEL_ROUTE=routed`) | `PIPELINE_PARALLEL` etc. |
| 4 | Redis + BullMQ (`QUEUE_MODE=bullmq`), `runs`/`maintenance`/`scheduler` queues, idempotency `channel:agent:message`, 15m lease + heartbeat, resume from checkpoint + compensation journal | `QUEUE_MODE` |
| 5 | Research (Brave/Tavily/Serper + evidence bundle), Swarm v1 (DAG `swarm_tasks` + aggregator + verifier), Approvals (`WAITING_FOR_APPROVAL` + TTL + reusable grants), prompt integrity (`<untrusted>`), honest compression, Artifact service (`diff`/`report`/`citations`) | `RESEARCH_V1`, `SWARM_V1`, `APPROVALS_ENABLED` |
| 6 | Cancel button, approval cards, diff viewer, edit/regenerate/retry, background continuity (reconnect digest + notifications), delegation timeline, honesty pass (`DEMO_FALLBACK`), store decomposition + pagination | — |
| 7 | Load suite (k6 100 sends / 10 swarms / 8h soak), pgvector hybrid memory (`EMBEDDING_ENABLED`), OTel traces (`assemble`/`llm`/`tool`/`persist` keyed `runId` + cost ledger `token_usage_log×cost_per_1k`) | `OTEL_ENABLED`, `EMBEDDING_ENABLED` |

**Roadmap vs shipped:**
- `Raven` (Lv0-1 strategic), `Crow` (Lv2-3 operational), `Conspiracy` (high-context reasoning group), `Murder` (distributed swarm) were aspirational names in early docs — **Swarm v1 now ships the Murder primitive behind `SWARM_V1` (Phase 5)**; Raven/Crow as branded Lv0/Lv1 personas remain **roadmap, not separate agent species** — the generic `Agents` + `instruction_modules` + `model_modules` system is the shipped abstraction. See `Goal.md` §32 target architecture for the honest model.

---

# Vision

CrowdOS aims to become:

* a collective intelligence sandbox
* a social operating system for AI ecosystems
* a programmable agent society platform
* a multi-agent experimentation environment
* a governance-first orchestration framework

Not merely another AI wrapper.

---

# Closing Philosophy

CrowdOS is built around a simple idea:

> intelligence is not centralized — it is coordinated.

---

## Local Setup

```bash
npm install
npm run dev
```

This starts:
- Server: `http://localhost:3001`
- Client: `http://localhost:5173`

