# 🧩 Level 2 Feature Spec: Testing Strategy

> **CrowdOS Alignment:** Testing strategy now covers modular component testing: `InstructionModule`, `ModelModule`, `ToolkitModule` CRUD, runtime override application, and runtime state tracking. Agent identity is simplified, but module-level operations increase in scope.

## 1. Tujuan
Dokumen ini mendefinisikan strategi pengujian, evaluasi, dan review yang digunakan selama proses pengembangan CrowdOS. Mengingat sifat framework yang melibatkan banyak agen otonom, strategi pengujian harus mencakup baik komponen deterministik (API, database) maupun komponen non-deterministik (LLM output).

## 2. Layer Testing

### Layer 1: Unit Tests
**Scope:** Fungsi/modul individual yang deterministik.
**Tools:** Vitest (kompatibel Vite) / Jest
**Target:**

| Modul | Apa yang di-test |
|-------|-----------------|
| `EventBroker` | Emit/subscribe/unsubscribe, channel scoping, listener cleanup |
| `MemoryBuilder` | Prompt assembly order, visibility matrix filtering, tier management, module injection (InstructionModule, RuntimeOverride) |
| `AgentRegistry` | CRUD operations, lookup by ID/level, validation, module reference resolution |
| `InstructionModule` | CRUD, schema validation, runtime patching format |
| `ModelModule` | CRUD, provider config validation, parameter constraints |
| `ToolkitModule` | CRUD, tool ID validation, danger level enforcement |
| `RuntimeOverride` | Apply/revert/expire lifecycle, injection into MemoryBuilder |
| `RuntimeState` | Status transitions, pause/resume flow, error info capture |
| `ChannelController` | Channel create/delete/archive, scope enforcement |
| `LoopArbiter` | Turn counting, similarity detection, escalation trigger |
| `SpawnManager` | Batch splitting (12 subtasks → 3 batches), pair creation/cleanup, identity-driven agent spawn |
| `MentionParser` | Post-processing validation, typo correction, metadata generation |
| `TokenTracker` | Budget calculation, soft cap detection, usage aggregation |
| Output Validators | JSON validation, format detection regex |

**Example test:**
```typescript
describe('SpawnManager - Batch Processing', () => {
  it('splits 12 subtasks into 3 batches of 5-5-2', () => {
    const batches = SpawnManager.createBatches(subtasks, { maxPairsPerBatch: 5 });
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(5);
    expect(batches[1]).toHaveLength(5);
    expect(batches[2]).toHaveLength(2);
  });
});
```

### Layer 2: Integration Tests
**Scope:** Interaksi antar modul. Menggunakan **mock LLM** (response yang sudah di-predetermine) untuk menguji alur tanpa biaya API.
**Tools:** Vitest + Supertest (API), testcontainers (PostgreSQL)

| Alur yang di-test | Modul terlibat |
|-------------------|----------------|
| User mengirim pesan → L1 merespons | Routes → EventBroker → AgentRegistry → MemoryBuilder → MockAdapter |
| L1 dispatch ke L2 | Router → EventBroker → AgentRegistry → ChannelController |
| L2 spawn L3 pairs | SpawnManager → EventBroker → ChannelController → Socket broadcast |
| Mention parsing end-to-end | Routes → MentionParser → EventBroker → Agent trigger |
| Error → Escalation chain | LoopArbiter / ErrorHandler → EventBroker → Agent notification |
| Token budget enforcement | TokenTracker → Agent Pause → Notification |

**Mock LLM Strategy:**
```typescript
class MockModelAdapter implements IModelAdapter {
  private responses: Map<string, string>;

  async generate(messages, tools) {
    // Mengembalikan response yang sudah di-map berdasarkan keyword di last message
    const lastMessage = messages[messages.length - 1].content;
    return this.responses.get(lastMessage) || { content: "Default mock response", usage: {...} };
  }
}
```

### Layer 3: End-to-End (E2E) Tests
**Scope:** Full flow dari UI hingga backend hingga response.
**Tools:** Playwright (Browser automation)
**⚠️ Membutuhkan LLM aktif** — gunakan model paling murah (Gemini Flash / Ollama lokal) untuk E2E.

| Skenario | Deskripsi |
|----------|-----------|
| Agent Creation Flow | User buat agen di UI → muncul di sidebar → status dot benar |
| Chat Flow | User kirim pesan di #general → L1 merespons → streaming output visible |
| Dispatch Flow | User minta task→ L1 dispatch → L2 aktif → L3 spawn → result muncul |
| Mention Flow | User ketik @ → autocomplete muncul → pilih agen → agen merespons |
| Settings Flow | User tambah Model Profile → Test Connection → agen bisa pakai |
| Error Flow | Simulate API error → agent paused → notification muncul |

### Layer 4: Agent Behavior Tests (Non-Deterministic)
**Scope:** Mengevaluasi apakah LLM agents berperilaku sesuai desain.
**Pendekatan:** **LLM-as-Judge** — menggunakan model terpisah untuk mengevaluasi output agent.

| Test Case | Kriteria Evaluasi |
|-----------|-------------------|
| L1 hanya menjawab hal yang relevan dengan role-nya | Judge menilai: apakah output sesuai system prompt? |
| L1 memilih L2 yang tepat untuk task | Judge menilai: apakah L2 yang dipilih relevan dengan task? |
| L2 menghasilkan task file yang jelas | Judge menilai: apakah instruksi cukup detail untuk worker? |
| L3 Worker mengikuti instruksi, tidak berhalusinasi | Judge menilai: apakah output sesuai task file? |
| Supervisor mendeteksi output buruk | Berikan output sengaja buruk → Supervisor harus menolak |
| Visibility policy terjaga | Inject pesan dari level berbeda → agen tidak boleh merespons pesan di luar policy-nya |

## 3. Test Environment

### Development (Continuous)
```
Setiap commit/PR:
├── Unit Tests (Vitest) → wajib semua pass
├── Integration Tests (Mock LLM) → wajib semua pass
└── Lint + Type Check (ESLint + tsc) → wajib clean
```

### Staging (Periodic)
```
Setiap milestone/phase selesai:
├── E2E Tests (Playwright + Cheap LLM)
├── Agent Behavior Tests (LLM-as-Judge)
└── Manual Review oleh User
```

## 4. Coverage Target

| Layer | Coverage Target | Prioritas |
|-------|----------------|-----------|
| Unit Tests | ≥80% core modules | Wajib |
| Integration Tests | Semua critical flows | Wajib |
| E2E Tests | Happy paths | Disarankan |
| Behavior Tests | Core agent behaviors | Opsional (Phase 4+) |

## 5. Checklist Progress
- [ ] Setup Vitest di `packages/server` dan `packages/client`.
- [ ] Buat MockModelAdapter untuk integration tests.
- [ ] Tulis unit tests untuk EventBroker dan MemoryBuilder terlebih dahulu (core modules).
- [ ] Setup testcontainers untuk PostgreSQL testing.
- [ ] Setup Playwright untuk E2E testing.
- [ ] Definisikan Agent Behavior test cases setelah Phase 3.
- [ ] Integrasikan test running ke CI/CD pipeline (jika ada).
