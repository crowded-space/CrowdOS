# 🧩 Level 2 Feature Spec: Router & Dispatch Logic (Bipolar L1)

> **CrowdOS Alignment:** The Router works with identity-driven agents. L1 reads `AgentRegistry` entries (minimal identity + module references) and uses module metadata (InstructionModule description, ToolkitModule capabilities) to decide routing. L2 agents are selected based on their InstructionModule's role description, not a monolithic profile.

## 1. Konsep "Bipolar L1" (Dual Consciousness)
Level 1 (CEO Agent) memiliki arsitektur unik bernama **Bipolar Function** — sebuah mekanisme di mana satu model dengan satu konteks yang sama menjalankan **2 tugas terpisah** secara berurutan dalam satu siklus pemikiran.

### Alur Kerja L1 (Chain-of-Thought → Dispatch → Merge)
```
User Request
     │
     ▼
┌─────────────────────────────────────────────┐
│           L1 Agent (CoT Reasoning)          │
│                                             │
│  1. Menerima & menginterpretasi user prompt │
│  2. Memahami intent dan scope tugas         │
│  3. KEPUTUSAN: Apakah perlu dispatch?       │
│     ├── Tidak → L1 menjawab langsung        │
│     └── Ya   → Aktifkan Bipolar Function ──────┐
│                                             │   │
└─────────────────────────────────────────────┘   │
                                                  │
     ┌────────────────────────────────────────────┘
     ▼
┌─────────────────────────────────────────────────────────┐
│           BIPOLAR FUNCTION (Agent Tool Call)              │
│                                                         │
│  ┌─────────────────────┐  ┌──────────────────────────┐  │
│  │  Kesadaran 1:       │  │  Kesadaran 2:            │  │
│  │  TASK DECOMPOSER    │  │  TECHNICAL ORCHESTRATOR   │  │
│  │                     │  │                           │  │
│  │  • Memecah request  │  │  • Membaca Agent Registry │  │
│  │    user menjadi     │  │  • Mencocokkan subtask    │  │
│  │    subtask-subtask  │  │    dengan deskripsi/      │  │
│  │    terukur          │  │    sysprompt L2 agents    │  │
│  │  • Output: daftar   │  │  • Memilih L2 terbaik    │  │
│  │    subtasks dengan  │  │  • Menyiapkan dispatch    │  │
│  │    prioritas        │  │    routing (tool, agent,  │  │
│  │                     │  │    target workspace)      │  │
│  └─────────┬───────────┘  └──────────────┬────────────┘  │
│            │                             │               │
│            └──────────┬──────────────────┘               │
│                       ▼                                  │
│              Dispatch Execution                          │
│              (Agent Tool Calls)                           │
│                                                         │
└─────────────────────────┬───────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────┐
│           L1 Agent (Merge & Report)         │
│                                             │
│  Bipolar function selesai →                 │
│  L1 kembali menyatu, meng-compile          │
│  keputusan dispatch menjadi laporan         │
│  yang dikirim kembali ke User:              │
│                                             │
│  "Saya telah menugaskan:                    │
│   - @DatabaseExpert ke #refactor-db         │
│   - @FrontendLead ke #ui-overhaul           │
│   Silakan pantau progress di channel        │
│   masing-masing."                           │
│                                             │
└─────────────────────────────────────────────┘
```

### Detail Implementasi Bipolar Function
- **1 model, 1 context** — Bukan 2 LLM call terpisah. Bipolar adalah sebuah **agent tool** yang dipanggil oleh L1 dalam proses reasoning-nya via native function calling.
- Tool ini secara internal menjalankan 2 sub-routine berurutan (decompose → orchestrate) lalu mengembalikan hasil gabungan ke L1.
- L1 memiliki kebebasan untuk **tidak** memanggil Bipolar jika task dianggap cukup sederhana untuk dijawab langsung.

## 2. Mekanisme Routing (Agent Matching)
L1 (via Kesadaran 2 — Technical Orchestrator) memilih L2 dengan cara:

1.  **Membaca Agent Registry:** Mengambil seluruh daftar agen L2 yang tersedia, termasuk `name`, `title`, dan `systemPrompt` masing-masing.
2.  **LLM Reasoning:** Model L1 (yang *wajib* Frontier Model) membandingkan deskripsi setiap L2 terhadap subtask yang dihasilkan oleh Kesadaran 1.
3.  **Pemilihan:** L1 memutuskan L2 mana yang paling cocok berdasarkan relevansi spesialisasi. L1 **boleh memilih lebih dari satu L2** untuk tugas yang membutuhkan multi-specialist dispatch.
4.  **Workspace Assignment:** L1 menentukan atau membuat Category/Channel target — apakah menggunakan channel existing atau membuat baru.

