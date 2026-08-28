# 🧩 Level 2 Feature Spec: Prompt Assembly & Context Injection

> **CrowdOS Alignment:** System prompts are loaded from `InstructionModule` (not directly from AgentProfile). `RuntimeOverride` patches are injected as separate blocks. Agent identity is minimal (name + species + tier) — all cognitive configuration comes from referenced modules.

## 1. Konsep Perakitan Prompt (The MemoryBuilder Pipeline)
Setiap kali agen merespons pesan, `MemoryBuilder` merakit prompt akhir yang dikirim ke LLM. Urutan blok dalam prompt **sangat kritis** terhadap kualitas output model. Dokumen ini mendefinisikan urutan pasti (*canonical order*) per Authority Level.

## 2. Prompt Template per Authority Level

### 👑 Level 1 (CEO / Project Lead)
```
┌──────────────────────────────────────────────┐
│ [1] SYSTEM PROMPT                            │
│     InstructionModule[agent.instructionId]   │
│     (Persona, rules, capabilities)           │
├──────────────────────────────────────────────┤
│ [1b] RUNTIME OVERRIDE (if active)            │
│     RuntimeOverride.patchContent             │
│     (Temporary patch appended after sysprompt)│
├──────────────────────────────────────────────┤
│ [2] AUTHORITY CONTEXT                        │
│     "Kamu adalah Level 1 CEO Agent.          │
│      Kamu memiliki akses ke Bipolar          │
│      Dispatch Function. Berikut daftar       │
│      agen L2 yang tersedia: [...]"           │
├──────────────────────────────────────────────┤
│ [3] AVAILABLE TOOLS (Function Calling)        │
│     JSON Schema: bipolar_dispatch,           │
│     read_agent_registry, create_workspace,   │
│     system_scheduler                         │
├──────────────────────────────────────────────┤
│ [4] SHARED MEMORY (XML-Tagged Chatroom)      │
│     Tier 3: [Compressed Summary]             │
│     Tier 2: [Recent N Messages]              │
│     (Visibility: Full — L1 melihat           │
│      semua pesan di channel-nya)             │
├──────────────────────────────────────────────┤
│ [5] INDEPENDENT MEMORY (Self-Scratchpad)     │
│     - Riwayat dispatch decisions             │
│     - Tool calling history                   │
│     - Internal monologue                     │
├──────────────────────────────────────────────┤
│ [6] CURRENT MESSAGE / TASK                   │
│     Pesan terakhir dari User atau event      │
│     yang harus direspons                     │
└──────────────────────────────────────────────┘
```

### 👔 Level 2 (Manager / Specialist)
```
┌──────────────────────────────────────────────┐
│ [1] SYSTEM PROMPT                            │
│     InstructionModule[agent.instructionId]   │
│     (Spesialisasi, rules, domain expertise)  │
├──────────────────────────────────────────────┤
│ [1b] RUNTIME OVERRIDE (if active)            │
│     RuntimeOverride.patchContent             │
├──────────────────────────────────────────────┤
│ [2] AUTHORITY CONTEXT                        │
│     "Kamu adalah Level 2 Manager.            │
│      Atasanmu adalah [L1 Name].              │
│      Kamu bekerja di channel                 │
│      #[channel-name]. Kamu bisa              │
│      men-dispatch L3 Worker/Supervisor."     │
├──────────────────────────────────────────────┤
│ [3] AVAILABLE TOOLS (Function Calling)        │
│     JSON Schema: dispatch_agent (L3 spawn),  │
│     EventBusTrigger, tools sesuai profile    │
├──────────────────────────────────────────────┤
│ [4] SHARED MEMORY — Channel dengan L1        │
│     (XML-Tagged: pesan dari L1 + User)       │
│     Visibility: Vertical (1 level atas)      │
├──────────────────────────────────────────────┤
│ [5] SHARED MEMORY — Channel dengan L3        │
│     (XML-Tagged: pesan dari L3 workers)      │
│     Visibility: Vertical (1 level bawah)     │
│     ⚠️ L2 punya 2 chatroom terpisah          │
├──────────────────────────────────────────────┤
│ [6] INDEPENDENT MEMORY (Self-Scratchpad)     │
│     - Task assignment dari L1                │
│     - Blueprint/plan yang dibuat             │
│     - Tool calling history                   │
├──────────────────────────────────────────────┤
│ [7] CURRENT MESSAGE / TASK                   │
│     Pesan terakhir dari L1, atau hasil       │
│     kerja L3 yang perlu ditinjau             │
└──────────────────────────────────────────────┘
```

