# EXP-PLAN — koharu-exp

Brief kerja untuk fork eksperimental `Jeanjinmo/koharu-exp`. Dokumen ini adalah satu-satunya "ingatan" yang dibawa ke setiap sesi Claude Code (termasuk cloud session). **Baca seluruhnya sebelum mengubah kode.**

---

## 1. Tujuan

Pemilik fork ingin manga diterjemahkan oleh **SuperGrok lewat Grok Build** (agent CLI resmi xAI, login `grok login`), karena model lokal di Koharu hasilnya kurang bagus.

Caranya: Koharu diberi **server MCP** yang membuka 14 tool agent yang sudah ada (`KoharuHost`). Grok Build (atau agent MCP lain) lalu bisa membaca teks OCR dan menulis terjemahan langsung ke project Koharu.

- **Fase 1 (selesai, branch `feat/agent-mcp`): server MCP.** Terverifikasi di PC pemilik; branch ini dibekukan sebagai basis.
- **Fase 2: dilewati.** Jangan dikerjakan.
- **Fase 3 (sekarang, branch `feat/custom`): kustomisasi pribadi.** Spesifikasi lengkap ada di **`PRD-FASE3.md`**; dikerjakan per gelombang (3A–3E). Atas keputusan pemilik (2026-10-20), 3B–3E dikerjakan berurutan tanpa menunggu uji per gelombang; pemilik menguji semuanya di akhir dengan manual uji.

Fork ini untuk **pemakaian pribadi jangka panjang**. Kecocokan dengan Koharu resmi tidak dipertimbangkan.

---

## 2. Aturan wajib

1. **Jangan pernah membuat Pull Request**, ke repo mana pun. Repo asli (`koharu-rs/koharu`) tidak boleh disentuh sama sekali.
2. **Push hanya ke branch `feat/custom` di `origin` (`Jeanjinmo/koharu-exp`).** Jangan push ke `feat/agent-mcp` (basis Fase 1, dibekukan) atau `main`. Jangan push tag (memicu `release.yml`).
3. **Basis kode adalah tag `0.83.5`.** Jangan merge atau rebase ke `upstream/main`; versi itu harus cocok dengan model dan runtime (±11 GB) yang sudah terpasang di PC pemilik.
4. Ikuti `AGENTS.md` di root repo, terutama:
   - tanpa backward compatibility atau alias; ubah semua konsumen dan hapus bentuk lama;
   - tanggung jawab melekat di komponen pemiliknya;
   - **jangan edit `packages/bridge/src/protocol.ts` secara manual**; jalankan `cargo run -p koharu-app --bin generate` bila command atau tipe Tauri berubah;
   - verifikasi minimal: profil debug, check atau test terkecil yang relevan.
5. Jangan menulis token atau rahasia ke log, test, atau repo.
6. Commit kecil dan jelas. Akhiri pesan commit dengan baris atribusi yang diminta sistem.

---

## 3. Lingkungan & alur kerja

- **Cloud session = Linux.** Tidak ada GUI, GPU, maupun login Grok. Verifikasi di sana cukup dengan `cargo check`, `cargo clippy`, dan `cargo test` untuk crate yang disentuh.
  - Paket sistem yang dibutuhkan sama dengan CI (lihat `.github/workflows/lint.yml`): `libgtk-4-dev build-essential libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`, plus `libclang` untuk bindgen.
  - Rust yang dipakai developer Koharu: 1.97.1 (edition 2024).
- **Build Windows dilakukan oleh GitHub Actions** (`.github/workflows/build.yml` di fork ini sudah diubah: berjalan saat push ke `feat/**` atau manual, hanya `windows-latest`). Setelah push, hasil build Windows terlihat di tab Actions; error khusus Windows muncul di sana.
- **Pengujian akhir dilakukan pemilik di PC Windows:** unduh artifact `.exe`, jalankan Koharu, lalu sambungkan Grok Build ke server MCP.

---

## 4. Hasil audit yang relevan (basis `0.83.5`)