### Fallback Behavior
| Situasi | Behavior |
|---------|----------|
| Tidak ada L2 yang cocok | L1 melaporkan ke User: *"Tidak ditemukan agen spesialis yang sesuai. Silakan buat agen baru di Agent Office."* |
| L2 target sedang Active di channel lain | L2 tetap bisa di-assign (multi-channel parallel, konteks terisolasi per channel) |
| Task terlalu sederhana | L1 menjawab sendiri tanpa dispatch |
| Task ambigu | L1 bertanya klarifikasi ke User sebelum dispatch |

## 3. Agent Tools untuk L1 Dispatch

### 3.1 `bipolar_dispatch` (Gabungan Decompose + Orchestrate)
```typescript
// Tool Schema (JSON Schema for LLM Function Calling)
{
  name: "bipolar_dispatch",
  description: "Memecah tugas user menjadi subtask dan merutekannya ke agen spesialis yang sesuai",
  parameters: {
    userTask: string,              // Original user request
    subtasks: [{
      id: string,
      description: string,        // Deskripsi subtask
      priority: 'high' | 'medium' | 'low',
      assignedAgentId: string,    // L2 Agent ID yang dipilih
      targetCategoryId?: string,  // Category target (opsional, auto-create jika kosong)
      targetChannelName: string,  // Nama channel untuk workspace
    }],
  }
}
```

**CrowdOS Note:** Saat L1 membaca Agent Registry, ia melihat `InstructionModule.description` (bukan `AgentProfile.systemPrompt`) untuk memahami spesialisasi setiap L2. Ini karena Agent hanya menyimpan identitas minimal — semua data kognitif ada di modul.

### 3.2 `read_agent_registry` (Browse Available Agents)
```typescript
{
  name: "read_agent_registry",
  description: "Membaca daftar agen L2 yang tersedia beserta spesialisasi mereka (dari InstructionModule dan ToolkitModule)",
  parameters: {
    filterLevel?: number,          // Filter by authority level
    filterStatus?: string,         // Filter by status (from RuntimeState)
  },
  returns: {
    agent: MinimalAgentInfo,       // name, species, tier
    instructionModule: InstructionModule,  // System prompt & description
    toolkitModule: ToolkitModule,  // Available tool permissions
    runtimeState: RuntimeState,    // Current status
  }[]
}
```

### 3.3 `create_workspace` (Buat Category/Channel)
```typescript
{
  name: "create_workspace",
  description: "Membuat Category dan/atau Channel baru untuk isolasi tugas",
  parameters: {
    categoryName?: string,         // Nama category baru (opsional jika pakai existing)
    categoryId?: string,           // ID category existing
    channelName: string,           // Nama channel baru di dalam category
  }
}
```

## 4. L1 Permission Scope
- L1 **hanya bisa mengelola** Category yang menjadi miliknya (by default, Category yang dia buat).
- L1-A **tidak bisa** mengakses/edit Category milik L1-B, **kecuali** User secara eksplisit menambahkan permission di Agent Profile L1-A.
- L1 memiliki **full edit/manage** pada seluruh channel di dalam Category miliknya.

## 5. CrowdOS Integration

### Module-Aware Routing
- Saat `read_agent_registry` dipanggil, ia mengembalikan tidak hanya data agent minimal, tetapi juga `InstructionModule.description` dan `ToolkitModule.tools` — memberikan L1 informasi yang lebih kaya untuk routing.
- L1 memilih L2 berdasarkan kesesuaian antara subtask dan `InstructionModule.description`.
- Runtime state (`RuntimeState`) digunakan untuk memfilter agent yang sedang `paused` atau `offline`.

### Dispatch Validation
- Sebelum dispatch dikirim, `RuntimeState` L2 target dicek — jika `is_paused`, dispatch ditolak dengan notifikasi ke L1.
- Jika L2 target memiliki `RuntimeOverride` aktif, L1 diberi tahu bahwa perilaku L2 saat ini sedang di-patch.

## 6. Checklist Progress
- [ ] Implementasi tool function `bipolar_dispatch` dengan schema di atas.
- [ ] Implementasi tool function `read_agent_registry` (dengan module-aware returns).
- [ ] Implementasi tool function `create_workspace`.
- [ ] Buat logic routing matching (L1 reasoning terhadap Agent Registry + module descriptions).
- [ ] Buat mekanisme multi-L2 parallel dispatch.
- [ ] Implementasi fallback behavior saat tidak ada L2 yang cocok.
- [ ] Integrasi permission scope L1 dengan Category system.
- [ ] Integrasikan RuntimeState checking pada dispatch validation.
