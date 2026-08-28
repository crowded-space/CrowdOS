# 🧩 Level 2 Feature Spec: Error Handling & Recovery

> **CrowdOS Alignment:** Error handling integrates with `RuntimeState` for pause/resume lifecycle. When an agent encounters an error, `RuntimeState.is_paused` is set to `true` and `RuntimeState.error_info` captures the error details. Recovery mechanisms check the modular configuration to determine fallback behavior.

## 1. Prinsip Utama
Dalam sistem multi-agent, kegagalan **pasti terjadi**. Framework ini menangani error dengan filosofi:
- **Transparansi:** Setiap error dilaporkan ke agen atasan dan/atau User.
- **Preferensi Pause:** Untuk keputusan kritis, sistem memilih **Pause/Standby** melalui `RuntimeState` daripada keputusan otonom, membiarkan User atau agen atasan melakukan review manual.
- **Graceful Degradation:** Error pada satu worker tidak boleh meng-crash seluruh pipeline.

## 2. Klasifikasi Kegagalan L3 Worker

### 2.1 — LLM API Error (HTTP 429 / 500 / Timeout)
| Aspek | Detail |
|-------|--------|
| **Severity** | High |
| **Contoh** | Provider rate limit (429), server error (500), timeout >60 detik |
| **Policy** | **Retry** dengan delay **15 detik**, hingga maksimum **10x** |
| **Jika tetap gagal** | **Pause agent** → Notifikasi ke L1 → L1 membuat laporan ke User |
| **User Action** | User memeriksa: API key valid? Kuota habis? Provider sedang down? |

### 2.2 — Malformed LLM Output
| Aspek | Detail |
|-------|--------|
| **Severity** | Medium |
| **Contoh** | Diminta generate JSON, output bukan JSON atau JSON rusak |
| **Policy** | **Deteksi otomatis** via regex/validator sederhana |
| **Jika noncompliant** | Kirim kembali ke model dengan **reinforcement note:** *"Output sebelumnya tidak sesuai format. Harap kembalikan dalam format JSON yang valid: {schema}"* |
| **Max retry** | 3x. Jika masih gagal → **Pause** + report ke Supervisor |

