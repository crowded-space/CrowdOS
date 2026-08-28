# 🧩 Level 2 Feature Spec: Memory & Context Architecture

> **CrowdOS Alignment:** This doc aligns with CrowdOS modular architecture. Agents reference `InstructionModules` for their system prompts, and `RuntimeState` tracks execution context including memory state.

## 1. Konsep Dual-Memory (Self vs Shared)
Agar agen tidak halusinasi, tidak melupakan tugas aslinya, namun tetap mengetahui obrolan agen lain, sistem otak (Context Prompting) agen memisahkan memori ke dalam 2 blok utama saat dikirim ke LLM (sebagai satu *prompt* gabungan).

### A. Independent Memory (Self-Scratchpad)
*   **Sifat:** Terisolasi (Private). Agen lain tidak bisa membacanya tanpa izin.
*   **Fungsi:** Menyimpan riwayat tindakan pribadi agen tersebut.
*   **Isi:** 
    *   Tugas orisinal yang diberikan padanya.
    *   Riwayat panggilan alat (*Tool Calling History*), misal: "Saya sudah mengeksekusi file X".
    *   Hasil pemikiran internal sebelum dibagikan ke orang lain (*Internal Monologue* / Delegasi tugasnya ke agen di bawahnya).
    *   Runtime overrides aktif (dari `RuntimeOverride`) — disuntikkan di sini agar agent sadar terhadap patch perilaku sementara.
*   **Catatan:** L3 Worker **tidak memiliki** Independent Memory (stateless). Hanya L1, L2, dan L3 Supervisor.

### B. Shared Memory (The Chatroom / Channel)
*   **Sifat:** Terbuka sesuai konfigurasi *Memory Sharing Policy* dan *Authority Level*.
*   **Fungsi:** Kesadaran lingkungan (*Situational Awareness*). Membuat agen sadar ada *update* dari agen lain di saluran/ruang obrolan yang sama.
*   **Isi:** Obrolan persis seperti di channel Discord.
*   **Penting:** L2 memiliki **2 chatroom terpisah** — satu dengan L1 (arahan) dan satu dengan L3 (eksekusi). L1 **tidak berada** di chatroom yang sama dengan L3.

## 2. Visibility Matrix (Memory Sharing Policy Enforcement)

Tabel berikut mendefinisikan pesan mana saja yang masuk ke blok Shared Memory agen berdasarkan policy-nya:

| Policy | Pesan yang di-inject ke Shared Memory |
|--------|---------------------------------------|
| `none` | **Hanya** pesan yang ditujukan langsung via `@mention`. Tidak melihat obrolan lain sama sekali. Sepenuhnya wewenang dan tanggung jawab User yang mengatur policy ini. |
| `horizontal` | Pesan dari agen **se-level** di channel yang sama + pesan yang `@mention` langsung. |
| `vertical` | Pesan dari **1 level atas** (atasan langsung) + **1 level bawah** (bawahan langsung) + `@mention` langsung. Hanya yang **relevan**: L1-A ↔ L2-A, **bukan** L1-A ↔ L2-B. |
| `full` | **Semua** pesan di channel tersebut, tanpa filter. Transparan. |

### Aturan Tambahan
- **L0 Omniscient** tidak menggunakan visibility matrix — L0 menggunakan **grep/browse tool** yang bisa mengakses channel lain secara terpisah (bukan full injection ke Shared Memory).
- **`@mention`** dari Auth Level **setara** memberikan **critical/important flag** yang meningkatkan bobot attention model penerima.

## 3. Struktur Prompt Shared Memory (XML-Like Tagging)
Agar LLM dapat dengan mudah membedakan mana obrolan miliknya dan mana obrolan orang lain, `Shared Memory` direpresentasikan (di-inject) ke dalam prompt LLM menggunakan struktur penanda seperti XML. 
Sistem ini dengan cerdas menyisipkan identitas (`from`) dan otoritas (`Level`) si pengirim pesan.

**Contoh Injeksi Konteks ke LLM:**
```xml
[Shared Channel: #code-debugging]

<message from="User" level="Stakeholder">
Aplikasi kita error saat login. Coba perbaiki db-nya!
</message>

<message from="System Architect" level="1">
Baik! Saya mendelegasikan analisis log dan pengecekan DB ke Manager.
</message>

<message from="Database Manager" level="2">
Berikut adalah log error-nya. Saya menyuruh pekerja Coder untuk memperbaikinya.
</message>

<message from="QA Agent" level="2" mention="@Database Manager" flag="attention_boost">
Pastikan Coder tidak menghapus tabel existing!
</message>
```

**Catatan tambahan:** Pesan yang mengandung `@mention` ditandai dengan atribut `mention` dan `flag` di dalam tag XML, membantu LLM memahami urgensi dan target pesan.

