# 🧩 Level 2 Feature Spec: Module Workshop & Workspace Settings (CrowdOS)

## 1. Konsep Terpusat (Server Settings + Module Workshop)
CrowdOS memisahkan pengaturan menjadi dua area:
1. **Module Workshop** — Tempat membuat dan mengelola 5 tipe modul kognitif (Model, Instruction, Toolkit, Constraints, Capabilities)
2. **Workspace Settings** — Database URL, Token Budget, Embedding & Indexing profiles

## 2. Module Workshop (5 Module Types)

### 2.1 ModelModule (Otak Agen)
Template koneksi untuk model AI yang digunakan agen untuk *berpikir* dan menghasilkan respons.

**Atribut:**
*   **Label:** Nama kustom (misal: "Flagship Reasoning L1", "Local Coder L3").
*   **Provider Engine:** `google`, `openai`, `anthropic`, `ollama`, atau `custom`.
*   **Exact Model Name:** String asli nama model (misal: `gemini-2.0-pro`). ⚠️ **Tidak boleh dimodifikasi oleh sistem — selalu ikuti input user.**
*   **Auth / Endpoint URL:**
    *   Cloud: API Key.
    *   Local: Alamat IP + Port, atau URL endpoint.
*   **Generation Parameters (Sandbox):**
    *   `temperature` (float, 0.0–2.0)
    *   `topP` (float, 0.0–1.0)
    *   `maxOutputTokens` (integer)
    *   `stopSequences` (string[])
*   **Context Window Config:**
    *   `maxRecentMessages` (integer, default: 30) — Tier 2 sliding window
    *   `enableCompression` (boolean, default: true) — Tier 3 summary
    *   `compressionThreshold` (integer, default: 50) — Mulai compress setelah N pesan total

**Catatan:** ModelModule bersifat **sandbox** — user bisa membuat sebanyak-banyaknya dengan variasi parameter berbeda.

### 2.2 InstructionModule (System Prompt Template)
Modul yang berisi instruksi / system prompt agen:

**Atribut:**
*   **Label:** Nama kustom (misal: "Architect Core", "Coder Basic", "QA Strict").
*   **Base Instructions:** Array dari baris instruksi (multi-line text).
*   **Runtime Patchable:** Toggle — apakah module ini bisa di-override saat runtime.

### 2.3 ToolkitModule (Tool Permissions Bundle)
Bundle dari tool permissions yang bisa digunakan agen:

**Atribut:**
*   **Label:** Nama kustom (misal: "Architect Toolkit", "Coder Toolkit").
*   **Tools:** Multi-select dari Tool Registry.

### 2.4 ConstraintsModule (Safety Rules)
Modul berisi aturan keamanan dan batasan:

**Atribut:**
*   **Label:** Nama kustom (misal: "Safe Reasoning v2").
*   **Rules:** Array dari constraint rules.
*   **Disallowed Actions:** Array dari tindakan yang dilarang.

### 2.5 CapabilitiesModule (Skill Declarations)
Modul deklarasi kemampuan/skill agen:

**Atribut:**
*   **Label:** Nama kustom (misal: "Reasoning Planner").
*   **Skills:** Array dari skill yang dimiliki.
*   **Function Schemas:** JSON schemas untuk custom functions (opsional).

## 3. Embedding & Indexing (Legacy Provider Profiles)

### 3.1 Embedding Model Profile (Pencarian Vektor)
Template koneksi untuk model AI yang menghasilkan embedding vector, digunakan untuk **pgvector RAG**.

**Atribut:**
*   **Profile Label:** Nama kustom.
*   **Provider Engine:** `google`, `openai`, `ollama`, atau koneksi privat.
*   **Exact Model Name:** String model embedding.
*   **Auth / Endpoint URL:** Seperti di atas.
*   **Embedding Dimensions:** Integer — dropdown opsi: `256`, `512`, `768`, `1024`, `1536`, `3072`.

**Assignment:** Setiap **Category** bisa di-configure menggunakan Embedding Profile yang berbeda.

### 3.2 Indexing Model Profile (Ringkasan & Knowledge Index)
Template koneksi untuk model murah/cepat yang bertugas:
- Membuat **topic summary/index** per Channel/Category (untuk L0 browser).
- Melakukan **compression/summarization** Tier 3 di Memory Management.

## 4. Database Storage (PostgreSQL + pgvector)
Sebagai pilar utama penyimpanan Memori, CrowdOS secara eksklusif menggunakan **PostgreSQL**.

*   **UI Input:** User memasukkan `DATABASE_URL` ke dalam UI *Workspace Settings*.
*   **Auto Schema Push:** Test koneksi → `CREATE EXTENSION IF NOT EXISTS vector;` → Push schema.
*   User **tidak perlu** menjalankan migration manual.

## 5. Integrasi & Keuntungan
*   **Module Selector:** Setelah module dibuat, langsung muncul di dropdown Agent Editor.
*   **Reusability:** Satu module bisa dipakai banyak agen.
*   **No Hardcoding:** Semua kredensial via UI.

## 6. Token Budget & Usage Monitoring
*   **Per-Provider Budget:** Soft cap token usage per API provider.
*   **Usage Bar:** Visualisasi `used / softCap`.
*   **Warning:** 80% soft cap.
*   **Error:** Soft cap tercapai.
*   **Reset Period:** daily / weekly / monthly / never.

## 7. Fitur Disable/Enable
Jika Embedding Model tidak di-set oleh user:
- Fitur RAG / L0 Omniscient otomatis **disabled**.
- Info: "Embedding model belum dikonfigurasi."

## 8. Checklist Progress
- [ ] Buat 5 Module CRUD forms di Module Workshop UI
- [ ] Buat backend CRUD endpoints untuk ModelModule
- [ ] Buat backend CRUD endpoints untuk InstructionModule
- [ ] Buat backend CRUD endpoints untuk ToolkitModule
- [ ] Buat backend CRUD endpoints untuk ConstraintsModule
- [ ] Buat backend CRUD endpoints untuk CapabilitiesModule
- [ ] Buat UI Form `DATABASE_URL` + Auto Schema Push
- [ ] Buat UI Form CRUD untuk Embedding Model Profile
- [ ] Buat UI Form CRUD untuk Indexing Model Profile
- [ ] Implementasi "Test Connection" button
- [ ] Implementasi Module Selector dropdowns di Agent Editor
- [ ] Implementasi Token Budget system
