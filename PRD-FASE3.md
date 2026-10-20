# PRD Fase 3 — koharu-exp (kustomisasi pribadi)

Dokumen kebutuhan produk untuk Fase 3 fork pribadi `Jeanjinmo/koharu-exp`. Dibaca bersama `EXP-PLAN.md` (aturan, lingkungan, hasil audit). **Baca keduanya seluruhnya sebelum mengubah kode.**

- Status: **gelombang 3A–3E selesai dikerjakan (2026-10-20); menunggu uji pemilik** memakai `MANUAL-UJI-FASE3.md`.
- Keputusan pemilik (2026-10-20): setelah 3A, gelombang 3B–3E dikerjakan **berturut-turut tanpa menunggu uji pemilik per gelombang**. Pemilik menguji semuanya sekaligus di akhir memakai manual uji yang diserahkan sesi pengerja, dan mencatat bug yang ditemukan. Aturan lain tetap berlaku.
- Branch kerja: `feat/custom` (dari `feat/agent-mcp` @ `4ff6409d`). `feat/agent-mcp` dibekukan sebagai basis Fase 1.
- Basis kode tetap tag `0.83.5`.

---

## 1. Latar belakang dan tujuan

Fase 1 menambahkan server MCP sehingga agent luar (SuperGrok lewat Hermes, Grok Build, Claude Code) bisa menerjemahkan manga di Koharu memakai 14 tool `KoharuHost`. Pemakaian nyata menunjukkan kekurangan:

- terjemahan dari agent pemenggalan katanya rusak ("SEN-TUHAN") karena tag bahasa kosong;
- inpainting hanya bisa satu halaman penuh, sehingga logo yang salah dibaca OCR ikut terhapus;
- `inspect_project` terlalu besar (±62 ribu karakter untuk 82 halaman) dan satu balon = satu panggilan tool;
- pemilik tidak bisa mengatur MCP dari UI, tidak bisa melihat apa yang dikerjakan agent, dan tidak punya cara nyaman membandingkan hasil dengan aslinya.

**Tujuan Fase 3:** menjadikan Koharu alat kerja terjemahan pribadi yang nyaman dipakai bersama agent: agent lebih mampu dan hemat, pemilik punya kendali dan visibilitas, serta ada alat bantu kualitas (Compare, Referensi, Glosarium).

**Ini pengembangan pribadi.** Kecocokan dengan Koharu resmi tidak dipertimbangkan. Jangan menilai, menyiapkan, atau menyarankan apa pun untuk repo resmi.

## 2. Pengguna dan skenario utama

Pemilik tunggal (Windows), memakai Koharu sebagai editor dan agent luar sebagai penerjemah.

1. **Terjemah instan oleh agent:** agent menjalankan detection → OCR → `remove` per balon → `set_translations` → cek `view_page`.
2. **Pipeline + poles:** pemilik menjalankan pipeline di UI, agent atau pemilik memoles hasilnya.
3. **Poles dengan pembanding:** pemilik memeriksa hasil di mode Compare (asli vs edit).
4. **Gabung referensi:** raw berkualitas bagus + komik versi terjemahan (gambar jelek, terjemahan bagus) → ambil teksnya saja, poles di Compare.
5. **Agent bekerja ditinggal:** pemilik memakai aplikasi lain; layar Koharu mengikuti halaman yang dikerjakan agent; log aktivitas menunjukkan apa yang terjadi.

## 3. Kategori dan prioritas

| Kode | Kategori | Fitur |
|---|---|---|
| **K1** | Kemampuan agent (tool MCP) | F3-2 `remove`, F3-3 `draw`, F3-4 `erase`, F3-6 `export`, F3-7 `inspect_page`, F3-10 tag bahasa, F3-11 `view_page` presisi, F3-12 `set_translations`, F3-13 peringatan teks tidak muat, F3-14 deteksi ulang di area |
| **K2** | Kendali dan visibilitas MCP (UI) | F3-1 tab MCP Tools, F3-18 profil/label/tooltip, F3-5 Ikuti agent, F3-16 log aktivitas |
| **K3** | Manajemen project (UI) | F3-8 Kosongkan project, F3-9 Bebaskan ruang disk, F3-15 status per halaman |
| **K4** | Alat bantu kualitas terjemahan | F3-19 Compare, F3-20 Referensi terjemahan, F3-17 Glosarium |

