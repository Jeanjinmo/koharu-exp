# PRD Revisi Fase 3 (lanjutan) — koharu-exp

Perbaikan hasil **uji ulang** pemilik atas revisi R1/R2 (build `feat/custom` @ `49a59cf2`, 2026-10-22). Dibaca bersama `EXP-PLAN.md` (aturan wajib), `PRD-FASE3.md` (spesifikasi asli, terutama §5), dan `PRD-REVISI-FASE3.md` (revisi R1/R2 yang dilanjutkan di sini). **Baca semuanya, plus catatan uji, sebelum mengubah kode.**

- **Sumber temuan:** `uji-fase3/CATATAN-UJI.md`, bagian "Uji ulang revisi R1/R2" dan catatan bernomor **#18–#27** (screenshot di folder yang sama). Nomor `#NN` di dokumen ini merujuk ke nomor catatan itu.
- **Branch:** `feat/custom`. Aturan push, commit, dan larangan PR sama seperti `EXP-PLAN.md` §2.
- **Status:** disetujui pemilik, dikerjakan per gelombang R3 lalu R4.

---

## 1. Ringkasan cakupan

| Gelombang | Isi | Catatan uji |
|---|---|---|
| **R3: bug dan penyempurnaan kecil** | R3-01 … R3-07 | #19, #20, #21, #23, #24, #26, #27 |
| **R4: fitur rasa pakai** | R4-01, R4-02 | #18, #22 |

**Tidak dikerjakan (keputusan pemilik, ikuti bawaan Koharu):**
- #25 batas ukuran terbaca tetap `MINIMUM_FONT_SIZE = 9.0` (`crates/koharu-renderer/src/renderer.rs:53`).
- `run_pipeline` seluruh project tetap tercatat satu langkah undo per halaman (`PipelineCommitter`, bawaan 0.83.5).
- Menu **Shift ▾** di dialog Import references dibiarkan seperti sekarang; pemilik menilai ulang setelah R4-01.

**Juga tidak dikerjakan:** #05 (rasa pakai Compare, menunggu diskusi), #08 dan backlog di `CATATAN-UJI.md` (MCP untuk Referensi/Compare, mode pengembang "Full UI access"), "Pengembangan mendatang" di `PRD-FASE3.md` §7.

**Urutan:** R3-01 lebih dulu (tingkat tinggi, pemilik bisa terjebak di dialog). **R3-03 harus selesai sebelum R4-01** karena dialog baru memakai cara seret yang sama. Satu commit per item.

