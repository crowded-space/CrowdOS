# 🚀 CrowdOS — Project Guideline Level 0: The Vision & Product

## 1. Konsep Utama: "CrowdOS"
Proyek ini resmi dinamakan **CrowdOS (Cognitive Agent System)**, sebelumnya dikenal sebagai "Community Agent". CrowdOS adalah framework multi-agent serbaguna berlandaskan Node.js dengan arsitektur **ECS-inspired (Entity-Component-System)**.

Terinspirasi dari *Discord* sebagai platform komunitas, CrowdOS berisi berbagai macam individu/agen yang hidup, berdiskusi, dan bekerja sama layaknya sebuah ekosistem digital.

### Core Principles
- **Agent = Identity** — Agen hanyalah identitas (nama, species, tier). Kemampuan direferensikan dari modul eksternal.
- **Modules = Reusable Cognitive Components** — Model, instruksi, toolkit, constraints, dan capabilities adalah modul independen yang bisa digunakan ulang antar agen.
- **Runtime Overrides** — Instruksi agen bisa di-*patch* sementara saat runtime tanpa mengubah profil asli.
- **Hierarchical Delegation** — Hirarki otoritas L0–L3 dengan batasan komunikasi yang ketat.
- **Swarm-Native** — Arsitektur mendukung eksekusi swarm parallel untuk skalabilitas.

Mengusung konsep **Sandbox**, pengguna tidak terkunci pada *pipeline* kaku. Pengguna (*User*) memegang kendali penuh untuk:
- Membuat identitas agen
- Merangkai modul-modul kognitif (model, instruksi, tools, constraints, capabilities)
- Menetapkan hierarki otoritas
- Melakukan runtime override untuk koreksi cepat

## 2. Metafora Sistem (The "Mental Model")
Sistem direpresentasikan secara visual dan secara arsitektur logika layaknya sebuah **Discord Server** yang dipadukan dengan **Struktur Perusahaan**:
- **User (Stakeholder):** Pengendali tertinggi. Memantau dari luar, dapat menginterupsi, dan memberikan arahan besar.
- **Server/Channel (Ruang Rapat):** Tempat di mana konteks (*context/working memory*) dibagikan. Percakapan antara agen dapat dipantau oleh user secara real-time demi menjaga transparansi alur berfikir.
- **Agent List Office (HRD/Registry):** Direktori berisi daftar agen dan modul-modul kognitif yang tersedia.
- **Modul Workshop (Factory):** Tempat user membuat dan mengelola modul reusable — Model, Instruksi, Toolkit, Constraints, Capabilities.

## 3. Hierarki Otoritas (Authority Levels)
Desain framework membagi wewenang ke dalam beberapa tingkatan (Level) yang memiliki batasan interaksi yang jelas (Konteks Vertikal & Horizontal):

*   👁️ **Level 0 (The Omniscient Assistant)**
    *   **Peran:** Otoritas rasional tertinggi (*Superior Assistant*). Agen dengan tingkatan ini memiliki hak istimewa untuk melakukan `grep` atau `search_context` menembus seluruh *channel* di server dan menyerap segala informasi (Omnipresent).
    *   **Implementasi:** Ini dapat bertindak sebagai *Additional Authority Tag*. Seorang agen Level 1 dapat dianugerahi Tag L0, menjadikannya gabungan L1 (Pikiran Besar) dan L0 (Akses Tanpa Batas).

*   👑 **Level 1 (The CEO/Project Lead)**
    *   **Peran:** Antarmuka utama interaksi logis dengan User. Menerima, menginterpretasi, dan memecah instruksi User menjadi tugas-tugas terukur.
    *   **Perilaku:** Tidak membuat peran agen baru secara *magic*, melainkan membaca daftar agen yang tersedia di "Agent List Office", lalu mendelegasikan tugas kepada agen Level 2 yang paling cocok.
    *   **Spesifikasi:** Disarankan menggunakan Frontier Models (Gemini 3.1 Pro, Deepseek R1, Claude Opus) karena membutuhkan kemampuan *reasoning* tingkat tinggi.

