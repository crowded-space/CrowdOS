# 🧩 Level 2 Feature Spec: Agent Creation & Office UI (CrowdOS Modular)

## 1. Konsep Antarmuka (The Visual Metaphor)
Modul ini bertindak sebagai tempat pengguna (User) berkreasi membuat *"Employee"* baru dengan merangkai modul-modul kognitif. 
UI didesain menyerupai **Discord Profile Editor** + **Module Workshop**. Proses peracikan agen terasa seperti menyusun LEGO — pilih identitas, lalu pasang modul-model-modul yang sudah ada.

## 2. Agent Identity (Bukan Profile Lengkap)
Di CrowdOS, agen hanyalah **identitas** + **referensi modul**. Semua kemampuan ada di modul terpisah.

### Identity Fields:
*   **Agent Name:** `Name` — tanpa spasi, gunakan underscore/camelCase.
*   **Species:** Tema spesies (misal: "raven", "crow", "owl", "fox") — opsional, untuk personalisasi.
*   **Title:** Gelar singkat (misal: "Architect v1", "Database Expert").
*   **Avatar/Warna ID:** Opsional.
*   **Authority Level:** L1 CEO, L2 Manager, L3 Worker, L3 Supervisor.
*   **L0 Omniscient Tag:** Checkbox — hanya untuk L1.
*   **Species/Tier Display:** Thematic flair seperti "Raven • Tier Lv1".

### Authority Permissions:
*   **Spawn Agents:** Apakah agent ini boleh spawn L3 pairs.
*   **Patch Runtime:** Apakah agent ini boleh melakukan runtime override.
*   **Access All Channels:** Apakah agent ini punya akses cross-channel.

## 3. Module Composition Selectors

Daripada satu form besar, Agent Editor di CrowdOS memiliki **5 selector** untuk merangkai modul:

### 3.1 Model Module Selector
Dropdown memilih dari daftar **ModelModule** yang sudah ada. Menampilkan:
- Label profil (misal: "Flagship Gemini Pro")
- Provider + Model Name (misal: "google/gemini-2.0-pro")
- Tombol "Buat Module Baru" → shortcut ke Module Workshop

### 3.2 Instruction Module Selector
Dropdown memilih **InstructionModule** yang berisi system prompt:
- Menampilkan preview 3 baris pertama
- Menampilkan badge `[runtime_patchable]` jika module mendukung override
- Runtime override bisa diisi langsung dari halaman ini (inline patch)

### 3.3 Toolkit Module Selector
Dropdown memilih **ToolkitModule** — bundle tools:
- Menampilkan daftar tools yang termasuk
- Checkbox individual untuk override (tambah/kurang tool)

### 3.4 Constraints Module Selector
Dropdown memilih **ConstraintsModule** — safety rules:
- Preview rules yang akan diterapkan

### 3.5 Capabilities Module Selector
Dropdown memilih **CapabilitiesModule** — skill declarations:
- Menampilkan daftar skill yang dimiliki

## 4. Module Workshop (Tempat Buat Modul)

Halaman terpisah untuk mengelola 5 tipe modul:

| Module Type | Form Fields |
|-------------|------------|
| **ModelModule** | Label, Provider, Model Name, API Key, Endpoint, Temperature, TopP, Max Tokens, Stop Sequences, Max Recent Messages, Enable Compression, Compression Threshold |
| **InstructionModule** | Label, Base Instructions (text array), Runtime Patchable (toggle) |
| **ToolkitModule** | Label, Tools (multi-select checkbox dari Tool Registry) |
| **ConstraintsModule** | Label, Rules (text array), Disallowed Actions (text array) |
| **CapabilitiesModule** | Label, Skills (text array), Function Schemas (JSON editor) |

### Module Reusability
- Satu module bisa dipakai oleh banyak agen
- Mengubah module = efek ke semua agen yang menggunakannya
- Clone module untuk membuat variasi tanpa mengubah asli

## 5. Agent Preset / Template System

### 5.1 Built-in Generic Presets
Untuk membantu first-time user, sistem menyediakan **preset templates generik**:

| Preset Name | Level | Module Composition |
|------------|-------|-------------------|
| 📋 "Generic CEO" | L1 | Model: frontier + Instruction: decomposer + Toolkit: dispatch |
| 📋 "Generic Manager" | L2 | Model: balanced + Instruction: coordinator + Toolkit: spawn |
| 📋 "Generic Coder" | L3 Worker | Model: cheap + Instruction: coder + Toolkit: filesystem+bash |
| 📋 "Generic QA" | L3 Supervisor | Model: cheap + Instruction: evaluator + Toolkit: read-only |
| 📋 "Generic Writer" | L3 Worker | Model: cheap + Instruction: writer + Toolkit: filesystem |

### 5.2 Custom Template Operations
- **Save as Template:** Simpan identity + module refs sebagai template
- **Create from Template:** Buat agen baru dari template
- **Export/Import:** Agent config sebagai JSON (portabel)

## 6. Alur Logika (Data Flow)
1. User buka `Agent Office` → lihat daftar agen existing
2. Klik `Create New Agent` → pilih identity fields
3. Pilih module-modul dari dropdown (Model, Instruction, Toolkit, Constraints, Capabilities)
4. Atau buat module baru via `Module Workshop`
5. UI mengirim JSON ke `POST /api/agents`
6. Backend validasi referensi module dan simpan identity
7. Agen baru muncul di sidebar Member list

## 7. Checklist Progress
- [ ] Buat 5 Module form CRUD di Module Workshop UI
- [ ] Buat backend CRUD endpoints untuk 5 module types
- [ ] Buat Agent Editor UI dengan 5 module selectors
- [ ] Implementasi identity-only AgentProfile (tanpa inline config)
- [ ] Implementasi dropdown Module Selector yang connected ke Module Registry
- [ ] Implementasi Runtime Override inline editor di Agent profile
- [ ] Buat built-in preset templates (CEO, Manager, Coder, QA, Writer)
- [ ] Implementasi Save as Template / Create from Template
- [ ] Implementasi Export/Import Agent config (JSON)
- [ ] Integrasi Module Workshop ↔ Agent Editor (shortcut buat module baru)
