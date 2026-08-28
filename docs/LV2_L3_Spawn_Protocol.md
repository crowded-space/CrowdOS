# 🧩 Level 2 Feature Spec: L3 Spawn Protocol & Worker-Supervisor Pairing

> **CrowdOS Alignment:** L3 agents (Worker & Supervisor) are created as identity-driven agents with references to `InstructionModule`, `ModelModule`, and `ToolkitModule`. Spawning creates new agent instances with minimal identity — all cognitive configuration comes from shared modules. `RuntimeState` tracks the spawned lifecycle.

## 1. Konsep Pairing (1 Worker : 1 Supervisor)
Berbeda dengan agentic framework konvensional yang bekerja serial (task demi task), Community Agent menggunakan **parallel pair execution**. Setiap L3 Worker memiliki **1 dedicated Supervisor** yang bertanggung jawab melakukan evaluasi, menjaga konteks, dan melaporkan hasil.

```
L2 Manager
    │
    │ dispatch_agent (MCP Tool)
    │
    ▼
┌─────────────────────────────────────────────────┐
│              Spawn Manager                       │
│                                                  │
│  Batch 1 (max 5 pairs):                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ Worker 1 │  │ Worker 2 │  │ Worker 3 │ ...  │
│  │ Spv 1    │  │ Spv 2    │  │ Spv 3    │      │
│  └──────────┘  └──────────┘  └──────────┘      │
│     ▲  ▼           ▲  ▼          ▲  ▼           │
│  Private Ch.    Private Ch.   Private Ch.       │
│                                                  │
│  ──── Barrier: tunggu semua Batch 1 selesai ─── │
│                                                  │
│  Batch 2 (sisa pairs):                          │
│  ┌──────────┐  ┌──────────┐                     │
│  │ Worker 4 │  │ Worker 5 │                     │
│  │ Spv 4    │  │ Spv 5    │                     │
│  └──────────┘  └──────────┘                     │
│                                                  │
│  ──── Barrier: tunggu Batch 2 selesai ───────── │
│                                                  │
│  Aggregate Results → Report ke L2                │
└─────────────────────────────────────────────────┘
```

## 2. User Setup Requirements
Untuk menggunakan L3 spawning, User harus membuat **2 template agen terpisah** di Agent Office:

1.  **Worker Template:** Template agen L3 dengan subtype `worker`. Berisi `InstructionModule` untuk eksekusi tugas (misal: "Coder L3", "Data Scraper L3") serta `ToolkitModule` yang membatasi tools.
2.  **Supervisor Template:** Template agen L3 dengan subtype `supervisor`. Berisi `InstructionModule` untuk evaluasi dan quality control. Disarankan menggunakan model **general-purpose** (contoh: Gemma 4) agar fleksibel memahami berbagai konteks.

Kedua template dipilih oleh User di Agent Editor masing-masing, termasuk `ModelModule` yang akan digunakan. Karena agent hanya menyimpan identitas minimal, kedua template bisa berbagi `InstructionModule` dan `ToolkitModule` yang sama dengan agent lain.

## 3. Spawn Request (Agent Tool Schema)

### `dispatch_agent` — Tool Function dipanggil oleh L2
```typescript
{
  name: "dispatch_agent",
  description: "Men-spawn pasangan Worker-Supervisor L3 untuk mengeksekusi subtask secara paralel",
  parameters: {
    workerTemplateId: string,       // Agent ID template Worker dari Registry
    supervisorTemplateId: string,   // Agent ID template Supervisor dari Registry
    subtasks: [{
      id: string,                   // Unique subtask identifier
      title: string,                // Judul singkat subtask
      instructions: string,         // Instruksi detail (konten task file)
      priority: 'high' | 'medium' | 'low',
    }],
    failurePolicy: 'retry' | 'escalate',  // Apa yang dilakukan jika pair gagal
    maxRetries: number,             // Max retry per pair (default: 3)
  }
}
```

## 4. Task File Lifecycle

### 4.1 Pembuatan (Abstraksi)
L2 **tidak literal menulis file**. Proses task file adalah abstraksi:
1.  L2 merumuskan instruksi per subtask via LLM reasoning.
2.  L2 memanggil tool `dispatch_agent` (via LLM function calling) dengan field `instructions` berisi konten tugas.
3.  Backend/System secara otomatis:
    -   Menyimpan konten sebagai **text di database** (tabel `task_files`).
    -   Menandai sebagai **pinned content** yang akan masuk ke prompt Worker.
    -   Men-generate attachment untuk ditampilkan di UI chatroom.

### 4.2 Akses & Visibilitas
| Entitas | Akses |
|---------|-------|
| Worker yang relevan | ✅ Masuk ke prompt sebagai Pinned Content (Blok [4]) |
| Supervisor pendamping | ✅ Masuk ke prompt (untuk tahu apa yang di-evaluate) |
| Worker lain / Supervisor lain | ❌ Tidak bisa akses |
| L2 yang mendispatch | ✅ Bisa melihat semua task files |
| User | ✅ Visible di UI chatroom sebagai attachment (untuk review), tapi **tidak masuk** context model manapun selain worker-supervisor pair yang relevan |