Prioritas (dampak pada pemakaian harian):

- **P0:** F3-10, F3-12, F3-7, F3-2, F3-13, F3-11.
- **P1:** F3-3, F3-4, F3-6, F3-14, F3-1, F3-18, F3-5, F3-19.
- **P2:** F3-8, F3-9, F3-15, F3-16, F3-20, F3-17.

## 4. Gelombang pengerjaan

Satu gelombang = satu cloud session (boleh dilanjutkan bila belum selesai). Semula gelombang berikutnya baru dimulai setelah pemilik menyatakan gelombang sebelumnya lolos uji; sejak keputusan pemilik 2026-10-20, 3B–3E dikerjakan berurutan tanpa menunggu uji. Setiap gelombang tetap selesai hanya bila verifikasi cloud (§5.4) bersih dan build Windows di Actions hijau.

| Gelombang | Isi | Bergantung pada |
|---|---|---|
| **3A** | Semua K1 + metadata tool (§5.2) | — |
| **3B** | F3-1, F3-18, F3-5, F3-16, F3-8, F3-9, F3-15 | 3A (metadata tool, daftar tool lengkap) |
| **3C** | F3-19 Compare (tiga mode) | — (sisi kiri Referensi menyusul di 3D) |
| **3D** | F3-20 Referensi terjemahan | 3A (F3-10), 3C (Compare) |
| **3E** | F3-17 Glosarium | 3A |

Urutan dalam satu gelombang: kerjakan per fitur, **satu commit per fitur** (atau beberapa commit kecil), sehingga mudah ditelusuri dan dibatalkan.

## 5. Persyaratan lintas fitur

### 5.1 Aturan kode
- Ikuti `AGENTS.md` dan aturan `EXP-PLAN.md` §2 (tanpa PR, tanpa tag, push hanya ke `feat/custom`).
- Semua mutasi project lewat jalur yang sudah ada: commit → `record_commit()` (masuk undo/redo) → `synchronize()` canvas → publish `ProjectChannel` (pola Fase 1 di `crates/koharu-app/src/commands/agent/host.rs`, `mutate()`).
- **Tool MCP tidak boleh bergantung pada `active_page`.** Semua tool yang bekerja pada halaman menerima parameter `page`. Command UI yang dijadikan dasar (mis. `canvas.rs`) memakai `active_page`; versi agent harus memisahkan logika intinya.
- Tool baru ditambahkan ke `KoharuHost` sehingga tersedia untuk MCP **dan** agent bawaan; pengaturan F3-1/F3-18 hanya memengaruhi MCP.
- Perubahan command/tipe Tauri: jalankan `cargo run -p koharu-app --bin generate`, jangan edit `packages/bridge/src/protocol.ts` manual.
- Teks UI baru: **bahasa Inggris**, tambahkan kunci hanya di `packages/koharu/public/locales/en-US/translation.json`. Locale lain otomatis jatuh ke `en-US` (`packages/koharu/lib/i18n.ts:41`, `fallbackLng`).
- Jangan menulis token atau argumen tool lengkap ke log, test, atau repo.

### 5.2 Metadata tool (dikerjakan di 3A)
Tambahkan metadata ke definisi tool (`crates/koharu-agent/src/tool.rs`, struct `Tool`) atau struktur pendamping, dipakai UI (F3-1, F3-18) dan deskripsi MCP:
- `group`: `read` | `pages` | `text` | `image` | `pipeline` | `output`;
- `vision`: `required` | `better` | `none`;
- `mutates_image`: bool; `destructive`: bool.

Deskripsi tool untuk agent yang `vision: required` diberi akhiran "(requires image input)". Metadata tidak boleh mengubah skema argumen yang dikirim ke model.