### 4.1 Titik sambung
- `crates/koharu-agent/src/tool.rs` — trait `Host { context(), tools(), invoke(call, control) }`, plus `Tool`, `ToolCall`, `Invocation { value, changed, images }`.
- `crates/koharu-app/src/commands/agent/host.rs` — `KoharuHost` (saat ini `pub(super)`), implementasi `Host` dengan 14 tool:
  - baca: `inspect_project`, `view_page` (gambar WebP sebagai data URL);
  - ubah: `rename_page`, `move_page`, `delete_pages`, `add_text_box`, `set_source_text`, `set_translation`, `set_typography`, `set_geometry`, `set_visibility`, `delete_elements`, `move_element`, `run_pipeline`.
- Semua mutasi lewat `mutate()` (`host.rs:82`) → `record_commit()` (masuk undo/redo) → `synchronize()` (update canvas via `CanvasChannel`). Commit pipeline lewat `AgentCommitter` (`host.rs:459`).
- Skema argumen tool dibuat dengan `schemars::schema_for!`, jadi langsung cocok untuk `inputSchema` MCP.
- `INSTRUCTIONS` (system prompt agent) ada di `crates/koharu-agent/src/agent.rs:15`.

### 4.2 Wiring aplikasi
- `crates/koharu-app/src/app.rs`: state Tauri dibuat di `setup`; `AgentState::new` di baris 140; `initialize()` di baris 23.
- Reset agent saat project diganti/ditutup: `crates/koharu-app/src/commands/lifecycle.rs:188` dan `:338`.
- Debug build memakai port `127.0.0.1:4000` (CEF DevTools) dan Next dev server di `3000`. **Jangan pakai port itu.**

### 4.3 Gap refresh UI (wajib ditutup di Fase 1)
- Query frontend `project` / `pages` / `page` memakai `staleTime: Infinity` (`packages/koharu/lib/queries.ts`), jadi hanya berubah bila di-invalidate.
- Pemicu refresh saat ini: event Job dan event `ProjectInfo` di `packages/koharu/app/providers.tsx`, serta `AgentPanel.tsx:308` (`tool_finished.changed`) dan `:316` (`completed`).
- Akibatnya, mutasi dari luar (MCP) hanya meng-update canvas; panel layer dan teks tidak.

### 4.4 Dependensi
- `hyper 1.x`, `hyper-util 0.1.x`, `tower 0.5.x` sudah ada di `Cargo.lock` (transitif). Pakai `hyper-util` untuk server HTTP, **jangan tambahkan axum**.
- `rmcp` (crate MCP resmi, versi 3.4.x): fitur server + `transport-streamable-http-server`. `StreamableHttpServerConfig` punya `allowed_hosts` (default loopback) dan validasi `Origin` yang **mati secara default** → wajib diaktifkan (`enforce_origin_validation()`).

---

## 5. Desain Fase 1: server MCP

### 5.1 Komponen
1. **Modul `mcp` di `koharu-agent`**, generic atas `H: Host`. Tidak bergantung pada Tauri.
2. **Wiring di `koharu-app`**: nyalakan server setelah setup memakai `KoharuHost`; matikan saat aplikasi ditutup.
3. **Notifikasi UI**: setelah `mutate()` dan setiap commit `AgentCommitter`, publish `ProjectChannel` dengan `ProjectInfo` terbaru. Lalu hapus refresh manual di `AgentPanel.tsx:308` dan `:316` karena sudah digantikan.

