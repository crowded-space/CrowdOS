# 🧩 Level 2 Feature Spec: Agent Generator & Lifecycle Engine (CrowdOS)

## 1. Konsep Status (The Discord Dots Metaphor)
Sistem ini menangani fase hidup, memori, dan tugas (*state*) sebuah agen. Untuk menampilkan status mental agen kepada User secara non-intrusif, kita menggunakan metafora indikator lampu (Dots) pada daftar "Member" layaknya di Discord:
*   🟢 **Active / Working (Online):** Agen sedang memproses *prompt*, berpikir (*reasoning*), atau mengetik.
*   🟡 **Idle (Away):** Agen hidup di memori, siap merespons, namun sedang tidak ada yang dikerjakan. Juga digunakan saat agen di-**Pause** karena error.
*   🌑 **Offline (Stateless):** Agen tidak aktif di memori (*sleeping/dead*).

## 2. Runtime State Tracking (Persistent)

Setiap agen yang aktif memiliki **RuntimeState** yang di-track secara real-time dan persist di database:

```typescript
interface RuntimeState {
  sessionId: string;
  agentId: string;
  status: 'idle' | 'working' | 'paused' | 'offline';
  activeTask?: string;
  activeChannelId?: string;
  startedAt?: Date;
  overridesApplied: string[];    // IDs of active runtime overrides
  lastHeartbeat?: Date;
}
```

RuntimeState di-broadcast via Socket.io setiap ada perubahan (`runtime:state`), sehingga UI selalu up-to-date.

## 3. Runtime Override Engine

Runtime override memungkinkan modifikasi perilaku agen **tanpa mengubah profil asli**:

```typescript
interface RuntimeOverride {
  id: string;
  targetAgentId: string;
  overrideType: 'runtime_patch' | 'temp_permission' | 'context_inject';
  instructionPatch?: {
    append?: string[];      // Tambahan instruksi
    replace?: string[];     // Replace instruksi tertentu
  };
  permissionPatch?: {
    grantTools?: string[];  // Temporary tool grants
    revokeTools?: string[]; // Temporary tool revocations
  };
  createdBy: string;        // "user" or agent ID
  expiresAt?: Date;         // Auto-expire (optional)
}
```

### Alur Runtime Override
1. User/L2 menggunakan tool `runtime_override` → tentukan target agent + patch
2. Backend menyimpan override di database
3. `RuntimeEngine` menerapkan patch ke prompt agen di sesi berikutnya
4. `RuntimeState.overridesApplied` diperbarui
5. Override bisa di-expire manual atau otomatis via `expiresAt`
6. Jika override expired → patch dicabut, state diperbarui

### Use Cases
- L2 memberi instruksi tambahan: "Fokus hanya pada React repositories"
- User grant akses sementara ke tool sensitive
- Koreksi perilaku tanpa edit template asli

## 4. State Machine per Authority Level

### 👑 Level 1 (The CEO)
```
Server Start
    │
    ▼
  [🟡 Idle] ◄──────────────────────┐
    │                               │
    │ User message / mention        │ Selesai merespons /
    │ di channel                    │ Dispatch complete
    ▼                               │
  [🟢 Active] ─────────────────────┘
    │
    │ Error (API fail 10x)
    ▼
  [🟡 Idle/Paused] ── User intervention ──► [🟢 Active]
    │
    │ Server shutdown
    ▼
  [🌑 Offline]
```
**Default:** 🟡 Idle (Selalu standby saat server berjalan)
**Tidak pernah** 🌑 Offline kecuali server mati.

### 👔 Level 2 (The Board of Directors)
```
Server Start
    │
    ▼
  [🟡 Idle] ◄──────────────────────┐
    │                               │
    │ L1 dispatch / mention /       │ Task selesai /
    │ EventBus task_assign          │ Results aggregated
    ▼                               │
  [🟢 Active] ─────────────────────┘
    │
    │ Error / Budget exceeded
    ▼
  [🟡 Idle/Paused] ── User/L1 intervention ──► [🟢 Active]
    │
    │ Channel deletion
    ▼
  [🌑 Offline] ── Bisa diaktifkan kembali ──► [🟡 Idle]
```
**Default:** 🟡 Idle (Dimuat ke memori saat server menyala)
**Trigger 🟢:** Menerima task dari L1 via EventBus atau mention langsung.
**Kembali 🟡:** Setelah semua L3 pairs selesai dan hasil di-aggregate.