### 5.3 Konfigurasi
Perluas `McpConfig` (`crates/koharu-agent/src/config.rs:45`, bagian `[agent.mcp]` di `~/.koharu/config.toml`):
`enabled` (default `true`), `port` (default `47821`), `disabled_tools` (default kosong), `follow_agent` (default `true`), `export_dir` (default `<Documents>\Koharu\exports`, resolusi folder Documents lewat API OS), `profile` (`vision` | `text` | `read` | `custom`).
Konfigurasi lama tanpa field baru harus tetap terbaca dengan default di atas.

### 5.4 Verifikasi
- **Cloud (Linux):** `cargo fmt`, `cargo clippy -D warnings`, `cargo test` untuk crate yang disentuh; `bun run lint` dan `bun run test` (vitest) untuk `packages/koharu`. Catatan: unduhan CEF diblokir di cloud, jadi `koharu-app` mungkin tidak bisa dibuild penuh; pastikan `cargo check` sejauh mungkin dan andalkan build Windows di Actions.
- **Actions:** push ke `feat/custom` memicu `build.yml` (Windows saja). Gelombang belum selesai sebelum build hijau.
- **Pemilik (Windows):** checklist di §8.

---

## 6. Spesifikasi fitur

Format: *Tujuan* · *Perilaku* · *Kriteria terima* · *Petunjuk kode*.

### K1 — Kemampuan agent

#### F3-2. Tool `remove` (padanan alat Remove)
- **Tujuan:** inpaint hanya di area tertentu, bukan satu halaman.
- **Perilaku:** parameter `page` wajib; area salah satu dari `elements` (daftar ID, pakai kotak tiap elemen), `rect` (`x, y, width, height`, piksel halaman), atau `points` + `diameter`. Membuat mask, menjalankan inpainting region, menunggu job selesai, hasil masuk layer cleanup halaman itu.
- **Kriteria terima:** area di luar mask tidak berubah; bisa di-undo; error jelas bila area kosong/di luar halaman; tidak memengaruhi halaman yang sedang terbuka di UI bila berbeda.
- **Petunjuk:** `commit_inpaint` (`crates/koharu-app/src/commands/canvas.rs:352`), `encode_mask` (`:414`), `Scope::Region` + `Operation::Only { Inpainting }`, mask manual di `crates/koharu-pipeline/src/stages/inpainting.rs:473`. Catatan perilaku: model (default LaMa) cenderung menyambung garis struktural; itu wajar, bukan bug.

#### F3-3. Tool `draw` (padanan alat Draw)
- **Perilaku:** `page`, area (`elements` / `rect` / `points` + `diameter`), `color` (hex), `layer` opsional (tanpa layer → buat layer kuas baru). Kotak diisi penuh.
- **Kriteria terima:** warna tepat, tepi area sesuai kotak; bisa di-undo; mengembalikan ID layer yang dipakai.
- **Petunjuk:** `apply_raster_stroke(page, layer, RasterStrokeMode::Paint, …)` (`canvas.rs:285`). Isi kotak boleh lewat goresan rapat atau dukungan fill baru.

#### F3-4. Tool `erase` (padanan alat Eraser)
- **Perilaku:** `page`, `layer` (wajib; hanya layer kuas atau cleanup), area seperti F3-3. Piksel layer jadi transparan.
- **Kriteria terima:** menghapus sebagian layer cleanup memperlihatkan gambar asli di bawahnya (kasus memulihkan logo); menolak layer yang bukan raster kuas/cleanup.
- **Petunjuk:** `RasterStrokeMode::Erase` (`canvas.rs:243`); UI menolak tanpa layer aktif (`packages/koharu/components/editor/CanvasWorkspace.tsx`, "Select a paint or cleanup layer…").

#### F3-6. Tool `export`
- **Perilaku:** `format` (`png` | `psd` | `cbz`), `pages` opsional (kosong = semua). Tujuan selalu `export_dir` (§5.3) + subfolder baru `<nama project>_<YYYY-MM-DD_HHMM>` (tambah akhiran bila sudah ada). Agent tidak bisa memberi path. Mengembalikan path hasil dan jumlah file.
- **Kriteria terima:** tidak pernah menimpa file; satu halaman → satu file; tombol Export di UI tetap memakai dialog seperti sekarang.
- **Petunjuk:** `output::export` (`crates/koharu-app/src/commands/output.rs:49`): pisahkan pemilihan tujuan dari render + tulis; penamaan `{nomor urut}_{nama halaman}` (`:141`).