### 👷 Level 3 — Worker (Stateless Executor)
```
┌──────────────────────────────────────────────┐
│ [1] SYSTEM PROMPT                            │
│     InstructionModule[agent.instructionId]   │
│     (Executor-only rules, no big-picture)    │
├──────────────────────────────────────────────┤
│ [1b] RUNTIME OVERRIDE (if active)            │
│     RuntimeOverride.patchContent             │
├──────────────────────────────────────────────┤
│ [2] AUTHORITY CONTEXT                        │
│     "Kamu adalah Level 3 Worker.             │
│      Supervisormu adalah [Spv Name].         │
│      Fokus pada tugas yang diberikan.         │
│      Jangan mengambil keputusan arsitektur." │
├──────────────────────────────────────────────┤
│ [3] AVAILABLE TOOLS (Function Calling)        │
│     HANYA tools yang dicentang user          │
│     (e.g., FileSystem, Bash — no dispatch)   │
├──────────────────────────────────────────────┤
│ [4] TASK FILE (Pinned Content)               │
│     Instruksi spesifik dari L2 untuk         │
│     worker ini (task_N.md content)            │
│     ⚠️ Menggantikan Shared Memory —           │
│     Worker TIDAK menerima full chat history   │
├──────────────────────────────────────────────┤
│ [5] SHARED MEMORY — Private Pair Channel     │
│     (XML-Tagged: hanya obrolan dengan        │
│      Supervisor pendamping)                  │
├──────────────────────────────────────────────┤
│ [6] CURRENT MESSAGE                          │
│     Perintah/nudge terakhir dari Supervisor  │
│     atau task baru                           │
└──────────────────────────────────────────────┘
```
**Catatan:** Worker **tidak memiliki Independent Memory** — karena bersifat stateless. Setiap spawn adalah slate kosong.

### 👷 Level 3 — Supervisor (Stateful Evaluator)
```
┌──────────────────────────────────────────────┐
│ [1] SYSTEM PROMPT                            │
│     InstructionModule[agent.instructionId]   │
│     (Evaluator rules, quality standards)     │
├──────────────────────────────────────────────┤
│ [1b] RUNTIME OVERRIDE (if active)            │
│     RuntimeOverride.patchContent             │
├──────────────────────────────────────────────┤
│ [2] AUTHORITY CONTEXT                        │
│     "Kamu adalah Level 3 Supervisor.         │
│      Worker pendampingmu: [Worker Name].     │
│      Tugasmu: evaluasi output, jaga          │
│      konteks, dan eskalasi jika gagal."      │
├──────────────────────────────────────────────┤
│ [3] AVAILABLE TOOLS (Function Calling)        │
│     Tools evaluasi sesuai profile            │
│     (DIBATASI — tidak boleh execute          │
│      command sensitif/critical)              │
├──────────────────────────────────────────────┤
│ [4] TASK FILE (Pinned Content)               │
│     Instruksi yang sama dengan Worker-nya    │
│     (agar tahu apa yang di-evaluate)         │
├──────────────────────────────────────────────┤
│ [5] SHARED MEMORY — Private Pair Channel     │
│     (XML-Tagged: obrolan dengan Worker)      │
├──────────────────────────────────────────────┤
│ [6] INDEPENDENT MEMORY (Self-Scratchpad)     │
│     - Riwayat evaluasi sebelumnya            │
│     - Task diff analysis (major vs minor)    │
│     - Retry count tracking                   │
├──────────────────────────────────────────────┤
│ [7] CURRENT MESSAGE                          │
│     Output terbaru dari Worker yang perlu    │
│     dievaluasi                               │
└──────────────────────────────────────────────┘
```

## 3. Hybrid Token Management (3-Tier Strategy)

Untuk mengelola token window tanpa mengorbankan kualitas:

