# PRD Revisi Fase 3 — koharu-exp

Perbaikan dan penyempurnaan hasil uji pemilik atas Fase 3 (build `feat/custom` @ `b4445470`, Actions Build #14). Dibaca bersama `EXP-PLAN.md` (aturan wajib) dan `PRD-FASE3.md` (spesifikasi asli, terutama §5 persyaratan lintas fitur). **Baca ketiganya, plus catatan uji, sebelum mengubah kode.**

- **Sumber temuan:** `uji-fase3/CATATAN-UJI.md` (17 catatan bernomor, hasil uji MCP dan UI, screenshot di folder yang sama). Nomor `#NN` di dokumen ini merujuk ke nomor catatan itu.
- **Branch:** `feat/custom`. Aturan push, commit, dan larangan PR sama seperti `EXP-PLAN.md` §2.
- **Status:** disetujui pemilik, dikerjakan per gelombang R1 lalu R2.

---

## 1. Ringkasan cakupan

| Gelombang | Isi | Catatan uji |
|---|---|---|
| **R1: bug dan penyempurnaan kecil** | R1-01 … R1-11 | #01, #02, #03, #04, #06, #07, #09 (reset opacity), #11, #13, #15, #16, #17, toast Undo |
| **R2: fitur rasa pakai** | R2-01 … R2-05 | #09 (panel bisa digeser), #10, #12, #14 |

**Tidak dikerjakan sekarang:** #05 (rasa pakai Compare, menunggu diskusi pemilik), #08 dan seluruh backlog di `CATATAN-UJI.md` (MCP untuk Referensi/Compare, mode pengembang "Full UI access"), serta "Pengembangan mendatang" di `PRD-FASE3.md` §7.

Urutan dalam R1: kerjakan **R1-01 lebih dulu** (tingkat tinggi, bisa menghilangkan data referensi), lalu sisanya bebas. Satu commit per item.

---

## 2. R1 — bug dan penyempurnaan kecil

### R1-01. Mode Align aman dari salah tekan (#11, tinggi)
- **Masalah:**
  - selama mode Align, shortcut alat (mis. `T`) dan klik toolbar canvas tetap berjalan, sehingga mode Align tertutup dan geseran yang belum disimpan hilang;
  - **Ctrl+Z di mode Align membatalkan langkah project sebelumnya**, yaitu Attach references (satu langkah undo), sehingga semua referensi terlepas; pada kejadian itu Redo juga tidak mengembalikannya.
- **Yang diharapkan:**
  - selama Align terbuka, shortcut alat dan klik toolbar canvas **diabaikan** (toolbar tampil nonaktif dengan tooltip "Close Align reference first"); mengetik di isian X/Y/Width/Height tidak pernah memicu shortcut;
  - **Ctrl+Z / Ctrl+Shift+Z (dan Edit → Undo/Redo) saat Align terbuka bekerja pada geseran referensi sesi itu saja** (riwayat lokal), tidak pernah menyentuh riwayat project;
  - menutup Align dengan perubahan yang belum disimpan lewat jalur apa pun (Esc, tombol ×, pindah mode) menanyakan **Save / Discard**; pindah halaman tetap auto-save seperti sekarang;
  - selidiki kenapa Redo gagal mengembalikan referensi pada kejadian itu (catatan pemilik: Remove reference → Undo berfungsi normal) dan pastikan Attach/Remove reference selalu bisa di-Undo/Redo.
- **Petunjuk kode:** `packages/koharu/components/editor/CanvasWorkspace.tsx` handler `keydown` (hanya shortcut Compare yang mengecualikan `state.tracing`, ±baris 355; shortcut alat ±400–403; Ctrl+Z ±370), `components/editor/ToolBar.tsx` (`setTool`), `components/editor/Tracing.tsx`, `lib/store.ts` (`tracing`, `stopTracing`, `moveTracing`).
- **Kriteria terima:** dengan Align terbuka, menekan `T`, klik toolbar, atau Ctrl+Z tidak menutup Align dan tidak melepas referensi; Ctrl+Z mengembalikan geseran terakhir; referensi tetap ada setelah semua itu.

### R1-02. `remove` per elemen bersih (#02)
- **Masalah:** `remove` dengan ID elemen meninggalkan sisa goresan teks asli (baris pertama teks dua baris, bintik di tepi huruf; elemen tanpa `source_box` memakai kotak elemen yang lebih kecil dari teksnya). Halaman uji: `…E33P02`.
- **Yang diharapkan:** area dari ID elemen = piksel **mask teks hasil deteksi** (`text-mask`) di dalam kotak elemen yang diperlebar beberapa piksel (mis. 4–8 px, dibatasi bentuk balon bila ada); bila mask tidak ada, pakai gabungan `source_box` dan kotak elemen yang diperlebar. Hasilnya setara dengan tahap Inpainting pipeline untuk balon itu.
- **Petunjuk kode:** tool `remove` di `crates/koharu-app/src/commands/agent/host.rs` dan `crates/koharu-app/src/commands/area.rs`; mask manual di `crates/koharu-pipeline/src/stages/inpainting.rs:473`; mask otomatis `text-mask` ±baris 480.
- **Kriteria terima:** tes dengan elemen dua baris dan elemen tanpa `source_box` tidak menyisakan piksel teks; tes pemilik di `…E33P02` bersih tanpa perlu `rect` tambahan.

### R1-03. Extract tidak menggabungkan teks balon berbeda (#13)
- **Masalah:** di tumpukan tiga balon bersambung (raw `…E33P03`, panel kiri bawah), satu balon raw menerima gabungan dua teks referensi dan dua balon lain kosong. Bentuk/posisi balon edisi referensi memang berbeda dari raw (realistis untuk rilis terjemahan).
- **Yang diharapkan:**
  - satu balon raw **tidak pernah** menerima gabungan teks dari beberapa balon referensi yang terpisah; bila satu balon raw cocok dengan lebih dari satu balon referensi, atau kecocokannya lemah, biarkan **tidak cocok** (ditandai seperti sekarang) supaya diisi lewat Read from reference…;
  - pertimbangkan pencocokan yang memakai **urutan baca di dalam panel** (atas→bawah, kanan→kiri untuk manga) sebagai sinyal tambahan selain tumpang-tindih kotak;
  - jumlah "tidak cocok" di notifikasi tetap akurat.
- **Petunjuk kode:** `crates/koharu-app/src/commands/reference/extract.rs`.
- **Kriteria terima:** tes sintetis meniru tiga balon bertumpuk dengan ukuran berbeda di raw dan referensi: tidak ada penggabungan; kasus normal (balon satu-satu) tetap terisi.

### R1-04. Deteksi area menyebut alasan bila dilewati (#03)
- **Masalah:** `run_pipeline` detection dengan `region` dilewati diam-diam (`elapsed_ms: 0`, `added_elements: []`), terutama setelah elemen teks di balon itu dihapus.
- **Yang diharapkan:** hasil tool menyertakan `skipped: true` dan `reason` (mis. "area overlaps text element X" / "bubble Y already holds text"); balon yang elemen teksnya sudah dihapus **tidak lagi** dianggap berisi teks.
- **Petunjuk kode:** `crates/koharu-pipeline/src/stages/detection.rs`, `crates/koharu-app/src/commands/processing.rs`, tool `run_pipeline` di `host.rs`.
- **Kriteria terima:** hapus elemen teks di satu balon → deteksi area di balon itu menemukan teksnya lagi; bila tetap dilewati, alasannya terbaca agent.

### R1-05. Status beberapa halaman sekaligus (#16)
- **Masalah:** memilih beberapa halaman (Ctrl+klik) lalu mengubah status lewat menu ⋯ tidak berlaku untuk semuanya, padahal kodenya sudah dimaksudkan begitu (`packages/koharu/components/editor/PageRail.tsx:231`).
- **Yang diharapkan:** cari penyebabnya (mis. membuka menu ⋯ mengubah pilihan, atau Ctrl+klik tidak menambah pilihan) lalu perbaiki; perubahan status untuk N halaman = satu langkah Undo.
- **Kriteria terima:** pilih 3 halaman → ubah status dari menu ⋯ salah satunya → ketiganya berubah → satu Undo mengembalikan ketiganya.

### R1-06. Jawaban tool tetap terkirim saat server dimatikan (#17)
- **Masalah:** Claude Code menjalankan `run_pipeline` ocr untuk seluruh project; pemilik mematikan toggle MCP server; klien menerima `no response message received from handler`.
- **Yang diharapkan (PRD-FASE3 F3-1):** tool yang berjalan dibiarkan selesai, hasil tersimpan, **jawaban dikirim ke klien**, baru koneksi ditutup; panggilan baru selama Stopping… ditolak dengan pesan jelas; "Stop now" membatalkan dan klien menerima hasil "cancelled".
- **Petunjuk kode:** `crates/koharu-agent/src/mcp/supervisor.rs` (`stop`, ±baris 305), `crates/koharu-agent/src/mcp/mod.rs` (`accept`, koneksi di-abort saat shutdown).
- **Kriteria terima:** tes integrasi: klien rmcp memanggil tool lambat (Host tiruan), server dihentikan di tengah jalan → klien menerima hasil sukses; panggilan kedua ditolak.

### R1-07. Tombol profil tidak gelap setelah diklik (#01)
- Tombol profil yang baru diklik dan masih di-hover harus langsung tampil dengan gaya aktif (latar pink, teks terang). Kode: `packages/koharu/components/preferences/McpPreferences.tsx` ±160–174 (varian `ghost` vs `data-[active=true]:…`).

### R1-08. Angka zoom tidak menumpuk tombol Compare (#04)
- Di status bar, angka zoom ("37%", "100%", "144%") dan tombol Compare tidak boleh saling menutupi pada nilai zoom berapa pun. Kode: `packages/koharu/components/editor/StatusBar.tsx` (`<CompareButton />` langsung setelah `<span className='w-9 …'>{zoom}%</span>`), `components/editor/Compare.tsx` (`CompareButton`).

### R1-09. Ctrl+Z tanpa riwayat tidak memunculkan error
- Saat riwayat undo kosong (mis. setelah Free up disk space), Ctrl+Z / Ctrl+Shift+Z tidak memanggil backend dan tidak menampilkan toast merah "Could not complete that action — nothing to undo"; cukup diam (menu Edit sudah memakai `project.can_undo`). Kode: `CanvasWorkspace.tsx` handler Ctrl+Z.

### R1-10. Pemasangan referensi yang mudah diatur (#06, #07)
Dialog **Import references**, daftar pasangan:
- **Drag and drop** (#06, revisi disetujui pemilik): seret thumbnail referensi ke baris halaman tujuan; referensi yang tadinya di sana bertukar tempat atau pindah ke "Skipped" (pilih yang paling jelas, jelaskan di commit).
- **"Pair with page…"**: dropdown per referensi untuk memilih halaman tujuan langsung.
- **Unpair** per baris: halaman ini tanpa referensi, **pasangan lain tidak bergeser** (#07).
- Tombol yang menggeser diberi label/tooltip yang jelas (mis. "Skip and shift up", "Empty here and shift down") dan setelah diklik muncul info "N pairs shifted".
- **Pasangan otomatis berdasarkan nama file** sebelum jatuh ke urutan: bila nama raw dan referensi punya bagian penanda halaman yang sama (mis. `…_E33P01` di `ja_…_E33P01.jpg` dan `id_…_E33P01.jpg`), pasangkan itu; sisanya berdasarkan urutan.
- **Kriteria terima:** sample `uji-fase3`-style (raw 11 halaman, referensi 11 file dengan nama sepadan) langsung 11/11 benar; satu file referensi bisa dipasang ke halaman 4 dengan satu tindakan; Unpair tidak menggeser baris lain; Attach + Undo tetap satu langkah.
- **Petunjuk kode:** `packages/koharu/components/editor/References.tsx`, `crates/koharu-app/src/commands/reference/mod.rs`.

### R1-11. Panel Align: label tombol dan reset opacity (#15, sebagian #09)
- Label menyebut cakupan: **Save (this page)** dan **Save for this and N following pages** (N dihitung sebelum diklik); notifikasi selalu muncul setelah menyimpan.
- Tombol **Fit to page** diberi tooltip "Reset to the page size and position".
- **Reference opacity**: tampilkan angka persen, tombol reset kecil (kembali ke default 50%, `lib/store.ts:222`), dan dobel-klik slider juga me-reset.
- Kode: `packages/koharu/components/editor/Tracing.tsx`, `lib/store.ts`, `public/locales/en-US/translation.json`.

---

## 3. R2 — fitur rasa pakai

### R2-01. Panel mengambang bisa digeser dan diperkecil (#09)
- **Panel Align reference** dan **toolbar alat canvas** (`ToolBar.tsx`) bisa **diseret** dari pegangan/judulnya dan bisa **dilipat** jadi ikon/bar kecil lalu dibuka lagi; posisi dan status lipat diingat (per panel).
- Tidak boleh keluar dari area canvas; ada cara mengembalikan ke posisi awal.

### R2-02. Kalkir mudah dipakai di area putih (#10)
- **Garis tepi referensi** selalu tampil di mode Align (garis putus-putus warna mencolok + label kecil "Reference").
- Pilihan **mode campur**: **Normal** (opacity, seperti sekarang), **Difference** (piksel yang sama jadi hitam, yang meleset menyala), **Tint** (referensi diwarnai, mis. merah/cyan).
- Opsional: tahan satu tombol untuk **berkedip** antara raw dan referensi.
- **Kriteria terima:** di halaman berpinggir putih, tepi referensi dan pergeseran 20 px terlihat jelas tanpa bergantung panel bergambar.

### R2-03. Add reference… per halaman (#12)
- Menu ⋯ halaman: **Add reference…** (pilih satu file gambar, langsung terpasang ke halaman itu tanpa dialog pasangan; pilih bahasa referensi dengan default bahasa target) dan **Replace reference…** bila halaman sudah punya referensi. Satu langkah Undo.

### R2-04. Ctrl+drag untuk zoom ke area (#12)
- Di canvas, Compare, dan mode Align: **Ctrl+drag** menggambar kotak, lalu tampilan zoom ke kotak itu (marquee zoom). Tidak bentrok dengan seleksi/geser yang sudah ada; di mode Align, drag biasa tetap menggeser referensi.

### R2-05. Tanda teks meluber di UI (#14)
- Elemen yang teksnya meluber atau mengecil di bawah ukuran terbaca (data yang sama dengan peringatan MCP F3-13, `layout.overflowed()` di `crates/koharu-renderer/src/text_renderer.rs:276`) diberi tanda di UI: garis kotak merah di canvas, ikon peringatan di panel Layers dan Inspector, dan jumlahnya di notifikasi setelah Extract / Run Translation.

---

## 4. Verifikasi

- **Cloud:** seperti `PRD-FASE3.md` §5.4 (fmt, clippy, test crate yang disentuh, `bun run lint` + `bun run test`), ditambah tes baru yang disebut di kriteria terima tiap item.
- **Actions:** push ke `feat/custom` setelah tiap gelombang; build Windows harus hijau.
- **Manual uji:** tambahkan bagian baru **"Uji revisi R1/R2"** di `MANUAL-UJI-FASE3.md`, satu checklist per item (R1-01 … R2-05), mengacu ke langkah di `uji-fase3/CATATAN-UJI.md`. Jangan mengubah isi `uji-fase3/` selain menandai status catatan yang sudah diperbaiki (kolom Status → "Diperbaiki di R1/R2, menunggu uji pemilik").

## 5. Prompt cloud session

```
Repo: Jeanjinmo/koharu-exp, branch feat/custom.

Sebelum mengubah apa pun, baca seluruhnya:
1. EXP-PLAN.md (aturan wajib fork ini)
2. PRD-FASE3.md (spesifikasi Fase 3, terutama §5)
3. PRD-REVISI-FASE3.md (tugas sesi ini)
4. uji-fase3/CATATAN-UJI.md beserta screenshot di folder itu (temuan uji pemilik)

Tugas: kerjakan GELOMBANG R1 lalu R2 sesuai PRD-REVISI-FASE3.md. Mulai dari R1-01.

Aturan tegas:
- Jangan pernah membuat Pull Request ke repo mana pun.
- Push hanya ke origin feat/custom. Jangan push tag, main, atau feat/agent-mcp.
- Jangan merge/rebase ke upstream.
- Satu commit per item (R1-01, R1-02, …).
- Push setelah R1 selesai, lalu lagi setelah R2.

Setelah selesai: pastikan build Windows di Actions hijau, perbarui MANUAL-UJI-FASE3.md
(bagian "Uji revisi R1/R2") dan kolom Status di uji-fase3/CATATAN-UJI.md, lalu laporkan:
item yang selesai, yang tertunda beserta alasannya, keputusan desain yang kamu ambil
(mis. perilaku drag and drop di R1-10), dan hal yang perlu diuji pemilik.
```