#### F3-7. Tool `inspect_page`
- **Perilaku:** `page` → ID, nama, ukuran halaman; per elemen: ID, kotak, teks sumber (+bahasa), teks referensi bila ada (F3-20), terjemahan (+bahasa), typography inti, status halaman (F3-15) bila ada. Tanpa detail layer artwork dan daftar font.
- **Kriteria terima:** halaman berisi ±10 balon menghasilkan jauh di bawah 5.000 karakter; `inspect_project` tetap ada.
- **Petunjuk:** `project_context()` di `host.rs` sebagai acuan isi.

#### F3-10. Tag bahasa terjemahan
- **Perilaku:** `set_translation` (dan F3-12) menerima `language` opsional (BCP 47, mis. `id-ID`). Bila kosong → bahasa target dari Settings (`[pipeline.translation] target_language`), bukan null dan bukan tag lama yang null.
- **Kriteria terima:** teks Indonesia tidak lagi dipenggal dengan pola Inggris; tag tampil di `inspect_page`.
- **Petunjuk:** `set_translation` mempertahankan tag lama (`crates/koharu-app/src/commands/project.rs` ±`:506`); renderer default Inggris bila null (`crates/koharu-renderer/src/layout.rs:246`, `text_renderer.rs:222`); pipeline mengisi tag (`crates/koharu-pipeline/src/stages/translation.rs:69`).

#### F3-11. `view_page` lebih presisi
- **Perilaku:** hasil menyertakan `width`, `height` asli dan `scale` gambar; parameter opsional `region` (kotak, piksel halaman) → potongan area itu dalam resolusi penuh (tetap dibatasi ukuran wajar).
- **Kriteria terima:** koordinat yang dihitung agent dari gambar bisa dikonversi tepat ke piksel halaman.
- **Petunjuk:** `rendered_preview` memperkecil ke 1024 px (`crates/koharu-app/src/commands/output.rs:215`).

#### F3-12. Tool `set_translations`
- **Perilaku:** daftar `{ element, text, language? }` dalam satu panggilan; satu commit = satu langkah undo; validasi semua dulu, gagal satu = tidak ada yang diterapkan (pesan menyebut elemen bermasalah).
- **Kriteria terima:** satu halaman diterjemahkan dengan satu panggilan; undo sekali membatalkan semuanya.

#### F3-13. Peringatan teks tidak muat
- **Perilaku:** hasil `set_translation` / `set_translations` menyertakan daftar elemen yang teksnya meluap atau mengecil di bawah batas minimum, beserta ukuran akhir huruf.
- **Kriteria terima:** terjemahan yang sengaja dibuat terlalu panjang muncul di daftar peringatan.
- **Petunjuk:** `layout.overflowed()` (`crates/koharu-renderer/src/text_renderer.rs:276`).

#### F3-14. Deteksi ulang di satu area
- **Perilaku:** `run_pipeline` (atau tool baru) menerima `region` untuk Detection; elemen di luar area tidak disentuh; elemen baru ditambahkan untuk teks yang ditemukan di area itu.
- **Kriteria terima:** teks yang terlewat bisa ditambahkan tanpa merusak elemen lain di halaman.
- **Petunjuk:** `Scope::Region` (`crates/koharu-pipeline/src/scope.rs:104`). **Cek dulu** apakah tahap Detection mendukungnya; bila butuh perubahan besar, laporkan dan tunda fitur ini tanpa menghambat fitur lain di 3A.

### K2 — Kendali dan visibilitas MCP