### 4.3 Penghapusan
Setelah task selesai (**laporan dari Supervisor + konfirmasi dari L2** — kesepakatan 2 agen), task file **dihapus** dari database. Data tidak diarsipkan.

### 4.4 Database Schema
```typescript
interface TaskFile {
  id: string;
  spawnRequestId: string;          // FK → SpawnRequest
  subtaskId: string;               // Subtask identifier
  title: string;
  content: string;                 // Instruksi detail (markdown text)
  workerAgentId: string;           // FK → spawned Worker instance
  supervisorAgentId: string;       // FK → spawned Supervisor instance
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  createdAt: Date;
  deletedAt?: Date;                // Soft delete timestamp
}
```

**CrowdOS Note:** Worker dan Supervisor instances disimpan di tabel `agents` dengan `tier = 3` dan `species = 'worker' | 'supervisor'`. Mereka mereferensi `InstructionModule`, `ModelModule`, dan `ToolkitModule` yang sudah ada — tidak perlu membuat modul baru setiap spawn. `RuntimeState` mereka dibuat baru dan dilacak selama siklus hidup spawn.

## 5. Batch Processing

### Concurrency Limit
- **Maksimum 5 pairs** (5 Worker + 5 Supervisor) berjalan **bersamaan** per batch.
- Jika subtask > 5 → dijalankan dalam **batch berurutan**:
  -   12 subtasks → Batch 1 (5 pairs) → Batch 2 (5 pairs) → Batch 3 (2 pairs)
- Setiap batch menggunakan **barrier** — tunggu semua pairs di batch selesai sebelum memulai batch berikutnya.

### Kenapa Batching?
- Mencegah **overload API provider** (rate limiting).
- Menghemat **RAM server** — setiap pair membutuhkan konteks, Socket.io listener, dan event tracking.
- Memberikan kesempatan L2 untuk **meninjau hasil batch sebelumnya** sebelum melanjutkan (opsional).

## 6. Private Pair Channel
Setiap pasangan Worker-Supervisor berkomunikasi di **channel privat** yang dibuat otomatis oleh SpawnManager:
-   Nama channel: `#pair-{subtaskId}` (misal: `#pair-task_001`)
-   **Hanya** Worker dan Supervisor pair tersebut yang bisa baca/tulis.
-   User bisa **melihat** channel ini di UI (transparansi), tapi pesannya tidak masuk context agen lain.
-   Channel dihapus setelah pair selesai (bersama task file).

## 7. Result Aggregation
```
Pair Selesai
    │
    ▼
Supervisor mengirim REPORT ke L2 Channel
    │
    ├── status: 'success' | 'failed'
    ├── output: string (hasil kerja Worker)
    ├── evaluation: string (penilaian Supervisor)
    ├── retryCount: number
    └── recommendation: string (saran Supervisor)
    
    │
    ▼
Semua Pairs di Batch selesai (Barrier)
    │
    ▼
L2 menerima aggregated results
    │
    ├── Semua success → L2 compile & report ke L1
    ├── Sebagian failed → L2 decide: re-dispatch atau report partial
    └── Semua failed → L2 escalate ke L1
```

## 8. CrowdOS Integration

### Identity-Driven Spawning
- Worker dan Supervisor yang di-spawn hanya memiliki identity (`name`, `species`, `tier`) + references ke modules.
- `SpawnManager` membuat entri baru di tabel `agents` dengan `tier = 3`, lalu membuat `RuntimeState` baru untuk masing-masing.
- Modul yang digunakan (Instruction, Model, Toolkit) adalah referensi ke modul yang sudah ada — tidak ada duplikasi data kognitif.

### RuntimeState Lifecycle
```
Spawn
  → RuntimeState.status = 'idle'
  → RuntimeState.is_paused = false
  → RuntimeState.last_active_at = now

Active
  → RuntimeState.status = 'active'
  → RuntimeState.current_channel_id = pair channel

Error/Paused
  → RuntimeState.status = 'idle'
  → RuntimeState.is_paused = true

Completed/Cleanup
  → RuntimeState dihapus (atau di-archive)
  → Agent entry dihapus (tidak permanen)
```

## 9. Checklist Progress
- [ ] Implementasi tool function `dispatch_agent` dengan schema di atas.
- [ ] Buat `SpawnManager` service untuk lifecycle pair (create → Run → Cleanup).
- [ ] Buat database table `task_files` dan `spawn_requests`.
- [ ] Implementasi batch processing engine dengan barrier.
- [ ] Implementasi auto-create private pair channel.
- [ ] Implementasi result aggregation pipeline.
- [ ] Socket.io broadcast untuk status pair (spawned → active → completed/failed → despawned).
- [ ] Auto-cleanup: hapus channel + task file + instance setelah selesai.
- [ ] Integrasikan identity-driven agent creation (minimal identity + module refs) ke SpawnManager.
- [ ] Integrasikan RuntimeState lifecycle tracking untuk spawned agents.
