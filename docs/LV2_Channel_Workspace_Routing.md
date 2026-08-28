# 🧩 Level 2 Feature Spec: Channel, Category & Workspace Routing

## 1. Konsep Hierarki Ruang Kerja (Category → Channel)
Dalam kerangka "Community Agent", ruang kerja menggunakan hierarki **2 level** mengikuti struktur Discord:

```
Server (Workspace)
│
├── #general                        ◄── Top-level, di luar semua Category
│                                       Default channel, selalu ada
│
├── 📁 Category A (L1-A Permission)
│   ├── #channel-1
│   ├── #channel-2
│   └── #channel-3
│
├── 📁 Category B (L1-B Permission)
│   ├── #channel-4
│   └── #channel-5
│
└── 📁 Category C (User-Created)
    └── #channel-6
```

### Aturan Hierarki
- **2 level saja:** Category → Channel. Tidak ada sub-channel atau thread di dalam channel.
- **`#general`** berada di **luar** semua Category (paling atas), selalu ada sejak server pertama kali dibuat.
- Category bisa dibuat oleh **User** langsung, atau oleh **L1 Agent** (via MCP tool `create_workspace`).

## 2. Default Channel: `#general`

`#general` adalah sandbox utama untuk interaksi dengan agen tingkat atas:

| Behavior | Detail |
|----------|--------|
| **L0 Default Response** | Jika ada agen L0, mereka merespons pesan user di `#general` **secara otomatis** tanpa perlu di-mention |
| **Multi-L0** | Jika ada 2+ agen L0, **keduanya merespons secara paralel**. Setelah respons awal, shared memory (history chatroom) mulai masuk ke konteks masing-masing L0 agar mereka bisa **saling menanggapi** |
| **L0 Response Order** | User bisa mengatur urutan respons L0 via Workspace Settings (opsional). Secara default: paralel |
| **L1 di #general** | L1 merespons **hanya jika di-mention** (`@CEO`, `@LeadAgent`, dll.) |
| **Non-L0/L1 Agent** | Agen selain L0/L1 **hanya merespons jika di-mention secara eksplisit** |

## 3. Alur Aktivasi Konteks Bekerja (The Trigger Flow)

1.  **Pembuatan Ruang:** User menekan tombol buat *Category* baru (misal: `Database Refactor`), lalu buat *Channel* di dalamnya (misal: `#schema-analysis`). Memori/riwayat obrolan di dalamnya benar-benar kosong (*fresh start*).
2.  **Pemanggilan (Mentioning):** User masuk ke channel dan mention agen: *"@TechLead_Rizal tolong deploy tim untuk merombak skema PostgreSQL kita."*
3.  **Atau via L1 Dispatch:** L1 secara otomatis membuat Category + Channel via Bipolar Dispatch dan assign L2 ke dalamnya.
4.  **Bekerja Terisolasi:** Segala pembagian tugas, spawning L3 pairs, dan eksekusi terjadi di dalam isolasi Channel tersebut.

## 4. Isolasi Multi-Tasking L2 (Channel Scoping)
*   **Context Scoping:** Jika agen L2 "Database Expert" diundang ke `#project-A` dan `#project-B` bersamaan, framework mengatur bahwa *Memory Array* dari agen tersebut diklasifikasikan menggunakan `Channel ID`. Tidak ada crossover konteks.
*   **Paralelisme Murni:** Satu Agen Spesialis L2 bisa membimbing belasan L3 di beberapa channel berbeda secara serentak tanpa tertukar konteks.
*   **L2 Dual Chatroom:** Setiap L2 yang aktif memiliki **2 chatroom terpisah** per task:
    1. Channel dengan L1 (konteks arahan, strategi).
    2. Channel dengan L3 pairs (konteks eksekusi, review).

## 5. Category Permission Model

### L1 Agent Permissions
- L1 memiliki **full edit/manage** pada Category yang menjadi miliknya (Category yang dia buat atau yang di-assign oleh User).
- L1-A **tidak bisa** mengakses/mengedit Category milik L1-B **secara default**.
- User bisa menambahkan **cross-Category permission** di Agent Profile L1 jika dibutuhkan.
- L1 bisa membuat channel baru, menghapus channel, dan mengelola semua aspek di dalam Category miliknya.

### Agent Assignment
- L1 (via Bipolar Orchestrator) yang bertugas **memanggil dan assign agen** ke Category/Channel tertentu.
- L2 dan L3 **tidak bisa** berpindah channel sendiri — harus di-assign oleh L1 atau User.
- L2 di Category A bisa juga di-assign ke Category B jika diperlukan (oleh L1 yang punya akses, atau User langsung).

## 6. Channel Lifecycle (CRUD)

### Create
- User membuat via UI, atau L1 membuat via MCP tool `create_workspace`.
- Channel baru = memori kosong, fresh start.

### Read
- Semua channel visible di sidebar UI untuk User.
- Private pair channels (L3 Worker-Supervisor) juga visible tapi ditandai khusus.

### Archive
- Alternatif penghapusan permanen.
- Channel di-archive: **tidak bisa digunakan lagi** untuk chat aktif, tapi riwayat pesan **dipertahankan** untuk referensi.
- Agen yang bekerja di channel archived → status berubah ke 🟡 Idle.
- Channel archived tidak muncul di sidebar utama, tapi bisa diakses via menu "Archived Channels".

### Delete
- Channel dihapus **permanen**.
- Semua context history di channel tersebut **dihapus** dari database.
- Agen yang sedang bekerja di channel → status berubah ke 🌑 Offline (L3) atau 🟡 Idle (L2).
- Semua EventBroker listeners terkait channel di-cleanup (`removeChannelListeners`).

## 7. Database Schema
```typescript
interface Category {
  id: string;
  name: string;
  ownedByAgentId?: string;    // L1 yang memiliki category ini
  createdBy: string;           // "user" atau agent ID
  position: number;            // Urutan tampilan di sidebar
  createdAt: Date;
}

interface Channel {
  id: string;
  categoryId: string | null;  // null = top-level (#general)
  name: string;                // Termasuk # prefix
  type: 'standard' | 'pair_private' | 'archived';
  createdBy: string;
  position: number;
  createdAt: Date;
  archivedAt?: Date;
}
```

## 8. Checklist Progress
- [ ] Buat Skema DB `Categories` dan `Channels` (dengan tipe dan relasi).
- [ ] Implementasi `#general` sebagai default channel (auto-create saat workspace init).
- [ ] Pastikan Logic `EventBroker` menempelkan `channelId` pada setiap Event.
- [ ] Implementasi Category permission model (L1 ownership, cross-category access).
- [ ] Siapkan Logic Prompt `MemoryBuilder` — filter obrolan berdasarkan `channelId`.
- [ ] Implementasi Channel Archive (soft delete + read-only access).
- [ ] Implementasi Channel Delete (hard delete + cleanup listeners + agent status transition).
- [ ] Implementasi Multi-L0 parallel response di `#general`.
- [ ] Buat UI: Category/Channel tree di sidebar (mirip Discord server navigation).
