# 🧩 Level 2 Feature Spec: Tools Ecosystem & Scheduling

> **CrowdOS Alignment:** Tool permissions are managed via `ToolkitModule` — a reusable module that bundles tool access policies. Agents reference toolkit modules via `agent.toolkitIds[]`. This replaces the monolithic `allowedTools` field on AgentProfile. Multiple agents can share the same ToolkitModule.

## 1. Sistem Alat / Skill (Conventional Tool Calling)
Agen berinteraksi dengan dunia nyata melalui **Tool Functions** — fungsi TypeScript biasa yang dibungkus dengan JSON Schema agar kompatibel dengan LLM function calling (native per provider: Gemini `functionDeclarations`, OpenAI `tools`, dll.).

### Arsitektur Tool System
```
Agent (LLM)
    │
    │ LLM memutuskan tool mana yang dipanggil
    │ (via native function calling)
    │
    ▼
┌─────────────────────────────────────────┐
│            Tool Executor                 │
│                                          │
│  1. Validasi: Apakah agen ini punya     │
│     izin untuk tool ini? (dari          │
│     ToolkitModule via agent.toolkitIds) │
│  2. Safety: Apakah input aman?          │
│     (blacklist, path guard)             │
│  3. Execute: Jalankan handler function  │
│  4. Return: Kembalikan hasil ke LLM     │
│     untuk reasoning selanjutnya         │
│                                          │
└──────────────┬──────────────────────────┘
               │
    ┌──────────┼──────────────┐
    ▼          ▼              ▼
┌────────┐ ┌────────┐  ┌──────────┐
│ File   │ │ Bash   │  │ Agent    │
│ System │ │ Tools  │  │ Dispatch │
└────────┘ └────────┘  └──────────┘
  ...dan tools lainnya
```

**Keuntungan pendekatan konvensional:**
- **Ringan** — tidak perlu setup MCP server/client/transport layer.
- **Langsung jalan** — cukup definisi function + JSON Schema.
- **Upgradeable** — jika di masa depan ingin migrasi ke MCP, tool handler yang sama bisa di-wrap menjadi MCP endpoint tanpa menulis ulang logikanya.

### Otorisasi Per-Agen via ToolkitModule
Otorisasi (*Access & Revoke*) untuk setiap alat **dikendalikan oleh User** melalui UI Agent Editor dengan memilih **ToolkitModule** untuk agent:

*   **ToolkitModule** adalah kumpulan izin tool yang dapat digunakan kembali (reusable). Seorang User dapat membuat beberapa ToolkitModule (misal: "Developer Tools" dengan file system + bash, "Analyst Tools" dengan read-only query, "Admin Tools" dengan dispatch + create workspace).
*   **UI Integration:** Saat User membuka editor agent, terdapat dropdown/selector untuk memilih ToolkitModule yang akan di-assign ke agent tersebut.
*   **Behavior Level 3 Worker:** Hanya tools dari ToolkitModule yang dipilih yang di-inject ke model — mencegah Worker mengeksekusi command berbahaya.
*   **Behavior Level 3 Supervisor:** ToolkitModule-nya dibatasi — Supervisor boleh membaca file dan menjalankan tes sederhana, tapi **tidak boleh** tools berbahaya.
*   **Behavior Level 1/2:** ToolkitModule mereka berisi tools dispatch dan management (EventBus Trigger, Bipolar Dispatch, Create Workspace).

## 2. Tool Definition Standard

### Schema per Tool
```typescript
interface ToolDefinition {
  id: string;
  name: string;                     // "read_file", "execute_bash"
  displayName: string;              // "Read File" — untuk UI
  description: string;              // Deskripsi untuk LLM
  parameters: object;               // JSON Schema input parameters
  handler: (args: any) => Promise<ToolResult>;  // Function yang dieksekusi
  dangerLevel: 'safe' | 'moderate' | 'dangerous';
  authLevelRequired?: number;       // Min authority level (undefined = semua)
}

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}
```

### CrowdOS: ToolkitModule Schema
```typescript
interface ToolkitModule {
  id: string;                       // Unique module ID
  name: string;                     // "Developer Tools", "Read Only", etc.
  description: string;              // Human-readable description
  toolIds: string[];                // Referensi ke tool IDs yang diizinkan
  dangerLevel: 'safe' | 'moderate' | 'dangerous';  // Level bahaya maksimum
  createdAt: Date;
  updatedAt: Date;
}
```

### Registrasi Tool
```typescript
// tools/registry.ts
const toolRegistry: ToolDefinition[] = [
  readFileTool,
  writeFileTool,
  listDirectoryTool,
  executeBashTool,
  executeSafeTool,
  webSearchTool,
  queryDatabaseTool,
  bipolarDispatchTool,
  readAgentRegistryTool,
  createWorkspaceTool,
  dispatchAgentTool,
  systemSchedulerTool,
  searchAllChannelsTool,   // L0 only
];
```

## 3. Standard Built-in Tools

### Workspace/File Tools
| Tool Name | Function ID | Deskripsi | Danger Level |
|-----------|------------|-----------|-------------|
| Read File | `read_file` | Baca isi file di workspace | Safe |
| Write File | `write_file` | Tulis/update file | Moderate |
| List Directory | `list_directory` | Daftar isi direktori | Safe |
| Delete File | `delete_file` | Hapus file | Dangerous |

### Terminal Tools
| Tool Name | Function ID | Deskripsi | Danger Level |
|-----------|------------|-----------|-------------|
| Execute Command | `execute_bash` | Jalankan shell command | Dangerous |
| Execute Safe | `execute_safe` | Command dari whitelist saja | Moderate |