**Catatan lingkungan:** tiga temuan (#21, #23, #24) hanya muncul di aplikasi Windows (CEF) dan lolos dari test jsdom yang ada. Jangan bergantung pada perilaku browser yang tidak bisa diuji di cloud; pilih penanganan eksplisit (lihat tiap item) dan tambah test yang mensimulasikan urutan event nyata (`pointerdown` → `pointermove` → `pointerup` → `click`, dengan pointer capture).

---

## 2. R3 — bug dan penyempurnaan kecil

### R3-01. Tombol dialog "Save this alignment?" bisa diklik (#23, tinggi)
- **Masalah:** saat menutup Align dengan geseran yang belum disimpan, dialog **Save this alignment?** muncul, tetapi Keep aligning / Discard / Save tidak bereaksi; hanya Esc yang bekerja.
- **Penyebab (dicek di kode):** `AlertDialog` dirender di dalam `TracingPanel` (`Tracing.tsx:535`), dan `TracingPanel` adalah anak permukaan canvas (`CanvasWorkspace.tsx:836`). Dialog dipasang lewat portal ke `body`, tetapi event React tetap merambat ke induk React-nya. `onPointerDown` permukaan canvas (`CanvasWorkspace.tsx:621-635`) hanya mengecualikan `[data-canvas-control]` lewat `closest()` pada DOM, jadi tombol dialog (di portal) tidak dikecualikan, lalu canvas memanggil `setPointerCapture` dan `click` tidak pernah sampai ke tombol.
- **Yang diharapkan:**
  - penangan pointer permukaan canvas mengabaikan event yang target DOM-nya **tidak berada di dalam permukaan itu** (`if (!event.currentTarget.contains(event.target as Node)) return`), sehingga semua elemen portal (dialog, menu, popover) yang dirender dari dalam canvas aman;
  - periksa pola yang sama di penangan pointer lain yang membungkus elemen ber-portal (lapisan Align `Tracing.tsx:147`, Compare `Compare.tsx:193`/`:310`, `ReferencePick.tsx:75`) dan terapkan pengecualian yang sama bila perlu.
- **Kriteria terima:** test komponen: buka Align, geser, tutup → dialog muncul; urutan `pointerdown`/`pointerup`/`click` pada Discard dan Save menjalankan aksinya (Discard menutup tanpa menyimpan, Save menyimpan lalu menutup, Keep aligning kembali ke Align). Tidak ada `setPointerCapture` pada permukaan canvas untuk event dari portal.

### R3-02. View bisa digeser di mode Align (#24)
- **Masalah (pemilik, Windows):** di mode biasa scroll menggeser view; di mode Align scroll tidak menggeser view. Drag kiri menggeser referensi (benar), sehingga view terasa terkunci.
- **Analisis:** `onWheel` lapisan Align (`Tracing.tsx:184`) hanya mengambil Alt+wheel dan membiarkan event lain merambat ke `onWheel` permukaan canvas (`CanvasWorkspace.tsx:780`) yang memanggil `wheelCamera`. Menurut kode seharusnya bergeser (komentar `Tracing.tsx:55-57`), tetapi di Windows tidak. Penyebab pasti belum ketemu; belum ada test wheel di `tests/components/tracing.test.tsx`.
- **Juga (dari kode):** di Align, **Spasi+drag** dan **drag tombol tengah** tidak menggeser view: lapisan Align menangkap semua tekanan kiri untuk menggeser referensi tanpa memeriksa Spasi (`Tracing.tsx:147`), dan permukaan canvas mengabaikan tekanan dari `[data-canvas-control]` (`CanvasWorkspace.tsx:631`) sehingga drag tombol tengah hilang.
- **Yang diharapkan (perilaku sama dengan mode biasa):**
  - scroll = geser naik/turun, Shift+scroll = kiri/kanan, Ctrl+scroll = zoom; **Alt+scroll tetap mengubah ukuran referensi**;
  - **Spasi+drag** dan **drag tombol tengah** menggeser view; drag kiri biasa tetap menggeser referensi; Ctrl+drag tetap marquee zoom (R2-04);
  - jangan bergantung pada perambatan event: lapisan Align menangani sendiri wheel non-Alt dengan `wheelCamera` (sama seperti `CanvasWorkspace.tsx:798-805`), dan menangani Spasi/tombol tengah sebagai pan.
- **Kriteria terima:** test: di Align, wheel (tanpa modifier, dengan Shift, dengan Ctrl) mengubah `camera`; Alt+wheel mengubah ukuran referensi tanpa mengubah `camera`; Spasi+drag dan drag tombol tengah mengubah `camera.translation` tanpa mengubah posisi referensi.

### R3-03. Drag and drop berbasis pointer events (#21)
- **Masalah:** drag and drop HTML5 tidak pernah sampai ke `drop` di aplikasi Windows (CEF): bayangan ikut kursor dan baris tujuan menyala, tetapi setelah dilepas tidak ada yang berubah. Terjadi di **dialog Import references** (R1-10) dan di **urutan halaman daftar Pages** (fitur bawaan Koharu, `PageRail.tsx` `draggable`/`onDrop` ±baris 397-412 dan 605-611). Terverifikasi pemilik juga gagal di **Koharu resmi 0.83.5**; fork tidak mengubah versi Tauri/CEF maupun konfigurasi jendela.
- **Keputusan pemilik (pilihan B):** perbaiki **kedua tempat**.
- **Yang diharapkan:**
  - ganti seret HTML5 dengan seret **berbasis pointer events** (pola yang sama dengan pegangan panel R2-01, `useFloatingPanel.ts`): tekan + geser melewati ambang kecil (mis. 4 px) memulai seret, bayangan/ghost mengikuti kursor, target dicari dengan `document.elementFromPoint`, lepas = jatuhkan;
  - **daftar Pages:** menyeret kartu mengubah urutan halaman lewat command bawaan `movePage` (sama dengan tool MCP `move_page`), satu langkah Undo; daftar bergulir otomatis saat kursor di dekat tepi atas/bawah; Ctrl+klik/Shift+klik untuk memilih tetap bekerja; klik tanpa geser tetap memilih/membuka halaman;
  - **dialog Import references:** baris ↔ baris (bertukar), baris → **Not paired** (lepas), **Not paired** → baris (pasang), memakai `moveReference` yang ada (`References.tsx:142`);
  - kursor **grab/grabbing** pada elemen yang bisa diseret;
  - hapus atribut `draggable` dan penangan `onDragStart`/`onDragOver`/`onDrop` HTML5 yang digantikan (AGENTS.md: tanpa bentuk lama).
- **Kriteria terima:** test dengan urutan pointer events nyata: memindahkan halaman 3 ke bawah halaman 4 memanggil `movePage` sekali dengan indeks yang benar; di dialog, menyeret referensi dari baris 1 ke baris 5 yang kosong memindahkannya, ke baris berisi menukarnya, ke Not paired melepasnya; klik tanpa geser tidak memicu seret.

### R3-04. Label Activity untuk `run_pipeline` seluruh project (#19)
- **Masalah:** baris Activity untuk `run_pipeline` tanpa `pages`/`elements`/`region` berbunyi "Page 1 · …E33.jpg", seolah hanya halaman 1 yang diproses. Penyebab: `host.rs:211` memakai `first_page(snapshot, &scope)` lalu `on_page(…, page)` (`host.rs:249`).
- **Yang diharapkan:** Activity menyebut cakupan sebenarnya: seluruh project → "All pages (N)"; beberapa halaman → "N pages"; satu halaman/region → halaman itu seperti sekarang. Bila halaman pertama dipakai untuk **Follow agent**, pisahkan halaman untuk Follow agent dari label Activity.
- **Kriteria terima:** test `ToolActivity` untuk tiga cakupan itu; Follow agent tetap berpindah ke halaman yang sedang diproses.

### R3-05. Kartu halaman berbadge tidak tumpang-tindih (#20)
- **Masalah:** kartu yang punya badge status atau **Reference** lebih tinggi dari barisnya, sehingga baris "2481 × 3503" tertimpa kartu berikutnya (`bug20-daftar-halaman-*.png`). Penyebab yang paling mungkin: virtualizer daftar memakai `estimateSize: () => 72` tetap tanpa `measureElement` (`PageRail.tsx:112-118`).
- **Yang diharapkan:** tinggi baris mengikuti isi kartu (pakai `measureElement` dari `@tanstack/react-virtual`, atau estimasi yang menghitung badge), tanpa tumpang-tindih dengan atau tanpa badge; scroll tetap mulus untuk project panjang.
- **Kriteria terima:** test/rendering: kartu dengan badge status + Reference tidak menimpa kartu berikutnya; kartu tanpa badge tetap seperti sekarang.

### R3-06. Toolbar di sisi canvas saat Compare side by side (#27)
- **Masalah:** saat **Side by side**, toolbar alat (`ToolBar.tsx:75`, `absolute top-3 left-3`) ditempatkan di wadah yang memuat panel referensi **dan** canvas (`CanvasWorkspace.tsx:608-610`), sehingga menutupi panel referensi kiri, padahal alatnya bekerja di canvas kanan.
- **Yang diharapkan:** toolbar ditempatkan relatif terhadap **canvas kerja**: saat Side by side, posisi bawaannya di pojok kiri atas canvas kanan. Posisi hasil geser pemilik (R2-01) tetap diingat dan dibatasi di dalam canvas. Tanpa Side by side tidak ada perubahan.
- **Kriteria terima:** dengan Side by side aktif, kotak toolbar tidak bertumpang-tindih dengan `ComparePane`; tanpa Side by side posisinya sama seperti sebelumnya.

### R3-07. Kolom teks Inspector tumbuh mengikuti isi (#26)
- **Masalah:** kolom **Source text**, **Translation**, dan tampilan **Reference** di Inspector dibatasi `max-h-14`/`max-h-16` (±3–4 baris, `Inspector.tsx:915`, `:930`, `:967`); teks panjang harus digulir di kotak kecil.
- **Yang diharapkan:** kolom tumbuh mengikuti isi sampai ±12 baris, baru setelah itu bergulir; pegangan ubah ukuran tetap ada; perilaku commit `CommitTextarea` tidak berubah.

---

## 3. R4 — fitur rasa pakai

### R4-01. Dialog Import references yang lebih luwes (#22)
Lanjutan R1-10; memakai seret dari R3-03. Keputusan pemilik ada di `CATATAN-UJI.md` Masukan 22.
- **Add files…** menggantikan **Choose other files** dan **menambah** file ke daftar (sekarang `stage_references` mengganti seluruh daftar, `crates/koharu-app/src/commands/reference/mod.rs:120`; ubah menjadi menambah dengan indeks yang stabil untuk file yang sudah ada). File baru dipasangkan otomatis hanya ke halaman yang **masih kosong**; pasangan yang ada tidak diganggu. File yang sama dipilih dua kali diabaikan (cocokkan isi, mis. hash byte, bukan hanya nama). "Mulai dari awal" cukup lewat Cancel lalu buka lagi.
- **Not paired** menjadi wadah sementara yang jelas: teks "Files here are not attached" dan tombol **×** per file untuk membuangnya dari daftar. File yang tidak dipakai tetap dibuang saat Attach/menutup dialog seperti sekarang.
- Tombol **Auto pair**: memasang ulang **semua** file (termasuk yang di wadah) dengan aturan yang sama seperti saat import (`pairReferences`, `References.tsx:104`: angka halaman di nama file, sisanya menurut urutan); pasangan buatan tangan ikut tertimpa. Tombol **Unpair all**: semua file kembali ke wadah.
- **Undo/Redo** untuk **semua** perubahan di dalam dialog (tumpukan riwayat lokal: pasang, lepas, tukar, Shift, Auto pair, Unpair all, buang file), lewat tombol kecil dan **Ctrl+Z / Ctrl+Shift+Z selama dialog terbuka**. Ctrl+Z di dialog **tidak boleh** menyentuh riwayat undo project (jebakan yang sama dengan #11). Ganti tautan "Undo" khusus Shift yang sekarang (`shift.before`) dengan riwayat umum ini.
- **Pratinjau:** klik thumbnail (raw atau referensi) di sebuah baris membuka pratinjau **raw dan referensinya berdampingan** dalam ukuran besar, bisa diperbesar/digeser, dengan panah ke baris sebelumnya/berikutnya; Esc menutup. Ikon mata kecil di pojok kanan atas thumbnail sebagai penanda (tampil saat hover). Klik tanpa geser = pratinjau; tekan lalu geser = seret (R3-03).
- **Tetap seperti sekarang:** ⇅ **Pair with page…**, **Unpair** per baris, **Shift ▾**, bahasa referensi, Trim margins, Attach + satu Undo project.
- **Kriteria terima:** test: Add files dua kali menambah tanpa mengubah pasangan lama dan mengabaikan duplikat; Auto pair memasang ulang semua; Unpair all mengosongkan semua baris; Ctrl+Z di dialog membatalkan langkah dialog terakhir dan tidak memanggil undo project; × membuang file dari wadah; pratinjau terbuka dari klik thumbnail.

### R4-02. Tombol salin konfigurasi klien di MCP Tools (#18)
- **Masalah:** bila pendaftaran Koharu di klien (Claude Code, Grok Build, Hermes) hilang, pemilik harus menyusun perintah sendiri dan menyalin token dari `~/.koharu/mcp.json`. Custom connector claude.ai tidak bisa dipakai (butuh HTTPS publik dan OAuth).
- **Keputusan pemilik:** **tombol Copy saja**. Koharu **tidak** membaca atau mengubah config klien, tanpa tombol Connect/Repair, tanpa deteksi status klien.
- **Yang diharapkan:** bagian baru **Connect a client** di Settings → MCP Tools (di bawah Server), dengan tombol salin untuk beberapa format, memakai URL dan token server yang sedang dipakai:
  - **JSON umum** (untuk klien apa pun): `{"mcpServers":{"koharu":{"type":"http","url":"<url>","headers":{"Authorization":"Bearer <token>"}}}}`;
  - **Claude Code:** `claude mcp add --transport http --scope user koharu <url> --header "Authorization: Bearer <token>"`;
  - **Grok Build:** `grok mcp add --transport http koharu <url> --header "Authorization: Bearer <token>"`;
  - **Hermes** (potongan `config.yaml`): `mcp_servers.koharu` dengan `url`, header `Authorization`, dan `timeout: 900`.
- **Keamanan:** token **tidak pernah tampil** di layar dan tidak masuk log/Activity. Utamakan teks salinan disusun di Rust dan ditulis langsung ke clipboard; bila harus lewat frontend, teks hanya dipegang sesaat untuk `clipboard.writeText` dan tidak dirender. Setelah menyalin tampil notifikasi singkat "Copied — includes the access token". Teks bantuan kecil: setelah didaftarkan, klien perlu reconnect atau dimulai ulang.
- **Kriteria terima:** test: setiap format berisi URL dan token yang benar; token tidak muncul di DOM; tidak ada berkas klien yang dibaca atau ditulis.

---

## 4. Verifikasi

- **Cloud:** seperti `PRD-FASE3.md` §5.4 (fmt, clippy, test crate yang disentuh, `bun run lint` + `bun run test`), ditambah test baru di kriteria terima tiap item. Bila command atau tipe Tauri berubah, jalankan `cargo run -p koharu-app --bin generate` (jangan edit `protocol.ts` manual).
- **Actions:** push ke `feat/custom` setelah tiap gelombang; build Windows harus hijau.
- **Manual uji:** tambahkan bagian baru **"Uji revisi R3/R4"** di `MANUAL-UJI-FASE3.md` (setelah §11), satu checklist per item, mengacu ke langkah di `uji-fase3/CATATAN-UJI.md`. Sekalian koreksi §11 R1-03: halaman tumpukan tiga balon adalah **`…E33P03` (halaman 5)**, bukan `…E33P04`.
- **Catatan uji:** jangan mengubah isi `uji-fase3/` selain kolom Status catatan yang diperbaiki → "Diperbaiki di R3/R4, menunggu uji pemilik" (#06 bagian drag, #11 bagian dialog, #18–#24, #26, #27). #25 tetap seperti sekarang.

## 5. Prompt cloud session

```
Repo: Jeanjinmo/koharu-exp, branch feat/custom.

Sebelum mengubah apa pun, baca seluruhnya:
1. EXP-PLAN.md (aturan wajib fork ini)
2. PRD-FASE3.md (spesifikasi Fase 3, terutama §5)
3. PRD-REVISI-FASE3.md (revisi R1/R2 sebelumnya, sebagai konteks)
4. PRD-REVISI-2-FASE3.md (tugas sesi ini)
5. uji-fase3/CATATAN-UJI.md, terutama "Uji ulang revisi R1/R2" dan catatan #18–#27,
   beserta screenshot di folder itu

Tugas: kerjakan GELOMBANG R3 lalu R4 sesuai PRD-REVISI-2-FASE3.md. Mulai dari R3-01.
R3-03 harus selesai sebelum R4-01.

Aturan tegas:
- Jangan pernah membuat Pull Request ke repo mana pun.
- Push hanya ke origin feat/custom. Jangan push tag, main, atau feat/agent-mcp.
- Jangan merge/rebase ke upstream.
- Satu commit per item (R3-01, R3-02, …).
- Push setelah R3 selesai, lalu lagi setelah R4.
- #21, #23, #24 hanya muncul di Windows (CEF): jangan mengandalkan perilaku browser
  yang tidak bisa diuji di sini; tulis test dengan urutan pointer/wheel event nyata.

Setelah selesai: pastikan build Windows di Actions hijau, tambahkan bagian
"Uji revisi R3/R4" di MANUAL-UJI-FASE3.md (dan koreksi halaman R1-03 di §11),
perbarui kolom Status di uji-fase3/CATATAN-UJI.md, lalu laporkan: item yang selesai,
yang tertunda beserta alasannya, keputusan desain yang kamu ambil (mis. penyebab #24,
cara seret R3-03, format salinan R4-02), dan hal yang perlu diuji pemilik.
```