**Deteksi Format:**
```typescript
// Contoh validator sederhana
function validateOutput(output: string, expectedFormat: 'json' | 'markdown' | 'code'): boolean {
  switch (expectedFormat) {
    case 'json':
      try { JSON.parse(output); return true; } catch { return false; }
    case 'code':
      return output.includes('```') || !output.startsWith('{');
    case 'markdown':
      return true; // Markdown selalu valid secara struktur
  }
}
```

### 2.3 — Tool Execution Failure
| Aspek | Detail |
|-------|--------|
| **Severity** | Medium |
| **Contoh** | Bash command gagal (file not found, permission denied, syntax error) |
| **Policy** | **Pause/Standby** agent. Sistem mendeteksi error dan mengirim report ke L1 → L1 melaporkan ke User |
| **Alasan tidak auto-retry** | Tool failure seringkali membutuhkan **keputusan manusia** — apakah command salah? File hilang? Permission perlu diubah? Terlalu berisiko membiarkan agen mengambil keputusan kritis secara otonom |

### 2.4 — Infinite Self-Loop
| Aspek | Detail |
|-------|--------|
| **Severity** | High |
| **Contoh** | Worker berulang kali: "saya coba lagi" → gagal → "saya coba lagi" → gagal |
| **Deteksi** | Sistem menganalisis **similarity** antar output berturut-turut. Jika 3+ output berturut-turut memiliki cosine similarity > 0.9 (atau exact string match pattern) → terdeteksi sebagai loop |
| **Policy** | **Pause/Halt** → Intervensi dari **higher authority** (Supervisor → L2) atau User. LoopArbiter mengirim event `escalation` ke channel |

### 2.5 — Supervisor Rejection (Quality Failure)
| Aspek | Detail |
|-------|--------|
| **Severity** | Medium |
| **Contoh** | Supervisor menilai output Worker tidak memenuhi standar setelah N retry |
| **Policy** | Supervisor **Pause L3 Worker** → Supervisor mengirim chat/report di **Channel dengan L2 Authority** |
| **L2 Response** | L2 mengambil alih tugas atau mendelegasikan ke **Fallback Agent** (L2 lain yang di-configure User sebagai backup). Intinya tugas berpindah tangan |
| **Evaluasi tambahan** | Supervisor juga mengevaluasi kualitas task writing dari L2 — apakah instruksi kurang jelas? Ini feedback loop untuk meningkatkan kualitas dispatch |

### 2.6 — Context Overflow
| Aspek | Detail |
|-------|--------|
| **Severity** | Low (by design) |
| **Contoh** | Task file + tool history melebihi context window model |
| **Design Prevention** | Worker bersifat **stateless** — tidak memiliki riwayat keseluruhan proyek. Worker hanya menerima instruksi bersih dari L2 (task file) dan evaluasi dari Supervisor |
| **Supervisor Role** | Supervisor bertugas **menjaga konteks Worker tetap relevan** — jika konteks membengkak, Supervisor melakukan **context flush** (reset Worker dengan instruksi segar) |
| **Jika masih terjadi** | Escalate ke L2 — task perlu dipecah lebih kecil |

### 2.7 — Budget Exceeded (Token Soft Cap)
| Aspek | Detail |
|-------|--------|
| **Severity** | Medium |
| **Contoh** | Worker/Agent sudah mencapai soft cap token usage |
| **Policy** | Agent menyelesaikan **Last API Call saat ini** (tidak dipotong di tengah jalan), lalu **Pause** |
| **⚠️ Klarifikasi** | "Biarkan selesai" = **Last API Call**, bukan seluruh task dari L2 diselesaikan secara sempurna. Agent menyelesaikan response terakhir → stop → tidak memulai call baru |
| **Recovery** | Sistem mengecek apakah User sudah configure **Scheduling** (delay task ke waktu yang lebih murah). Jika ya, task dipindahkan ke scheduled queue |

## 3. Escalation Chain

```
Error Terjadi (L3 Worker/Supervisor)
         │
         ▼
  ┌──────────────┐
  │ L3 Supervisor│ ← Evaluasi pertama
  │ (jika ada)   │
  └──────┬───────┘
         │ Tidak bisa resolve
         ▼
  ┌──────────────┐
  │ L2 Manager   │ ← Ambil alih atau re-dispatch
  │              │    ke Fallback Agent
  └──────┬───────┘
         │ Tidak bisa resolve
         ▼
  ┌──────────────┐
  │ L1 CEO       │ ← Compile report, informasikan
  │              │    User via #general atau DM
  └──────┬───────┘
         │
         ▼
  ┌──────────────┐
  │ User         │ ← Manual intervention
  │(Stakeholder) │    (fix config, adjust budget,
  └──────────────┘     restart task, dsb.)