*   👔 **Level 2 (The Board of Directors / Managers)**
    *   **Multiplicity & Diversitas:** Setiap level *tidak terbatas pada 1 agen*. Di Level 2, User bisa mensetup 1 hingga banyak agen independen yang spesialis (misal: "Project Structure Specialist", "Coding Manager", "Data Analyst", "Summary Specialist").
    *   **Tujuan Spesialisasi:** Meringankan beban kognitif LLM. Daripada menuntut satu model menjadi *jack-of-all-trades* (yang rentan menurunkan performa), tugas dipecah ke dalam gugus tugas khusus agar kualitas *reasoning* dan output meningkat tajam.
    *   **Perilaku:** Menerima tugas dari Level 1, menyusun rencana *step-by-step* sesuai porsinya, dan membuat instruksi teknis (*sysprompt*) dinamis untuk dieksekusi oleh pekerja Level 3.
    *   **Konteks Otoritas:** Hanya berkomunikasi dengan Level 1 (Atasan) dan Level 3 (Bawahan).

*   👷 **Level 3 (The Workforce: Worker & Supervisor)**
    *   **Worker (Stateless):** Eksekutor murni (Coder, Data Scraper). Menerima *prompt* sementara dari Level 2, mengerjakan tugas berulang tanpa memikirkan arsitektur besar. Disarankan memakai Local/Cheaper Models.
    *   **Supervisor (Context Manager):** Pendamping Worker. Mengevaluasi hasil kerja Worker. Jika tugas dari Level 2 di-update secara drastis, Supervisor bertugas me-reset ingatan (*context*) Worker agar tidak halusinasi. Jika update bersifat minor (*revision*), Supervisor hanya memberikan *nudge*/saran tambahan.

## 4. Modular Cognitive Architecture

```
┌─────────────────────────────────────────────────────┐
│                    AGENT (Identity)                  │
│  ┌───────────────────────────────────────────────┐  │
│  │  id: "raven.architect.v1"                     │  │
│  │  profile: { display_name, species, tier }     │  │
│  │  modules: {                                  │  │
│  │    model: "google_001",         ← ModelModule  │  │
│  │    instruction: "architect_core",← InstructionModule│
│  │    constraints: "safe_reasoning_v2",← ConstraintsModule│
│  │    tools: "architect_toolkit",  ← ToolkitModule │  │
│  │    capabilities: "reasoning_planner"← CapabilitiesModule│
│  │  }                                            │  │
│  │  authority: { level, permissions }             │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

## 5. Runtime Override System

Konsep baru: instruksi agen bisa di-*patch* saat runtime tanpa mengubah profil permanen.

```json
{
  "target_agent": "crow.worker.22",
  "override_type": "runtime_patch",
  "instruction_patch": {
    "append": ["Focus only on React repositories"]
  }
}
```

**Use case:** L2 ingin memberi instruksi tambahan spesifik ke worker tanpa mengubah template worker asli.

## 6. Mekanisme Keamanan & Interaksi (Mention System)
Setiap agen di ekosistem CrowdOS memiliki entitas `Name String` (`ID`) yang unik.
Sistem memiliki interaksi transparan layaknya komunikasi komunitas:
*   Jika User ingin memberi arahan, User cukup melakukan tag/mention nama agen secara spesifik, misal: `@ManagerAlpha tolong tinjau struktur ini.`
*   Jika perdebatan antar-agen di suatu *channel* mengalami kebuntuan (*infinite loop*), User dapat menengahi (*course correct*) dengan me-*mention* `@[NamaAgentL1]` langsung di dalam *channel* tersebut untuk mengambil alih dan memperbaiki alur logika.

## 7. Long-Term Vision: Swarm-Native Architecture

CrowdOS dirancang untuk berevolusi menuju:
- modular cognitive infrastructure
- hierarchy-driven orchestration
- swarm-native execution (parallel agent swarms)
- provider abstraction (agnostic LLM)
- dynamic runtime cognition (runtime overrides)
- agent governance systems (authority-based permissions)
- ECS-inspired composition (entity = agent, components = modules, system = runtime)
- declarative orchestration runtime

---
*Dokumen ini merupakan Level 0 yang berfokus pada Visi Produk dan Pengalaman Pengguna (UX). Untuk detail teknis Node.js dan struktur state, lihat Level 1.*