### 5.2 Spesifikasi
- **Transport:** Streamable HTTP, path `/mcp`, bind **hanya** `127.0.0.1`.
- **Port:** default `47821`, bisa diubah lewat config (section milik agent di `~/.koharu/config.toml`). Kalau port terpakai, catat error yang jelas di log, jangan crash.
- **Token:** acak 32 byte, disimpan lewat `koharu-secrets` (keyring), dibuat sekali lalu dipakai ulang. Setiap request wajib `Authorization: Bearer <token>`; selain itu tolak dengan 401.
- **Validasi:** `allowed_hosts` hanya loopback; validasi `Origin` aktif (request dengan header `Origin` ditolak).
- **File penunjuk:** tulis `%USERPROFILE%\.koharu\mcp.json` berisi `{ "url": "...", "token": "..." }` setiap server menyala, supaya pemilik bisa mendaftarkan server ke Grok Build tanpa UI tambahan. Token tidak boleh dicetak ke log.
- **Pemetaan tool:**
  - `Host::tools()` → tool MCP (`name`, `description`, `inputSchema` dari `parameters`);
  - `Invocation.value` → konten teks JSON;
  - `Invocation.images` → konten gambar (`image/webp`, base64 tanpa prefix data URL);
  - error → hasil dengan `isError: true` dan pesan error.
- **Instructions:** isi `instructions` server MCP dengan versi netral dari `INSTRUCTIONS` (tanpa menyebut Codex).
- **Konteks:** jangan menyisipkan konteks otomatis; agent memanggil `inspect_project` sendiri.
- **Pembatalan:** cancellation dari rmcp diteruskan ke `Control::cancel()` (penting untuk `run_pipeline`).
- **Konkurensi:** mutasi sudah diserialkan oleh lock project, dan `run_pipeline` dijaga `Processing.stops`. Tidak perlu lock tambahan.

### 5.3 Di luar lingkup Fase 1
- Klien ACP, dropdown agent, panel pengaturan MCP di UI.
- Perubahan pada perilaku agent Codex selain penghapusan refresh manual di `AgentPanel`.

---

## 6. Definisi selesai (Fase 1)

**Di cloud session (Linux):**
- [ ] `cargo fmt`, `cargo clippy -D warnings`, dan `cargo check` bersih untuk crate yang disentuh.
- [ ] Unit test pemetaan tool dan hasil (teks, gambar, error) memakai `Host` tiruan.
- [ ] Test integrasi: server menyala di port acak, client MCP bisa `initialize`, `tools/list` (14 tool), dan `tools/call` ke `Host` tiruan.
- [ ] Test keamanan: tanpa token → ditolak; token salah → ditolak; header `Origin` → ditolak.
- [ ] `protocol.ts` di-generate ulang bila ada perubahan command/tipe.
- [ ] Push ke `origin feat/agent-mcp`, lalu pastikan build Windows di tab Actions hijau.

**Di PC pemilik (Windows):**
- [ ] Artifact `.exe` jalan dan memakai store model yang sudah ada.
- [ ] `~/.koharu/mcp.json` terbentuk.
- [ ] Grok Build tersambung ke server MCP dan bisa menerjemahkan satu halaman; teks muncul di canvas **dan** panel; `undo` di UI membatalkannya.

---

## 7. Catatan untuk pemilik

- Build release Windows memakai store runtime di `<resource_dir>\store` (`app.rs`, `Store::configure`). Untuk `.exe` tanpa installer, kemungkinan besar itu folder `store` di sebelah `koharu.exe` — pastikan saat build pertama. Agar model ±11 GB tidak diunduh ulang, buat *directory junction* `store` → `%LOCALAPPDATA%\koharu\store` di folder tempat `.exe` hasil Actions dijalankan.
- `.exe` hasil Actions mungkin butuh file pendukung CEF (`libcef.dll`, dll.). Cek saat build pertama; kalau kurang, salin dari folder Koharu terpasang atau tambahkan ke artifact.
- Tolak tawaran auto-update di build ini, karena updater mengarah ke rilis Koharu resmi dan akan menimpa versi eksperimen.
- Backup `%USERPROFILE%\.koharu\config.toml` sebelum menjalankan build ini (dipakai bersama dengan Koharu terpasang). Tutup Koharu terpasang saat menguji.

---

## 8. Fase 3

Spesifikasi, prioritas, gelombang, checklist uji, dan pertanyaan terbuka Fase 3 ada di **`PRD-FASE3.md`**. Bagian 4–6 dokumen ini adalah catatan Fase 1 dan tetap berguna sebagai peta kode.