### 👷 Level 3 Worker (Stateless)
```
  [🌑 Offline] ◄───────────────────┐
    │                               │
    │ SpawnManager creates          │ Task selesai / Error fatal /
    │ instance dari template        │ Budget exceeded (last call)
    ▼                               │
  [🟢 Active] ─────────────────────┘
    │
    │ Error (retryable)
    ▼
  [🟡 Idle/Paused] ── Supervisor fix ──► [🟢 Active]
       │
       │ Max retry exceeded
       ▼
  [🌑 Offline] (instance dihapus, RAM dibersihkan)
```
**Default:** 🌑 Offline (Hanyalah template di Agent Registry)
**Instance sementara:** Di-spawn oleh SpawnManager, langsung 🟢, dimatikan setelah selesai.
**Anti memory leak:** Instance dihapus dari RAM setelah kembali ke 🌑.

### 👷 Level 3 Supervisor (Stateful)
```
  [🌑 Offline] ◄───────────────────┐
    │                               │
    │ Di-spawn bersama Worker       │ Worker + Supervisor selesai
    │ (1:1 pair)                    │ / L2 konfirmasi task complete
    ▼                               │
  [🟢 Active] ─────────────────────┘
    │
    │ Worker di-Pause
    ▼
  [🟢 Active] (Supervisor tetap aktif untuk report ke L2)
    │
    │ Selesai report + L2 acknowledge
    ▼
  [🌑 Offline] (instance dihapus)
```
**Catatan:** Supervisor **tetap hidup** lebih lama dari Worker-nya — Supervisor harus mengirim report akhir ke L2 sebelum dimatikan.

## 5. Worker-Supervisor Pairing Model

### Konfigurasi User
User membuat **2 template terpisah** di Agent Office:
1. **Worker Template** (L3 subtype: `worker`) — InstructionModule untuk eksekusi (misal: "Coder", "Data Scraper").
2. **Supervisor Template** (L3 subtype: `supervisor`) — InstructionModule untuk evaluasi. Disarankan menggunakan model **general-purpose** (contoh: Gemma 4) agar fleksibel.

### Pairing Rules
- Setiap Worker di-assign **tepat 1 Supervisor** — hubungan 1:1.
- Worker dan Supervisor berkomunikasi di **private pair channel** (terpisah dari channel lain).
- **Max 5 pairs** berjalan bersamaan per batch.
- Jika subtask > 5 → batch processing (lihat `LV2_L3_Spawn_Protocol.md` untuk detail).

### Concurrency
| Skenario | Pairs |
|----------|-------|
| Task kecil (1-5 subtask) | 1-5 pairs langsung jalan |
| Task sedang (6-10 subtask) | Batch 1 (5 pairs) → Batch 2 (sisa) |
| Task besar (11-15 subtask) | Batch 1 (5) → Batch 2 (5) → Batch 3 (sisa) |
| Task sangat besar (>15) | Pertimbangkan pecah task di level L2 |

### Supervisor sebagai Evaluator Ganda
Supervisor tidak hanya mengevaluasi output Worker, tetapi juga secara implisit mengevaluasi **kualitas dispatch dan task writing dari L2**. Feedback ini bisa digunakan untuk:
- Meningkatkan prompt clarity di iterasi berikutnya.
- Melaporkan bahwa instruksi L2 terlalu ambigu → escalation.

## 6. Checklist Progress
- [ ] Buat Node.js Service `RuntimeEngine` untuk runtime overrides + state tracking
- [ ] Buat DB tables: `runtime_overrides`, `runtime_states`
- [ ] Implementasi CRUD API untuk runtime overrides
- [ ] Broadcast `runtime:state` dan `runtime:override` events via Socket.io
- [ ] Implementasi override expiry logic (auto-cleanup)
- [ ] Buat Node.js Service `AgentSpawnManager` khusus untuk instansiasi pairs.
- [ ] Implementasi state machine per authority level dengan transisi yang terdefinisi.
- [ ] Setup `Socket.io` hooks untuk membroadcast *Status Dot* agen (Green/Yellow/Offline) ke UI.
- [ ] Buat logika `L2_dispatcher` (Logika memicu perubahan dari 🟡 Idle ke 🟢 Active saat tugas masuk).
- [ ] Implementasi private pair channel auto-creation dan cleanup.
- [ ] Implementasi Supervisor reporting pipeline ke L2.
- [ ] Implementasi Agent Pause/Resume mechanism (🟢 ↔ 🟡 pada error).