```
Tier 1: PINNED (Tidak pernah dihapus)
  → System Prompt, Authority Context, Task File, Tool Schemas
  → Selalu masuk ke prompt, tidak peduli seberapa panjang history

Tier 2: RECENT (Sliding Window)
  → N pesan terakhir di Shared Memory
  → N = configurable per Model Profile
  → Default: 30 messages
  → Disimpan mentah tanpa modifikasi

Tier 3: COMPRESSED (Summary)
  → Pesan SEBELUM sliding window
  → Diringkas menjadi 1 paragraf oleh model murah
  → Summary di-cache di database
  → Tidak di-generate ulang setiap kali (hemat biaya)
  → Model summarization = Indexing Model dari Workspace Settings
```

### Konfigurasi di Model Profile
```typescript
contextWindowConfig: {  
  maxRecentMessages: 30,           // Tier 2 sliding window size
  enableCompression: true,         // Tier 3 on/off
  compressionThreshold: 50,       // Mulai compress setelah N pesan total
}
```
*Model untuk compression/summarization mengikuti pengaturan "Indexing Model" di Workspace Settings.*

## 4. Visibility Matrix (Memory Sharing Policy Enforcement)

Tabel berikut mendefinisikan pesan **mana saja** yang masuk ke blok Shared Memory agen berdasarkan policy-nya:

| Agent Policy | Pesan yang di-inject ke Shared Memory |
|-------------|---------------------------------------|
| `none` | **Hanya** pesan yang ditujukan langsung kepadanya via `@mention`. Tidak melihat obrolan lain sama sekali. Sepenuhnya wewenang dan tanggung jawab User. |
| `horizontal` | Pesan dari agen **se-level** di channel yang sama + pesan yang `@mention` langsung. |
| `vertical` | Pesan dari **1 level atas** (atasan langsung) + **1 level bawah** (bawahan langsung) + `@mention` langsung. Hanya yang relevan (L1-A ↔ L2-A, bukan L1-A ↔ L2-B). |
| `full` | **Semua** pesan di channel tersebut, tanpa filter. Transparan. |

### Aturan Tambahan
- **L2 memiliki 2 chatroom terpisah:** (1) Channel dengan L1 — konteks arahan tugas, (2) Channel dengan L3 — konteks eksekusi teknis.
- **L1 TIDAK** berada di chatroom yang sama dengan L3. Pemisahan ini menghemat token L1 dan menjaga fokus.
- **`@mention`** dari Auth Level setara menambahkan **critical/important flag** yang meningkatkan bobot attention model penerima.
- **L0 Omniscient** tidak menggunakan visibility matrix ini — L0 menggunakan mekanisme grep/browse terpisah (lihat `LV2_L0_Omniscient`).

## 5. CrowdOS Integration

### Module-Aware Assembly
- `MemoryBuilder` sekarang mengambil system prompt dari `InstructionModule` berdasarkan `agent.instructionId`, bukan dari field langsung di `AgentProfile`.
- Toolkit module (via `agent.toolkitIds`) menyediakan daftar tool schemas yang di-inject ke blok [3].
- Model module (via `agent.modelId`) menyediakan `contextWindowConfig` dan parameter LLM.

### Runtime Override Injection
- Jika ada `RuntimeOverride` aktif (status `active`) untuk agent ini, konten `patchContent`-nya disuntikkan sebagai blok [1b] — tepat setelah system prompt, sebelum authority context.
- Ini memastikan override behavior didahulukan dalam prioritas prompt.
- Multiple overrides digabung dengan separator `---

## 6. Checklist Progress
- [ ] Implementasi `MemoryBuilder` yang merakit prompt sesuai template per level.
- [ ] Implementasi Tier 1/2/3 token management strategy.
- [ ] Implementasi visibility matrix filtering di `MemoryBuilder`.
- [ ] Buat compression/summarization pipeline menggunakan Indexing Model.
- [ ] Cache summary di database untuk efisiensi.
- [ ] Integrasikan `contextWindowConfig` dari Model Profile ke MemoryBuilder.
- [ ] Integrasikan module loading (Instruction, Toolkit, Model) ke MemoryBuilder.
- [ ] Implementasi RuntimeOverride injection sebagai blok terpisah.