```

## 4. Status Agent Saat Error (via RuntimeState)

| Fase | Status Dot | RuntimeState Field | Keterangan |
|------|-----------|-------------------|------------|
| Normal operation | 🟢 Active | `status: 'active', is_paused: false` | Agen sedang bekerja |
| Error terdeteksi | 🟡 Idle | `status: 'idle', is_paused: true, error_info: {...}` | Agen di-pause, menunggu instruksi |
| Fatal / unrecoverable | 🌑 Offline | `status: 'offline'` | Agen dimatikan (L3 instance dihapus, RuntimeState diarsipkan) |

### CrowdOS: RuntimeState Error Info
```typescript
// Extended RuntimeState with error tracking
interface RuntimeState {
  agentId: string;
  status: 'idle' | 'active' | 'offline';
  is_paused: boolean;
  current_channel_id?: string;
  current_task_id?: string;
  last_active_at?: Date;
  error_info?: {
    errorType: string;          // 'LLM_API_ERROR' | 'TOOL_FAILURE' | 'LOOP_DETECTED' | ...
    errorCode?: number;
    message: string;
    occurredAt: Date;
    escalatedTo?: string;       // Agent ID tujuan eskalasi
    retryCount: number;
  };
}
```

## 5. Token Budget System

### 5.1 Budget Configuration
Di **Workspace Settings**, User bisa menetapkan:
```typescript
interface TokenBudget {
  globalSoftCap: number;           // Total token limit seluruh workspace
  perProviderBudget: {             // Budget per API provider
    [profileId: string]: {
      softCap: number;
      used: number;
      resetPeriod: 'daily' | 'weekly' | 'monthly' | 'never';
    }
  };
}
```

### 5.2 UI Elements
- **Usage Bar** per Provider: Visualisasi progress `used / softCap` (seperti storage bar).
- **Warning Notification** saat usage mencapai 80% soft cap.
- **Error Notification** saat soft cap tercapai — menampilkan daftar agen yang di-pause.
- **Token estimasi** per message (sebelum dikirim, jika memungkinkan).

### 5.3 Behavior Saat Soft Cap Tercapai
```
Agent melakukan LLM API Call
    │
    ▼
Token counter mendeteksi: used + estimatedCost > softCap
    │
    ▼
Biarkan API call saat ini SELESAI (Last Call)
    │
    ▼
Agent di-PAUSE (🟡 Idle)
    │
    ▼
Notifikasi ke L1 + User:
  "⚠️ Token budget untuk provider [X] tercapai.
   Agent [Y] di-pause. 
   Opsi: Tambah budget / Schedule ke waktu murah / Cancel task."
```

## 6. Logging & Observability
Setiap error dicatat menggunakan structured logging (pino) dengan format:
```json
{
  "level": "error",
  "correlationId": "req_abc123",
  "channelId": "ch_xyz",
  "agentId": "agent_worker_001",
  "errorType": "LLM_API_ERROR",
  "errorCode": 429,
  "message": "Rate limit exceeded",
  "retryCount": 3,
  "escalatedTo": "agent_supervisor_001",
  "timestamp": "2026-04-18T02:00:00Z"
}
```

## 7. CrowdOS Integration

### Pause/Resume via RuntimeState
- Saat error terdeteksi, `RuntimeState.is_paused` di-set ke `true`.
- `RuntimeState.error_info` diisi dengan detail error untuk debugging.
- Resume = set `is_paused: false` + clear `error_info`.
- UI dapat membaca `RuntimeState.error_info` untuk menampilkan detail error ke User.

### Escalation with Module Awareness
- Escalation chain tetap sama (Supervisor → L2 → L1 → User).
- Saat L2 memutuskan Fallback Agent, ia membaca `AgentProfile` dari fallback (minimal identity + module references) untuk memverifikasi kesesuaian.

### Token Budget & RuntimeState
- Saat budget exceeded, `RuntimeState.is_paused = true` dengan `error_info.errorType = 'BUDGET_EXCEEDED'`.
- L1 mendapat notifikasi dan dapat mengambil tindakan (tambah budget, schedule ulang, cancel).

## 8. Checklist Progress
- [ ] Implementasi error classification system (7 tipe).
- [ ] Implementasi retry logic dengan configurable delay dan max count.
- [ ] Implementasi output validator (regex/JSON parse) untuk malformed output.
- [ ] Implementasi loop detector (similarity analysis antar output berturut-turut).
- [ ] Implementasi Agent Pause/Resume mechanism via RuntimeState.
- [ ] Implementasi escalation chain (Supervisor → L2 → L1 → User).
- [ ] Implementasi Token Budget system (tracking, soft cap, notification).
- [ ] Integrasi structured logging (pino) dengan correlationId.
- [ ] Buat UI: Usage Bar per Provider, warning/error notifications.
- [ ] Implementasi Fallback Agent routing di L2.
- [ ] Integrasikan RuntimeState error tracking pada semua error types.
- [ ] Integrasikan RuntimeState pause/resume dengan escalation chain.