#### F3-1. Tab Settings "MCP Tools"
- **Letak:** tab ke-7 setelah Shortcuts (`packages/koharu/components/preferences/SettingsPage.tsx:48`, daftar `tabs`).
- **Isi:** toggle utama server; status server; profil (F3-18); daftar semua tool dengan centang per tool, dikelompokkan sesuai `group`; toggle **Follow agent** (F3-5); folder export (F3-6, bisa dipilih lewat dialog); log aktivitas (F3-16). Toggle utama mati → semua centang abu-abu.
- **Status server** (event langsung dari Rust): Off / Starting… / Running at `127.0.0.1:<port>` (+ jumlah klien bila mudah) / Stopping… (waiting for N tasks) / Error: `<pesan>`. Error start saat Koharu dibuka (sekarang hanya `tracing::error`, `crates/koharu-app/src/app.rs:167`) juga tampil.
- **Perilaku berubah langsung:**
  1. dimatikan saat agent bekerja: panggilan baru ditolak dengan pesan jelas; tool yang berjalan dibiarkan selesai; tombol **Stop now** membatalkan lewat `Control::cancel()`; lalu port ditutup. (Mengganti perilaku Fase 1 yang langsung memutus koneksi: `crates/koharu-agent/src/mcp/handler.rs:78`, `mod.rs` `accept`.)
  2. port gagal dibuka: coba ulang ±3 detik; gagal → status Error, toggle kembali mati, tombol **Retry**. Port tidak bisa diedit dari UI.
  3. klik cepat berulang: start/stop diantrikan; tidak boleh ada dua server; toggle dikunci selama transisi; hasil mengikuti klik terakhir.
  4. token tetap sama setelah restart server.
  5. centang tool berubah: kirim `notifications/tools/list_changed`; `tools/list` hanya tool aktif; `tools/call` ke tool nonaktif ditolak dengan pesan "Tool `<name>` is disabled in Koharu settings".
- **Cakupan:** hanya MCP; agent Codex bawaan tidak terpengaruh.
- **Petunjuk:** `AgentState::start_mcp()` / `stop_mcp()` (`crates/koharu-app/src/commands/agent.rs:49`, `:55`), `CancellationToken` di `crates/koharu-agent/src/mcp/mod.rs:52`.

#### F3-18. Profil tool, label, dan tooltip
- **Profil:** Vision model (semua aktif) / Text-only model (tool `vision: required` mati) / Read-only (hanya tool `group: read`) / Custom (otomatis bila centang diubah manual). Koharu tidak bisa mendeteksi kemampuan model; pilihan manual.
- **Label per tool** dari metadata §5.2: "needs vision", "better with vision", "edits image", "deletes". Label punya tooltip penjelasan.
- **Tooltip ⓘ** langsung setelah nama tool (urutan baris: centang → nama → ⓘ → deskripsi singkat → label). Isi: fungsi, kapan dipakai agent, bisa di-undo atau tidak, kebutuhan vision. Teks tooltip terpisah dari deskripsi untuk agent. Bahasa Inggris (§5.1).
- **Untuk agent:** `INSTRUCTIONS` server MCP (`crates/koharu-agent/src/mcp/handler.rs:18`) diperbarui: alur kerja yang disarankan (detection → OCR → `remove` → `set_translations` → cek), kapan memakai `inspect_page` alih-alih `inspect_project`, dan apa yang dilakukan bila model tidak bisa melihat gambar.

#### F3-5. Follow agent
- **Perilaku:** setelah tool MCP yang mengubah halaman, Koharu menjadikan halaman itu halaman aktif dan UI pindah ke sana. `run_pipeline` banyak halaman → pindah ke halaman pertama saja. Diatur toggle `follow_agent`.
- **Larangan:** tidak boleh memunculkan, memulihkan, atau memfokuskan jendela Koharu.
- **Kriteria terima:** pemilik bisa memakai aplikasi lain tanpa terganggu; saat kembali, Koharu ada di halaman terakhir yang dikerjakan agent.
- **Petunjuk:** `lifecycle::select_page`.

#### F3-16. Log aktivitas MCP
- **Perilaku:** di tab MCP Tools, daftar ±100 panggilan terakhir (jam, tool, halaman, berhasil/gagal, pesan error singkat). Disimpan di memori selama Koharu berjalan. Tanpa argumen lengkap, tanpa token. Tombol Clear.

### K3 — Manajemen project