### Search & Data Tools
| Tool Name | Function ID | Deskripsi | Danger Level |
|-----------|------------|-----------|-------------|
| Web Search | `web_search` | Pencarian internet | Safe |
| Query Database | `query_database` | SQL query (read-only) | Moderate |
| Mutate Database | `mutate_database` | SQL mutation | Dangerous |

### Agent Management Tools (L1/L2 Only)
| Tool Name | Function ID | Deskripsi | Auth Level |
|-----------|------------|-----------|-----------|
| Bipolar Dispatch | `bipolar_dispatch` | L1: decompose + route task | L1 |
| Read Agent Registry | `read_agent_registry` | Browse available agents | L1, L2 |
| Create Workspace | `create_workspace` | Buat Category/Channel baru | L1 |
| Dispatch Agent | `dispatch_agent` | L2: spawn L3 Worker/Spv pairs | L2 |
| System Scheduler | `system_scheduler` | Daftarkan delayed/cron task | L1 |
| Search All Channels | `search_all_channels` | L0: browse channel index | L0 tag only |

## 4. Tool Sandboxing & Safety

### Working Directory Restriction
- Tools filesystem **hanya boleh** beroperasi di dalam **workspace directory** yang didefinisikan per Category/Channel.
- Path traversal (`../../`) di-**reject** secara otomatis.
- File sensitif (`.env`, `credentials.json`, dll.) masuk **blacklist**.

### Terminal Command Safety
- Dangerous commands (`rm -rf`, `drop database`, `format`, `shutdown`, dll.) masuk **blacklist statis**.
- `execute_safe` hanya mengizinkan command dari **whitelist** yang di-configure user.
- Semua command di-log dengan `correlationId` untuk audit trail.

### Supervisor Limitations via ToolkitModule
L3 Supervisor secara khusus menggunakan ToolkitModule yang membatasi akses:
- ❌ Tools yang tidak ada di ToolkitModule: tidak bisa digunakan
- ToolkitModule Supervisor hanya berisi: `read_file`, `execute_safe`, `web_search`, `query_database` (read-only)

## 5. Fleksibilitas Penjadwalan (Scheduling)
Secara prinsip bawaan (*default*), framework ini bersifat **Reactive** (*Event-Driven*, jalan saat ada tugas/pesan masuk).
Namun, sistem mendukung kapabilitas **CRON/Flexible Scheduling** yang direkam dari obrolan alami.

*   **Pola Interaksi:** User berkata kepada L1: *"Tolong instruksikan Data Analyst (L2) untuk memproses ribuan data ini nanti tengah malam."*
*   **Logika Eksekusi:** 
    1. L1 memiliki akses ke tool `system_scheduler`.
    2. L1 mengurai keinginan User menjadi waktu spesifik (misal Cron: `0 0 * * *`).
    3. L1 mendaftarkan paket tugas ke dalam Antrian Tertunda (`node-cron`).
    4. Begitu waktu tiba, EventBus menembakkan tugas membangkitkan L2, siklus normal terjadi.
*   **Budget Integration:** Saat agent di-Pause karena budget exceeded, sistem mengecek apakah ada scheduling → task bisa otomatis dipindah ke jadwal berikutnya.

## 6. Future: Migrasi ke MCP
Arsitektur tool saat ini didesain agar **bisa di-upgrade ke MCP** di masa depan tanpa rewrite besar:
- `ToolDefinition.handler` bisa di-wrap menjadi MCP endpoint.
- `ToolExecutor` bisa di-swap menjadi MCP Client.
- JSON Schema per tool sudah MCP-compliant.
- Migrasi bersifat **incremental** — bisa satu tool demi satu tool.

## 7. CrowdOS Integration

### ToolkitModule-Based Authorization
- `ToolExecutor` tidak lagi membaca `allowedTools` dari AgentProfile. Sebagai gantinya, ia membaca `agent.toolkitIds[]`, me-load setiap `ToolkitModule`, dan menggabungkan semua `toolIds` dari toolkit yang direferensikan.
- Jika agent memiliki multiple toolkitIds (misal: "Developer" + "Database"), semua tool dari kedua modul digabungkan.
- Tool permissions bersifat **union** (gabungan dari semua toolkit yang direferensikan).

### UI Changes
- Agent Editor tidak lagi menampilkan checkbox per tool. Sebagai gantinya, menampilkan **ToolkitModule selector** (multi-select dropdown) untuk memilih toolkit yang akan di-assign.
- User dapat membuat dan mengelola ToolkitModule di halaman Settings terpisah.

### Runtime Override for Tools
- `RuntimeOverride` dapat menambahkan atau menghapus toolIds sementara (via `overrideToolIds` field, jika ditambahkan di masa depan).

## 8. Checklist Progress
- [ ] Buat `ToolRegistry` dengan semua built-in tool definitions (gunakan `Map<string, ToolDefinition>`).
- [ ] Buat `ToolkitModule` CRUD (Create/Read/Update/Delete) operations.
- [ ] Buat `ToolExecutor` dengan authorization check via ToolkitModule.
- [ ] Implementasi built-in tools (FileSystem, Bash, WebSearch, Database Query).
- [ ] Implementasi agent management tools (Dispatch, Registry, Workspace, Scheduler).
- [ ] Buat skema DB `toolkit_modules` table.
- [ ] Implementasi tool sandboxing (path guard, blacklist, whitelist).
- [ ] Integrasikan tool schema injection ke LLM prompt (per adapter) via ToolkitModule.
- [ ] Integrasikan `node-cron` ke Backend untuk Scheduling.
- [ ] Implementasi command audit logging.
