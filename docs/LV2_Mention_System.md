# 🧩 Level 2 Feature Spec: Mention System

> **CrowdOS Alignment:** Mention system works with identity-driven agents. `@agentName` refers to the agent's identity (`name` field). Mention resolution loads minimal agent info + runtime state to determine availability. The system remains largely unchanged since agent identity is the primary resolution mechanism.

## 1. Konsep Mention (The @Tag System)
Mengadopsi sistem mention Discord secara fungsional dan visual, Mention adalah mekanisme utama interaksi di Community Agent. Mention bukan sekadar teks — ia membawa **metadata** yang mempengaruhi perilaku agen.

## 2. Format Mention

### 2.1 Tipe Mention yang Didukung
| Format | Target | Contoh | Deskripsi |
|--------|--------|--------|-----------|
| `@agentName` | Agen spesifik (by name) | `@TechLead_Rizal` | Memanggil agen berdasarkan display name |
| `@agentId` | Agen spesifik (by ID) | `@agent_a1b2c3` | Memanggil agen berdasarkan unique ID |
| `@authLevel` | Seluruh agen di level tersebut | `@Level2`, `@L3` | Mention role/level — semua agen di level tersebut di channel ini menerima flag |

### 2.2 Aturan Karakter
- Agent Name **tidak boleh mengandung spasi** — gunakan underscore (`_`) atau camelCase.
- Agent Name bersifat **case-insensitive** saat matching (`@techlead_rizal` = `@TechLead_Rizal`).
- Karakter valid: `a-z`, `A-Z`, `0-9`, `_`.

## 3. UI Autocomplete (Frontend)

### 3.1 Trigger
- User mengetik karakter `@` di InputBar → muncul **dropdown autocomplete** layaknya Discord.
- Dropdown menampilkan:
  - Daftar agen yang relevan di channel/workspace saat ini.
  - Role/Level labels (`@Level1`, `@Level2`, `@Level3`).
  - Filter secara real-time saat user melanjutkan mengetik.

### 3.2 Selection Flow
```
User mengetik "@Tech"
    │
    ▼
┌──────────────────────┐
│ 🔍 @TechLead_Rizal   │ ← L2, Database Expert
│    @TechCoder_Alpha  │ ← L3, Worker
│    @Level2           │ ← Role Mention
└──────────────────────┘
    │
    User klik atau tekan Enter
    │
    ▼
Input berubah menjadi Mention Form (token khusus, bukan raw text)
```

### 3.3 Mention Form (Internal Representation)
Saat user memilih mention dari autocomplete, UI **tidak** menyimpan raw text `@TechLead_Rizal`. Sebagai gantinya, UI menggunakan **token khusus** yang terpisah dari teks biasa:

```json
// Message payload dari Frontend ke Backend
{
  "channelId": "ch_abc123",
  "content": "Tolong tinjau struktur database ini",
  "mentions": [
    {
      "type": "agent",        // "agent" | "role"
      "targetId": "agent_rizal_001",
      "targetName": "TechLead_Rizal",
      "position": 0           // Posisi karakter di content (untuk rendering)
    }
  ]
}
```

**Keuntungan:**
- Backend **tidak perlu regex parsing** — mention sudah terstruktur sebagai metadata.
- Jika agen rename, mention lama tetap valid karena merujuk ke `targetId`.
- UI bisa render mention dengan styling khusus (highlight, warna) tanpa parsing ulang.

## 4. Mention Behavior & Trigger Matrix

### 4.1 Default Behavior (Tanpa Mention)
Semua agen yang ada di channel **bisa membaca** pesan baru melalui blok `Shared Memory` (sesuai visibility policy). Agen merespons **berdasarkan konteks dan role-nya**, bukan karena di-mention.

### 4.2 Efek Mention
Mention **tidak menggantikan** default behavior, melainkan **menambahkan flag** ke pesan:

| Flag | Efek pada Agen Target |
|------|----------------------|
| `critical` | Pesan ditandai sebagai **high priority** dalam Shared Memory. Model memberikan attention lebih tinggi. |
| `attention_boost` | Jika mention berasal dari Auth Level **setara** (misal L2 → L2), flag ini meningkatkan bobot pesan dalam context window agen target. |
| `escalation` | Jika User atau agen level atas me-mention agen di channel yang bukan home-nya, agen tersebut **dipanggil masuk** ke channel tersebut. |