#### F3-8. Clear project…
- **Perilaku:** hapus semua halaman dalam satu commit (bisa di-undo); project tetap ada. Dialog konfirmasi menampilkan jumlah halaman dan centang opsional F3-9. Letak: menu ⋯ di judul daftar Pages dan/atau menu File. **UI saja, tanpa tool MCP.**
- **Petunjuk:** `delete_pages` menerima daftar (`crates/koharu-app/src/commands/project.rs:363`, hapus berantai); UI project kosong sudah ada.

#### F3-9. Free up disk space…
- **Perilaku:** hapus file di `blobs/` yang tidak dipakai. **Tidak bisa di-undo**; tampilkan peringatan dan perkiraan ukuran sebelum dijalankan. Tersedia sebagai centang di F3-8 dan menu terpisah. **UI saja.**
- **Kriteria terima:** ukuran folder project berkurang; project tetap bisa dibuka; tidak ada gambar halaman yang masih dipakai ikut terhapus.
- **Petunjuk:** `collect_garbage` (`crates/koharu-scene/src/session.rs:182` → `crates/koharu-storage/src/session.rs:227`) tidak pernah dipanggil aplikasi. Pastikan state sudah tersimpan sebelum GC; kosongkan riwayat undo/redo sesudahnya (riwayat ada di memori: `project.rs:258`).

#### F3-15. Status per halaman
- **Perilaku:** status Not started / Translated by agent / Needs review / Done. Badge di daftar halaman (`packages/koharu/components/editor/PageRail.tsx`), bisa diubah dari menu ⋯ halaman dan lewat tool MCP baru (`set_page_status`); tampil di `inspect_page`.
- **Penyimpanan:** data baru per halaman, disimpan di dalam project. Laporkan pilihan desain penyimpanan di pesan commit.

### K4 — Alat bantu kualitas terjemahan

#### F3-19. Mode Compare
- **Perilaku:** mode tampilan di editor (bukan halaman terpisah), murni tampilan, tidak mengubah data atau visibilitas layer. Dinyalakan dari menu **View → Compare** (menu View sekarang hanya "Fit Window"), tombol **Compare** di status bar dekat zoom, dan shortcut (tambahkan ke `ShortcutAction`, `packages/koharu/lib/store.ts:32`, dan daftar `shortcutKeys` di `SettingsPage.tsx:342`).
- **Tiga mode** (dropdown di tombol Compare; pilihan terakhir diingat):
  1. **Side by side (default):** kiri pembanding, hanya lihat, tanpa toolbar; kanan canvas biasa yang bisa diedit. Zoom dan geser tersinkron.
  2. **Slider:** satu halaman ukuran penuh dibelah garis yang bisa digeser; kiri garis pembanding, kanan garis hasil edit.
  3. **Hold to peek:** tampilan normal; selama shortcut ditahan tampil pembanding.
- **Sisi kiri (pembanding):** otomatis per halaman — Referensi bila ada (F3-20, setelah 3D), selain itu Raw (gambar asli / layer "Original artwork"). Bila ada referensi, bisa diganti ke Raw lewat dropdown. Sisi kanan selalu hasil kerja (raw + editan).
- **Kriteria terima:** pindah halaman di PageRail → kedua sisi ikut; mengedit di kanan tetap berfungsi penuh; menutup Compare mengembalikan tampilan seperti sebelumnya.