## 4. Keunggulan Arsitektur Ini
*   **Boundary yang Kuat:** Model LLM secara semantik sangat baik dalam memahami format tag XML (`<message>`). Ini mencegah model berhalusinasi "meniru" atau membalas bertindak seolah dia adalah `QA Agent` padahal dia adalah `Database Manager`.
*   **Kesadaran Hierarki:** Dengan disematkannya `level="2"`, agen otomatis tahu cara bersikap. Pekerja L3 tidak akan berani melawan instruksi jika tag pengirimnya adalah `level="1"`.
*   **Channel Bebas Hambatan:** Obrolan berapapun panjangnya tetap terstruktur layaknya membaca naskah drama teater, membuat output *reasoning* LLM jauh lebih terarah.

## 5. Token Window Management (Hybrid 3-Tier)

### Tier 1: PINNED (Tidak Pernah Dihapus)
- System Prompt, Authority Context, Task File (L3), Tool Schemas
- Selalu masuk ke prompt

### Tier 2: RECENT (Sliding Window)
- N pesan terakhir di Shared Memory
- `N` = configurable per Model Profile (`maxRecentMessages`, default: 30)
- Disimpan mentah tanpa modifikasi

### Tier 3: COMPRESSED (Summary)
- Pesan **sebelum** sliding window
- Diringkas menjadi 1 paragraf summary oleh **Indexing Model** (model murah dari Workspace Settings)
- Summary di-**cache di database** — tidak di-generate ulang setiap kali
- Compression dimulai setelah total pesan melewati `compressionThreshold` (default: 50)

Untuk detail konfigurasi, lihat `LV2_Prompt_Assembly.md`.

## 6. L0 Omniscient — Index Knowledge System

### Fungsi
Agen L0 memiliki kemampuan grep/browse menembus seluruh channel **tanpa** full injection ke Shared Memory. Mekanismenya:

1. **Knowledge Index:** Setiap Channel/Category memiliki `topic_summary` yang diringkas secara periodik oleh **Indexing Model**.
2. **Index Format:** Disimpan di database tabel `channel_index`:
   ```typescript
   interface ChannelIndex {
     channelId: string;        // FK → Channel
     channelPath: string;      // "Category A / #channel-name"
     topicSummary: string;     // Ringkasan topik (1-3 kalimat)
     lastIndexedAt: Date;
     messageCountSinceIndex: number;  // Untuk trigger re-index
   }
   ```
3. **Akses:** Hanya agen dengan tag **L0 Omniscient** yang bisa memanggil tool `search_all_channels` (via function calling), yang membaca index ini terlebih dahulu untuk menentukan channel mana yang relevan, baru fetch detail pesan dari channel tersebut.
4. **Update Periodik:** Index di-generate ulang secara CRON (misal: setiap 30 menit, atau saat `messageCountSinceIndex` melewati threshold).
5. **Model:** Menggunakan **Indexing Model** dari Workspace Settings (model murah).

### Kenapa Browse, Bukan Full Injection?
- Full injection semua channel → **token explosion** (prompt bisa ratusan ribu token).
- Browse = L0 membaca **index dulu** (ringan), lalu **fetch detail** hanya dari channel yang relevan.
- Jauh lebih efisien dari segi cost dan latency.

## 7. CrowdOS Integration

### Runtime State in Memory
- `RuntimeState` (dari CrowdOS schema) disinkronkan dengan Independent Memory. Setiap kali agent menyelesaikan siklus pemikiran, `RuntimeState.last_active_at` diperbarui.
- `RuntimeState.is_paused` dicek oleh MemoryBuilder — jika true, agent tidak di-assign task baru.

### Module References
- Agent di MemoryBuilder tidak menggunakan `AgentProfile.systemPrompt` langsung, melainkan me-load dari `InstructionModule` yang direferensikan oleh Agent.
- Jika ada `RuntimeOverride` aktif untuk agent tersebut, instruksi override disuntikkan ke Independent Memory sebagai blok terpisah.

## 8. Checklist Progress
- [ ] Buat modul Node.js (Format Parser) yang mengubah JSON Database Messages ke format string XML Tagging (termasuk mention flag).
- [ ] Implementasi visibility matrix filtering di MemoryBuilder.
- [ ] Implementasi Hybrid 3-Tier token management (Pinned, Recent, Compressed).
- [ ] Implementasi compression pipeline menggunakan Indexing Model + caching di DB.
- [ ] Pastikan injeksi `Independent Memory` berada setelah blok `Shared Memory` dalam urutan Prompt LLM (lihat `LV2_Prompt_Assembly.md`).
- [ ] Buat tabel `channel_index` dan CRON job untuk periodik indexing.
- [ ] Implementasi tool function `search_all_channels` untuk L0 Omniscient.
- [ ] Integrasikan `RuntimeState` tracking ke dalam MemoryBuilder.
- [ ] Integrasikan `RuntimeOverride` injection ke Independent Memory.