### 4.3 Trigger Matrix
| Pengirim | Target | Behavior |
|----------|--------|----------|
| User → L1 di `#general` | L1 | L1 merespons (default channel behavior) |
| User → L2 di `#general` | L2 | L2 merespons jika ada di channel. Jika tidak, sistem tidak route otomatis — User harus masuk channel L2 |
| User → `@authLevel` (misal `@L2`) | Semua L2 di channel | Semua agen L2 di channel menerima `critical` flag |
| L1 → L2 via dispatch | L2 | L2 transisi ke 🟢 Active (via EventBus, bukan mention) |
| L2 → L2 lain di channel sama | L2 | `attention_boost` flag (peer emphasis) |
| L2 → L3 via dispatch | L3 | L3 di-spawn oleh SpawnManager (bukan mention) |
| L3 Supervisor → L2 (eskalasi) | L2 | `escalation` flag — L2 mendapat report di channelnya |
| User → `@CEO` di channel L3 | L1 | L1 **dipanggil masuk** ke channel L3 untuk intervensi |

### 4.4 Mention di `#general` (Default Channel)
- `#general` adalah sandbox untuk interaksi langsung dengan L0/L1.
- Jika User mengetik tanpa mention: **L0 agents** merespons secara default (jika ada).
- Jika ada **2+ agen L0**, keduanya merespons **secara paralel**, lalu mulai saling menanggapi melalui shared memory.
- User bisa mengatur **urutan respons** L0 via Workspace Settings (opsional).
- Agen non-L0 di `#general` hanya merespons **jika di-mention secara eksplisit**.

## 5. Agent-to-Agent Mention (LLM Output Parsing)

### 5.1 Masalah
Saat agen merespons, LLM mungkin menghasilkan teks yang mengandung mention (`@AgentName`). Output ini perlu divalidasi karena LLM bisa salah mengetik nama agen.

### 5.2 Solusi: Post-Processing Validation Layer
```
LLM Output
    │
    ▼
Regex Parse: /@(\w+)/g
    │
    ▼
Untuk setiap match:
    ├── Exact match di Agent Registry?
    │   └── ✅ Inject mention metadata (sama seperti dari UI)
    │
    ├── Typo / close match? (Levenshtein distance ≤ 2)
    │   └── 🔄 Auto-correct ke closest match + log warning
    │
    └── Tidak ditemukan sama sekali?
        └── ⚠️ Strip mention formatting, kirim sebagai teks biasa
            + log warning ke system
```

### 5.3 Prevention (Prompt Engineering)
Untuk meminimalisir mention salah, `MemoryBuilder` menyisipkan daftar agen yang tersedia di channel ke dalam prompt:
```xml
[Available Agents in this channel]
- @TechLead_Rizal (Level 2, Database Expert)
- @CoderAlpha (Level 3, Worker)
- @QA_Inspector (Level 3, Supervisor)
```
Dengan informasi ini, model LLM akan lebih akurat saat menulis mention.

## 6. CrowdOS Integration

### Mention Resolution with Modules
- Saat `@agentName` di-resolve, sistem mengambil `RuntimeState` agent untuk mengecek apakah agent sedang `active`, `paused`, atau `offline`.
- Jika agent di-mention saat `is_paused = true`, sistem memberikan warning ke pengirim: "Agent [name] is currently paused."
- Autocomplete di UI menampilkan agent name + species + tier (dari identity) tanpa perlu load seluruh modul.

### Post-Processing with Identity
- LLM output parsing menggunakan `AgentRegistry` yang berisi data minimal (name, species, tier) untuk validasi mention.
- InstructionModule tidak perlu di-load untuk validasi mention — cukup identity sudah cukup.

## 7. Checklist Progress
- [ ] Implementasi UI autocomplete dropdown di `InputBar.tsx`.
- [ ] Definisikan Mention metadata format di message payload.
- [ ] Implementasi mention flag system (`critical`, `attention_boost`, `escalation`).
- [ ] Implementasi post-processing validation layer untuk LLM output.
- [ ] Integrasi mention injection di `MemoryBuilder` (daftar agen di channel).
- [ ] Implementasi `@authLevel` role mention broadcast.
- [ ] Buat konfigurasi `#general` default L0 response behavior.
- [ ] Integrasikan RuntimeState check pada mention resolution (paused/offline detection).