#### F3-20. Referensi terjemahan (per halaman)
- **Tujuan:** raw berkualitas bagus + komik versi terjemahan (gambar jelek, terjemahan bagus) → ambil **teksnya saja** ke project raw, lalu dipoles.
- **Peran:** raw = halaman project. Referensi = gambar komik terjemahan yang ditempelkan ke halaman raw, disimpan bersama project, **tidak ikut export, tidak ikut render**, tidak mengubah gambar raw. Bisa dilepas per halaman.
- **Import references…:** gambar, folder, PDF, CBZ/ZIP, RAR memakai mesin import yang ada (`crates/koharu-app/src/commands/import/`; PDF dipecah per halaman 300 DPI di `import/pdf.rs`). Opsi **trim margins** (buang pinggiran polos).
- **Pair pages:** otomatis berdasarkan urutan; pemilik mengecek daftar thumbnail raw ↔ referensi, bisa geser dan lewati (sampul, kredit). Halaman tanpa pasangan boleh.
- **Reference language:** dipilih saat import, default bahasa target Settings.
  - sama dengan target → teks masuk sebagai **terjemahan** (+tag bahasa, F3-10);
  - berbeda → masuk ke kolom baru **teks referensi** per elemen (teks sumber hasil OCR raw tetap disimpan). Inspector menampilkan teks sumber, teks referensi, terjemahan. Pipeline Translation memakai teks referensi sebagai bahan utama bila ada (teks sumber sebagai pembanding makna).
- **Align (bertingkat):** (1) otomatis skala ke ukuran halaman raw; (2) manual mode kalkir (referensi transparan di atas raw, geser/zoom, simpan per halaman, **Apply to following pages**); (3) pencocokan balon toleran: deteksi balon di referensi, pasangkan ke balon raw terdekat; balon tanpa pasangan ditandai dan bisa dipasangkan manual di Compare.
- **Extract text from references:** OCR Koharu pada balon referensi → isi terjemahan atau teks referensi sesuai bahasa.
- **Di luar lingkup:** referensi satu gambar panjang (gaya webtoon) dan spread dua halaman; pemilik menyamakan format di luar Koharu (satu gambar referensi = satu halaman raw). Bagian agent (MCP membaca referensi) juga belum.
- **Risiko:** render PDF 300 DPI besar; jaga pemakaian memori.

#### F3-17. Glosarium project
- **Perilaku:** daftar istilah/nama → terjemahan (+ catatan opsional) per project; panel untuk mengedit; tool MCP untuk membaca (dan menambah bila diizinkan); pipeline Translation memakai glosarium bila memungkinkan.
- **Penyimpanan:** di dalam project; laporkan desainnya.

---

## 7. Di luar lingkup / pengembangan mendatang

- **Ditunda:** pilihan tahap di `run_pipeline` (sekarang `full` selalu menjalankan 4 tahap).
- **Mendatang:** lokalisasi tambahan (mis. `id-ID`, bisa pilih bahasa); "potong berdasarkan raw" untuk referensi gaya webtoon (kandidat alat Python terpisah di `tools/`); penyejajaran referensi otomatis tingkat lanjut; agent membaca referensi lewat MCP.
- **Dilewati:** undo/redo lewat MCP; import halaman lewat MCP; point text lewat MCP.

## 8. Checklist uji pemilik (Windows) per gelombang

