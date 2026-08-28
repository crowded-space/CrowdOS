# 🏗️ CrowdOS — Project Guideline Level 1: Technical Architecture (Node.js)

## 1. Arsitektur Komunikasi Dasar (Event-Driven Chatroom)
Karena mengadopsi metafora "Discord", sistem dilarang menggunakan *blocking promise chains* (seperti `await agentB.run()`) secara ketat yang menyembunyikan proses *real-time*. 
Sebagai gantinya, arsitektur yang digunakan adalah **Decoupled Event Bus** dengan jembatan komunikasi ke *Client*.
- **Internal Event Engine (Backend):** Di fase awal kita akan menggunakan bawaan `Node.js EventEmitter` yang dibungkus dalam bentuk abstrak `Class EventBroker`. (Keuntungannya: Sangat ringan, tidak perlu install database antrian luar. Jika proyek membesar, kita bisa swap *class* ini ke Redis/RabbitMQ tanpa merusak kode *agent*).
- **External Communication (Frontend-Bridge):** Menggunakan `Socket.io` untuk melakukan *streaming* log pemikiran agen, perubahan *state*, dan obrolan antar agen langsung ke UI secepat kilat.

## 2. Arsitektur Modular (ECS-Inspired)

CrowdOS menggunakan arsitektur **Entity-Component-System** untuk agen:

```
┌──────────────────────────────────────────────────────────┐
│                    ENTITY (Agent Identity)                │
│  Hanya identitas: id, display_name, species, tier, level │
└──────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐   ┌──────────────────┐   ┌──────────────┐
│ ModelModule  │   │ InstructionModule│   │ ToolkitModule│
│ (LLM Config) │   │ (System Prompt)  │   │ (Tools)      │
└──────────────┘   └──────────────────┘   └──────────────┘
┌──────────────┐   ┌──────────────────┐
│ConstraintsMod│   │CapabilitiesModule│
│ (Safety)     │   │ (Skills)         │
└──────────────┘   └──────────────────┘

                    RUNTIME (System)
┌──────────────────────────────────────────────────────────┐
│  RuntimeEngine: orchestrates modules + overrides         │
│  RuntimeOverride: temporary patches on agent behavior    │
│  RuntimeState: tracks live execution state               │
└──────────────────────────────────────────────────────────┘
```

### Keunggulan Modular:
- **Reusability:** Satu ModelModule bisa dipakai banyak agen
- **Separation:** Ganti instruksi tanpa menyentuh konfigurasi model
- **Runtime Patching:** Override instruksi sementara tanpa ubah profil asli
- **Composability:** Rangkai agen baru dari modul-modul yang sudah ada

## 3. Struktur Agen & State Management

**Konsep Stateless & Stateful:**
- **Level 1 & Level 2:** Memerlukan *Stateful Memory* (Mengingat percakapan di *thread* utama, menyimpan instruksi).
- **Level 3 (Worker):** Murni *Stateless*, hanya menerima input, mengerjakan, mengeluarkan output, lalu mati / idel hingga diperintah kembali.
- **Level 3 (Supervisor):** *Stateful* untuk membandingkan perintah (*task diffing*). Menimbang variabel status: `is_major_revision` atau `is_minor_revision` untuk mentrigger *context flush* pada Worker.

### Runtime State Tracking
Setiap agen yang aktif memiliki runtime state:
```typescript
interface RuntimeState {
  sessionId: string;
  agentId: string;
  status: 'idle' | 'working' | 'paused' | 'offline';
  activeTask?: string;
  activeChannelId?: string;
  startedAt?: Date;
  overridesApplied: string[];    // IDs of active runtime overrides
}
```

## 4. Komponen Inti (Core Engine)

### Module Registry (Cognitive Modules Warehouse)
Tempat penyimpanan dan manajemen semua modul kognitif:
- **ModelModule Registry:** CRUD untuk konfigurasi LLM (provider, model name, parameters)
- **InstructionModule Registry:** CRUD untuk system prompt templates dengan flag `runtime_patchable`
- **ToolkitModule Registry:** CRUD untuk bundles of tool permissions
- **ConstraintsModule Registry:** CRUD untuk safety rules dan batasan
- **CapabilitiesModule Registry:** CRUD untuk skill declarations dan function schemas

### Agent Registry (Agent List Office)
Mencatat semua identitas agen beserta referensi ke modul-modul yang digunakan:
- Agent ID, Name, Species, Tier, Authority Level
- Module references: modelModuleId, instructionModuleId, toolkitModuleId, dll.
- Authority permissions: spawn_agents, patch_runtime, dll.
- Status, Fallback, Omniscient tag

### Runtime Override Engine
Memungkinkan modifikasi instruksi agen saat runtime:
```typescript
interface RuntimeOverride {
  id: string;
  targetAgentId: string;
  overrideType: 'runtime_patch' | 'temp_permission' | 'context_inject';
  instructionPatch?: {
    append?: string[];      // Tambahan instruksi
    replace?: string[];     // Replace instruksi tertentu
  };
  expiresAt?: Date;         // Opsional: auto-expire
  createdBy: string;
}
```

### Router / Dispatcher (The CEO Engine)
Logic bagi Level 1 untuk membaca daftar dari *Agent Registry*, membuat *mapping* kecocokan (*semantic routing* atau deskriptif) terhadap input dari User, lalu membuat *Thread/Channel* baru untuk penugasan Level 2.

### The Channel Controller
Komponen yang mengatur *visibility* pesan bergantung pada level.
- *Channel A:* Level 1 dan L2 berdiskusi tentang target bisnis. User bisa melihatnya.
- *Channel B:* Level 2 dan L3 Worker/Spv berdiskusi men-debug kode. User **bisa** melihatnya, Level 1 **tidak perlu memahaminya** (untuk menghemat token L1), tapi L1 bisa di-*mention* `@CEO` ke dalam Channel B jika dibutuhkan bantuan.

## 5. Mekanisme Penanganan Loop (Loop Arbitration)
Untuk menangani *infinite loop*:
1.  **Token / Turn Limit:** Batasan jumlah percakapan otomatis di suatu *channel* dalam kurun waktu tanpa campur tangan (*idle limit*).
2.  **Supervisor Hook:** *Condition* di mana Supervisor jika mendeteksi *Worker* gagal tes otomatis setelah 3x pengulangan berturut-turut, maka Supervisor akan melempar notifikasi (*escalation*) ke Level 2, dan proses berhenti (menunggu *User Intervention* / `@mention`).

## 6. Standar Teknologi Resmi (Tech Stack)
Keputusan *delivery* produk final adalah berupa **Fullstack Web App**.
- **Backend (Core Engine & API):** Node.js menggunakan *framework* ringan (Express atau Fastify). Ditulis dengan format **TypeScript (Wajib)** guna menjaga keamanan jaring struktur tipe data *Event Message* antar agen.
- **Frontend (Web Interface):** **Vite + React (TypeScript)** berpadu TailwindCSS (untuk mendapatkan *layouting* dinamis khas *Discord Server/OS*).
- **Komunikasi Realtime:** `Socket.io` (Jembatan dari Server Node.js meneruskan *event* ke UI React).
- **LLM I/O Standardization:** Pola *Agnostic Adapter* agar *user* (di antarmuka UI) bebas memasukkan API Key untuk model OpenAI, Anthropic, Gemini, maupun menunjuk URL Llama lokal tanpa error.