Persiapan setiap gelombang: unduh artifact `koharu-windows-latest` dari Actions, ganti hanya `koharu.exe` di `D:\Dev\clone-projects\koharu-exp-run\koharu-windows-latest\`, tutup Koharu resmi, backup `~/.koharu/config.toml`, uji di project tes (bukan project penting).

**3A**
- [ ] Hermes/Claude melihat tool baru di daftar tool.
- [ ] `set_translations` satu halaman Indonesia: tidak ada pemenggalan "SEN-TUHAN"; undo sekali membatalkan semua.
- [ ] Terjemahan sengaja kepanjangan → muncul peringatan tidak muat.
- [ ] `remove` satu balon: balon lain dan logo tidak berubah.
- [ ] `draw` putih di satu kotak, lalu `erase` sebagian; `erase` di layer cleanup memperlihatkan gambar asli.
- [ ] `inspect_page` jauh lebih kecil dari `inspect_project`.
- [ ] `view_page` dengan `region` menampilkan potongan tajam; ukuran asli dilaporkan.
- [ ] `export` PNG satu halaman → satu file di folder export, tidak menimpa export sebelumnya.
- [ ] (bila jadi) deteksi ulang area menambah elemen tanpa merusak yang lain.

**3B**
- [ ] Tab MCP Tools tampil; status Running; toggle off saat agent menjalankan pipeline → menunggu selesai, lalu Off; on lagi → klien bisa tersambung tanpa ganti config.
- [ ] Matikan satu tool → hilang dari klien (atau ditolak dengan pesan jelas).
- [ ] Profil Text-only mematikan `view_page`; label dan tooltip ⓘ tampil.
- [ ] Follow agent: Koharu pindah halaman tanpa merebut fokus saat memakai browser.
- [ ] Log aktivitas berisi panggilan terakhir.
- [ ] Clear project → kosong, undo mengembalikan; Free up disk space mengecilkan folder project.
- [ ] Status halaman tampil sebagai badge dan bisa diubah dari UI dan MCP.

**3C**
- [ ] Compare dari menu View, tombol status bar, dan shortcut.
- [ ] Side by side: zoom/geser sinkron, edit di kanan berfungsi; slider dan hold-to-peek berfungsi.

**3D**
- [ ] Import referensi PDF per halaman; pasangan halaman bisa digeser/dilewati.
- [ ] Referensi bahasa sama → masuk terjemahan; bahasa beda → masuk teks referensi.
- [ ] Mode kalkir + Apply to following pages; Compare kiri otomatis Referensi.
- [ ] Referensi tidak ikut export.

**3E**
- [ ] Glosarium bisa diedit, dibaca agent, dan dipakai saat menerjemahkan.

## 9. Pertanyaan terbuka (dijawab oleh sesi pengerja, lapor di ringkasan)

1. Apakah tahap Detection mendukung `Scope::Region` (F3-14)?
2. Desain penyimpanan data baru di project (F3-15 status, F3-17 glosarium, F3-20 referensi dan penyejajaran) tanpa merusak project lama.
3. Apakah rmcp yang dipakai mendukung `notifications/tools/list_changed` (F3-1).
4. Cara menampilkan gambar asli saja di canvas untuk sisi kiri Compare tanpa mengubah visibilitas layer (F3-19).
5. Pemakaian memori import referensi PDF besar (F3-20).

## 10. Alur kerja

1. Pemilik menyetujui PRD ini → commit + push ke `origin feat/custom` (dilakukan sesi lokal setelah persetujuan).
2. Pemilik memulai cloud session per gelombang dengan prompt di bawah (ganti `3A` dengan gelombangnya).
3. Sesi cloud: baca `EXP-PLAN.md` + PRD, kerjakan per fitur, verifikasi §5.4, push ke `feat/custom`, pastikan build Windows hijau, lalu laporkan ringkasan: fitur selesai, yang tertunda, jawaban pertanyaan terbuka, hal yang perlu diuji pemilik.
4. Sesi lokal menarik hasilnya (`git pull`), memeriksa kode terhadap PRD, dan menyusun rangkuman untuk pemilik.
5. Pemilik menguji exe dari artifact Actions dengan checklist §8; masalah diperbaiki di sesi cloud yang sama sebelum lanjut ke gelombang berikutnya.
6. Sejak keputusan pemilik 2026-10-20: setelah 3E, sesi pengerja menyerahkan manual uji langsung (pengalaman nyata di PC Windows) yang merangkum checklist §8 semua gelombang. Pemilik menguji di akhir, mencatat bug, lalu perbaikannya dikerjakan di sesi berikutnya.

Prompt awal cloud session:

```
Repo: Jeanjinmo/koharu-exp, branch feat/custom.

Sebelum mengubah apa pun, baca seluruhnya:
1. EXP-PLAN.md (aturan wajib fork ini)
2. PRD-FASE3.md (spesifikasi Fase 3)

Tugas: kerjakan GELOMBANG 3A sesuai PRD-FASE3.md §4 dan §6.

Aturan tegas:
- Jangan pernah membuat Pull Request ke repo mana pun.
- Push hanya ke origin feat/custom. Jangan push tag, main, atau feat/agent-mcp.
- Jangan merge/rebase ke upstream.
- Satu commit per fitur.

Setelah selesai: pastikan build Windows di Actions hijau, lalu laporkan ringkasan:
fitur yang selesai, yang tertunda beserta alasannya, jawaban pertanyaan terbuka PRD §9,
dan hal yang perlu diuji pemilik (checklist §8 bagian gelombang ini).
```
