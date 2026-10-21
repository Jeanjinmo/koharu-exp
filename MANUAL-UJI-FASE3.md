# Manual uji Fase 3 — koharu-exp

Manual ini untuk pemilik: menguji langsung di PC Windows semua fitur Fase 3 (gelombang 3A–3E) yang sudah selesai di `feat/custom`. Isinya merangkum checklist PRD-FASE3 §8 ditambah tes yang hanya bisa dilakukan di aplikasi nyata.

- Label UI di manual ini ditulis persis seperti di aplikasi (bahasa Inggris).
- Tes bertanda ⭐ adalah yang paling penting. Kalau waktunya sempit, kerjakan §2 (tes inti) dulu.
- Catat setiap bug dengan format di §9. Tidak perlu dibetulkan di tempat; cukup dicatat.
- **Revisi R1/R2** (perbaikan hasil uji di `uji-fase3/CATATAN-UJI.md`) punya checklist sendiri di **§11**. Bagian lain manual ini sudah memakai label dan perilaku sesudah revisi.

## 1. Persiapan (sekali)

1. Buka tab Actions di repo fork, pilih run **Build** terbaru yang hijau di branch `feat/custom`, lalu unduh artifact `koharu-windows-latest`. Artifact hanya disimpan **3 hari**. Kalau sudah kedaluwarsa, buka workflow **Build**, klik **Run workflow**, pilih branch `feat/custom`, lalu unduh dari run baru itu.
2. Tutup Koharu resmi. Ganti hanya `koharu.exe` di `D:\Dev\clone-projects\koharu-exp-run\koharu-windows-latest\`.
3. Backup `%USERPROFILE%\.koharu\config.toml` dan `%USERPROFILE%\.koharu\mcp.json`.
4. Buat **project tes baru**, jangan project penting. Siapkan bahannya:
   - 3–6 halaman raw (bahasa Jepang) dari satu chapter;
   - edisi terjemahan halaman yang sama (Inggris dan/atau Indonesia) dalam bentuk **PDF** atau **CBZ**. Usahakan ada **satu halaman tambahan** (sampul atau kredit) di depan, untuk menguji **Skip and shift up**;
   - satu klien MCP (Claude Code, Hermes, atau Grok Build) dengan config Fase 1.
5. Log aplikasi ada di `%LOCALAPPDATA%\Koharu\logs`. Lampirkan file log terbaru kalau ada error.
6. Catatan: Extract text from references dan Read from reference… memakai model **PaddleOCR-VL**. Model ini diunduh saat pertama dipakai kalau belum ada, jadi pemakaian pertama bisa lama.

## 2. Tes inti (±45 menit) ⭐

Satu putaran ini menyentuh semua gelombang. Kalau semua lolos, sisa manual tinggal pendalaman.

1. ⭐ Buka Koharu, lalu **Settings → MCP Tools**. Status **Running at …** dan klien MCP bisa tersambung.
2. ⭐ Minta agent menerjemahkan satu halaman ke bahasa Indonesia. Alurnya: `run_pipeline` (detection lalu ocr), lalu `set_translations` sekali untuk semua balon, lalu `set_page_status`.
   - Harus terlihat: badge status di daftar halaman, dan halaman di layar Koharu ikut pindah ke halaman yang dikerjakan agent.
   - **Edit → Undo** sekali membatalkan semua terjemahan dari panggilan itu.
3. ⭐ Minta agent `remove` satu balon saja. Hanya area balon itu yang berubah; logo dan balon lain tetap.
4. ⭐ Tekan **C** (Compare). Coba ketiga mode lewat panah kecil di tombol **Compare** di status bar.
5. ⭐ Jalankan **File → Import references…** dengan PDF terjemahan. Periksa daftar pasangan: referensi dipasangkan dari nama file bila cocok, sisanya berurutan. Bila ada sampul tambahan, pilih **Shift ▾ → Skip and shift up** di baris sampul, lalu **Attach N references**. Halaman mendapat badge **Reference**.
6. ⭐ Buka **View → Align reference…**. Geser referensi sedikit, lalu klik **Save for this and N following pages**.
7. ⭐ Jalankan **Process → Extract text from references**. Muncul notifikasi jumlah area teks yang terisi. Pilih satu balon: di Inspector (tab Properties) tampil **Reference (…)** di antara source dan translation.
8. ⭐ Untuk satu balon yang tidak terisi, klik **Read from reference…**, lalu tarik kotak di atas teks referensinya. Teks masuk ke balon itu.
9. ⭐ Buka tab **Glossary** di panel kanan dan tambah satu istilah. Minta agent `read_glossary`; istilah itu harus muncul.
10. ⭐ Export PNG (**File → Export Project → PNG…**). Hasilnya **tidak** memuat gambar referensi, hanya raw yang sudah diedit.
11. ⭐ Di project tes: jalankan **File → Clear project…**, lalu Undo; semua halaman kembali. Lalu jalankan **File → Free up disk space…**; ukuran folder `.khrproj` di `Documents\Koharu` mengecil.

## 3. Gelombang 3A — tool MCP baru

Semua tes 3A dijalankan lewat agent (klien MCP).

- [ ] ⭐ **Daftar tool**: agent melihat tool `inspect_page`, `set_translations`, `remove`, `draw`, `erase`, `export`, `set_page_status`, `read_glossary`, `set_glossary_terms` (23 tool total kalau semua aktif).
- [ ] ⭐ **set_translations + tag bahasa (F3-10/12)**: terjemahkan satu halaman ke bahasa Indonesia dalam satu panggilan.
  - Tidak ada pemenggalan kata yang aneh seperti "SEN-TUHAN".
  - Undo sekali membatalkan semua terjemahan panggilan itu.
- [ ] **Peringatan tidak muat (F3-13)**: sengaja beri satu terjemahan yang sangat panjang. Hasil tool memuat peringatan bahwa teks tidak muat atau mengecil di bawah ukuran terbaca.
- [ ] ⭐ **remove (F3-2)**: `remove` dengan ID elemen satu balon. Hanya area itu yang di-inpaint ke layer cleanup; balon lain dan logo tidak berubah.
- [ ] **draw (F3-3)**: isi satu kotak dengan warna putih; muncul di layer cat.
- [ ] **erase (F3-4)**: hapus sebagian area yang tadi di-`draw`. Lalu `erase` di layer cleanup: gambar asli terlihat lagi di area itu.
- [ ] **inspect_page (F3-7)**: hasilnya jauh lebih kecil dari `inspect_project`. Isinya per elemen: ID, kotak, teks sumber, terjemahan, typography inti, dan status halaman.
- [ ] **view_page dengan region (F3-11)**: potongan tampil tajam, dan hasil tool melaporkan ukuran halaman, area, dan `scale`.
- [ ] **export (F3-6)**: export PNG satu halaman.
  - Tepat satu file, di folder baru di dalam folder export.
  - Export kedua membuat folder baru, tidak menimpa yang pertama.
- [ ] **Deteksi ulang area (F3-14)**: `run_pipeline` operation detection dengan `region` di area teks yang terlewat. Elemen baru bertambah; elemen lain tidak rusak. Kalau di area itu sudah ada teks, tahapnya dilewati (sengaja) dan hasil tool menyebut alasannya di `skipped`.

## 4. Gelombang 3B — kendali MCP dan manajemen halaman

**Tab MCP Tools (F3-1)**
- [ ] ⭐ Status **Running at 127.0.0.1:47821** dan jumlah klien terlihat.
- [ ] ⭐ Matikan switch **MCP server** ketika agent sedang menjalankan pipeline:
  - status menjadi **Stopping… (waiting for N tasks)**;
  - tool baru ditolak;
  - setelah pipeline selesai, status menjadi **Off**.
- [ ] **Stop now** saat sedang menunggu: panggilan yang berjalan dibatalkan.
- [ ] Nyalakan lagi; klien tersambung kembali **tanpa mengubah config** (token tetap sama).
- [ ] Port bentrok: jalankan sesuatu di port 47821 lalu nyalakan server. Status menjadi **Error: …**, lalu **Retry** berhasil setelah port dikosongkan.

**Profil, label, tooltip (F3-18)**
- [ ] ⭐ Pilih profil **Text-only model**: `view_page` hilang dari klien. Klien yang mendukung `tools/list_changed` diberi tahu tanpa reconnect.
- [ ] Hilangkan centang satu tool, misalnya `export`. Tool itu hilang dari klien, atau ditolak dengan pesan "Tool `export` is disabled in Koharu settings".
- [ ] Ikon ⓘ dan label **needs vision**, **edits image**, **deletes** tampil, dan tooltip-nya bisa dibaca.

**Follow agent (F3-5)**
- [ ] ⭐ Nyalakan **Follow agent**, lalu pakai browser sambil agent bekerja. Koharu pindah ke halaman yang diubah agent, tetapi **tidak merebut fokus** dan tidak muncul ke depan.

**Log aktivitas (F3-16)**
- [ ] Bagian **Activity** berisi panggilan terakhir: nama tool, halaman, berhasil atau gagal, dan durasi. **Clear** mengosongkannya. Argumen dan token tidak pernah tampil.

**Status halaman (F3-15)**
- [ ] ⭐ Badge status tampil di daftar halaman.
  - Bisa diubah dari menu ⋯ halaman.
  - Kalau beberapa halaman dipilih, perubahan berlaku untuk semuanya.
  - Bisa juga diubah dari MCP lewat `set_page_status`.
- [ ] Undo membatalkan perubahan status.

**Clear project (F3-8) dan Free up disk space (F3-9)**
- [ ] ⭐ **File → Clear project…**: project kosong, lalu Undo mengembalikan semua halaman.
- [ ] Clear dengan centang **Also free up disk space**: tidak bisa di-Undo (sengaja), dan folder project mengecil.
- [ ] **File → Free up disk space…** menampilkan perkiraan ukuran dulu. Setelah dijalankan, muncul notifikasi ukuran yang dibebaskan dan riwayat undo kosong (sengaja).

## 5. Gelombang 3C — Compare

- [ ] ⭐ Compare bisa dibuka dari **View → Compare**, tombol **Compare** di status bar, dan shortcut **C**. Shortcut bisa diganti di **Settings → Shortcuts**.
- [ ] ⭐ **Side by side**:
  - kiri gambar asli tanpa toolbar, kanan canvas biasa;
  - zoom (Ctrl+wheel) dan geser di **kedua** sisi tetap sinkron;
  - mengedit di kanan berfungsi penuh.
- [ ] Menutup Compare mengembalikan tampilan seperti sebelumnya.
- [ ] ⭐ **Slider**: garis pembagi bisa digeser dengan mouse dan tombol panah. Saat halaman di-zoom out atau tidak penuh layar, batas gambar asli **tepat di garis** (bug ini sudah diperbaiki di Fase 3).
- [ ] **Hold to peek**: gambar asli hanya tampil selama C ditahan.
- [ ] Mode terakhir diingat setelah aplikasi ditutup dan dibuka lagi.
- [ ] Pindah halaman di daftar halaman: kedua sisi ikut berpindah.

## 6. Gelombang 3D — Referensi terjemahan

**Import dan pasangan halaman**
- [ ] ⭐ **File → Import references…**, atau menu ⋯ di judul Pages:
  - pilih **Reference language** (defaultnya bahasa target di Settings);
  - opsional **Trim margins**;
  - lalu **Choose files…** (PDF, CBZ, ZIP, RAR, gambar) atau **Choose folder…**.
- [ ] ⭐ Daftar pasangan muncul dengan thumbnail raw dan referensi. Referensi dipasangkan lebih dulu dari penanda halaman di nama file (mis. `…_E33P01` di kedua nama), sisanya berurutan.
  - Seret thumbnail referensi ke baris lain, atau pakai ⇅ **Pair with page…**: referensi di baris tujuan bertukar tempat dengannya.
  - **Unpair** mengosongkan satu halaman tanpa menggeser baris lain; referensinya pindah ke **Not paired:**.
  - Menu **Shift ▾**: **Skip and shift up** (referensi sesudahnya naik satu halaman) dan **Empty here and shift down** (turun satu halaman). Sesudahnya muncul "N pairs shifted" dengan **Undo**.
- [ ] Ringkasan jumlah pasangan dan referensi yang tidak dipasangkan benar. Halaman yang sudah punya referensi bertulisan "Replaces the current reference".
- [ ] **Attach N references** sekali, lalu Undo sekali menghapus semua referensi dari import itu.
- [ ] **Cancel** atau **Choose other files** tidak menulis apa pun ke project.
- [ ] PDF besar (misalnya 50+ halaman): import selesai tanpa aplikasi kehabisan memori. Bila sempat, catat pemakaian memori di Task Manager.
- [ ] Menu ⋯ halaman → **Remove reference** menghapus referensi halaman itu, atau semua halaman terpilih yang punya referensi.
- [ ] Menu ⋯ halaman → **Add reference…** (atau **Replace reference…**) memasang satu gambar ke halaman itu saja, dalam satu Undo.

**Compare dengan referensi**
- [ ] ⭐ Halaman yang punya referensi: sisi pembanding Compare **otomatis menampilkan referensi** di posisinya.
- [ ] Di menu panah tombol Compare, **Compare with → Original** mengganti pembanding ke raw.

**Mode kalkir (Align reference)**
- [ ] ⭐ **View → Align reference…**, atau menu panah Compare: raw tampil dengan referensi transparan di atasnya, bergaris tepi putus-putus berlabel **Reference**.
  - Seret untuk menggeser referensi.
  - **Alt+wheel** mengubah ukuran di sekitar kursor.
  - Panah menggeser 1 px, Shift+panah 10 px.
  - Wheel biasa tetap menggeser atau zoom kamera; **Ctrl+drag** zoom ke area.
- [ ] Panel kalkir: **View** (Normal, Difference, Tint), slider **Reference opacity** dengan persen dan tombol reset, tombol −/+, isian X/Y/Width/Height (piksel halaman), dan **Fit to page**.
- [ ] **Save (this page)** menyimpan posisi halaman ini dan Undo membatalkannya. **Cancel** tidak menyimpan apa pun.
- [ ] ⭐ **Save for this and N following pages**: posisi yang sama dipakai halaman ini dan N halaman sesudahnya yang punya referensi, dalam satu Undo.
- [ ] Pindah halaman saat mode kalkir aktif: posisi halaman sebelumnya tersimpan otomatis (sengaja), lalu panel lanjut ke halaman baru.

**Extract text from references**
- [ ] ⭐ **Process → Extract text from references** (semua halaman berreferensi), atau menu ⋯ halaman → **Extract text from reference**.
  - Halaman yang belum di-OCR menjalankan Detection dan OCR dulu, terlihat di panel aktivitas.
  - Setelah itu panel aktivitas menampilkan **Reading references**.
  - Tombol Stop berfungsi.
- [ ] ⭐ Referensi **bahasanya sama** dengan bahasa target: teks masuk ke **translation** (dan juga tampil sebagai Reference di Inspector).
- [ ] ⭐ Referensi **bahasanya beda**: teks hanya masuk ke **Reference (…)**, sedangkan translation tidak berubah.
- [ ] Setelah selesai, notifikasi menyebut berapa area terisi, berapa yang tidak cocok, dan berapa teks yang tidak muat. Balon yang tidak cocok bertulisan "Nothing from the reference yet…" di Inspector.
- [ ] Undo sekali membatalkan seluruh hasil Extract dari satu run (Detection dan OCR sebelumnya punya langkah undo sendiri).
- [ ] Terjemahan yang Anda ketik sendiri **tidak ditimpa** ketika Extract dijalankan ulang.
- [ ] Jalankan **Process → Run Translation** (berlaku untuk seluruh project). Terjemahan yang Anda ketik sendiri atau yang ditulis agent tidak ditimpa, jadi periksa balon lain:
  - referensinya **berbahasa lain**: hasil terjemahan jelas memakai makna dan istilah dari referensi;
  - referensinya **sebahasa**: terjemahannya tetap sama dengan teks referensi.

**Read from reference… (pasangan manual)**
- [ ] ⭐ Pilih satu balon yang tidak cocok, lalu klik **Read from reference…** di Inspector. Referensi tampil di atas halaman. Tarik kotak di atas teks yang benar, dan teks masuk ke balon itu dalam satu Undo.
- [ ] Esc atau Cancel keluar tanpa membaca. Klik tanpa menarik kotak diabaikan.

**Tidak ikut export dan render**
- [ ] ⭐ **File → Export Project** ke PNG, PSD, dan CBZ: referensi **tidak** ikut. Canvas normal juga tidak menampilkan referensi; referensi hanya tampil di Compare dan saat mengalign atau memilih area.
- [ ] `inspect_page` lewat MCP menampilkan `reference` per elemen yang punya teks referensi.

## 7. Gelombang 3E — Glosarium

- [ ] ⭐ Tab **Glossary** di panel kanan (di antara Properties dan Agent):
  - tambah istilah lewat **Add**: Term, Translation, Note opsional;
  - ubah istilah lewat ikon pensil, termasuk mengganti istilahnya;
  - hapus lewat ikon tempat sampah;
  - cari lewat kotak pencarian.
- [ ] Istilah ganda ditolak dengan pesan "This term is already in the glossary."
- [ ] Setiap perubahan bisa di-Undo.
- [ ] ⭐ Agent: `read_glossary` mengembalikan daftarnya. `set_glossary_terms` menambah atau mengubah istilah, dan istilah dari agent langsung muncul di tab Glossary.
- [ ] ⭐ Pipeline Translation pada halaman yang memuat istilah glosarium: istilah diterjemahkan persis sesuai glosarium dan mengikuti catatannya.
- [ ] Tutup lalu buka lagi project: glosarium tetap ada.

## 8. Yang tidak bisa diuji di cloud — perhatikan khusus

Selama pengerjaan, sesi pengerja menjalankan di cloud: fmt dan clippy, tes Rust untuk setiap crate yang diubah, lint, typecheck, dan seluruh tes UI (163 setelah revisi R1/R2). Semua lulus, dan build Windows di Actions hijau. Tes otomatis memakai data sintetis. Hal berikut **hanya** bisa dibuktikan di PC Anda:

1. **Model ML nyata dan GPU**:
   - layout detection pada **halaman referensi** (komik berbahasa Inggris atau Indonesia);
   - kualitas OCR PaddleOCR-VL untuk teks referensi;
   - pemuatan model tambahan saat OCR halaman memakai model lain, misalnya MangaOCR.
2. **Kecocokan balon otomatis** pada halaman nyata. Ambang pencocokan dipilih secara teori dan diuji dengan kotak buatan, bukan halaman sungguhan. Catat contoh balon yang tertukar atau terlewat; itu bahan penyetelan.
3. **Tampilan WebGPU** di jendela desktop:
   - Compare side by side dan slider lurus dengan canvas di zoom tinggi dan rendah;
   - mode kalkir dan pemilihan area tepat di posisi yang benar, termasuk tampilan Difference dan Tint;
   - layar HiDPI (scaling Windows 125–150%).
4. **Dialog file Windows**: pilih file, pilih folder, folder export, dan satu gambar untuk **Add reference…**.
5. **Seret dan lepas** di dialog Import references (CEF/WebView).
6. **Klien MCP nyata**: `tools/list_changed` diterima Claude Code, Hermes, dan Grok Build tanpa reconnect.
7. **Fokus jendela** saat Follow agent aktif.
8. **Memori** saat import PDF referensi yang besar.

## 9. Format catatan bug

Salin blok ini per bug:

```
Judul singkat:
Gelombang/fitur: (misal 3D – Align reference)
Langkah:
1.
2.
Yang diharapkan:
Yang terjadi:
Sering? (selalu / kadang / sekali)
Lampiran: screenshot, file log dari %LOCALAPPDATA%\Koharu\logs, nama halaman/project
```

## 10. Perilaku yang disengaja (bukan bug)

- **Free up disk space** mengosongkan riwayat undo dan tidak bisa dibatalkan. Dialognya memberi tahu ini.
- Teks UI baru hanya dalam bahasa Inggris; bahasa lain memakai teks Inggris untuk kunci baru.
- Selama pipeline berjalan, memasang, melepas, dan membaca referensi ditolak dengan pesan error. Jalankan lagi setelah pipeline selesai. Ini menjaga commit pipeline tetap aman.
- **Extract** selalu memakai PaddleOCR-VL untuk referensi apa pun model OCR halaman, karena MangaOCR, Baberu, dan Hayai hanya membaca bahasa Jepang.
- Bubble yang berisi dua teks Jepang terpisah: teks referensi masuk ke teks pertama saja. Teks kedua dibiarkan, dan tidak dihitung sebagai "tidak cocok".
- Balon yang tidak mendapat teks referensi ditandai di Inspector ("Nothing from the reference yet…") dan dihitung di notifikasi setelah Extract. Belum ada penanda di canvas; kalau saat uji terasa perlu, catat sebagai permintaan.
- Provider mesin terjemah (DeepL, Google Cloud, Caiyun) tidak memakai referensi berbahasa lain maupun glosarium; semua provider LLM, termasuk model lokal, memakainya. Referensi yang sebahasa tetap disalin menjadi terjemahan untuk provider apa pun.
- Pasangan manual dibuat lewat **Read from reference…** di Inspector, yang menampilkan referensi di atas halaman seperti Compare. Cara ini dipilih karena lebih jelas daripada memasangkan dua kotak di dua panel.
- **Cancel** di panel Align membuang perubahan tanpa bertanya, karena itu pilihan eksplisit. Hanya Esc, ×, dan pindah mode yang bertanya **Save this alignment?**.
- Selama Align, menahan shortcut Compare (**C**) membuat raw dan referensi berkedip; shortcut itu tidak membuka Compare di mode Align.
- **Difference** dan **Tint** selalu memakai referensi penuh (100%), sehingga slider opacity hanya berlaku di **Normal**.
- Di canvas, **Ctrl+klik** memilih layer saat tombol dilepas (bukan saat ditekan), karena tekan-lalu-seret dengan Ctrl kini berarti zoom ke area.
- Di dialog Import references, menyeret referensi ke baris yang sudah berisi **menukar** keduanya; referensi yang datang dari **Not paired** membuat referensi lama di baris itu pindah ke **Not paired**.
- **Replace reference…** memakai bahasa referensi lama sebagai default; **Add reference…** memakai bahasa target.
- Notifikasi jumlah teks yang tidak muat setelah Run Translation hanya muncul bila ada teks yang tidak muat.

## 11. Uji revisi R1/R2

Untuk build **Build** hijau dari commit `49a59cf` atau sesudahnya di `feat/custom`. Nomor `#NN` merujuk ke catatan di `uji-fase3/CATATAN-UJI.md`: ulangi langkah catatan itu, lalu centang hasilnya di sini. Bila lolos, ubah Status catatannya di sana.

### R1 — bug dan penyempurnaan kecil

**R1-01. Mode Align aman dari salah tekan (#11)** ⭐
- [ ] Buka **View → Align reference…** dan geser referensi sedikit. Tekan `T`, `B`, `Delete`, lalu klik ikon **Text** di toolbar: Align tetap terbuka, alat tidak berganti, referensi tidak hilang. Toolbar tampak redup dengan tooltip "Close Align reference first".
- [ ] Ketik angka di isian X/Y/Width/Height (mis. `120`): tidak ada shortcut yang terpicu, dan satu isian yang diketik = satu langkah undo.
- [ ] ⭐ **Ctrl+Z** mengembalikan geseran terakhir (satu seretan = satu langkah), **Ctrl+Shift+Z** mengulanginya. **Edit → Undo/Redo** juga hanya bekerja pada geseran. Attach references tidak pernah terlepas.
- [ ] Tutup Align dengan perubahan yang belum disimpan lewat **Esc**, tombol **×**, atau tombol **Compare**: muncul **Save this alignment?** dengan **Keep aligning / Discard / Save**.
- [ ] Pindah halaman saat Align tetap menyimpan posisi otomatis.
- [ ] Menu ⋯ → **Remove reference**, Undo, Redo, Undo: referensi lepas, kembali, lepas, kembali. Penyebab Redo gagal di #11: Ctrl+Z di Align membatalkan Attach, lalu aksi berikutnya (mis. menyimpan posisi) mengosongkan riwayat Redo. Jalur itu kini tertutup.

**R1-02. `remove` per elemen bersih (#02)** ⭐
- [ ] Di `…E33P02`, minta agent `remove` dengan ID elemen balon dua baris dan elemen tanpa `source_box`: tidak ada sisa goresan, tanpa `rect` tambahan, setara tahap Inpainting untuk balon itu.
- [ ] Balon lain dan garis balon di sekitarnya tidak ikut pudar.

**R1-03. Extract tidak menggabungkan teks balon berbeda (#13)** ⭐
- [ ] Ulangi #13 di `…E33P04` (tumpukan tiga balon kiri bawah): tidak ada balon yang menerima gabungan dua teks referensi. Balon yang tidak cocok dengan jelas dibiarkan bertanda "Nothing from the reference yet…" untuk diisi lewat **Read from reference…**.
- [ ] Balon biasa (satu-satu) tetap terisi, dan jumlah "found no match" di notifikasi sama dengan jumlah balon bertanda.

**R1-04. Deteksi area menyebut alasan (#03)**
- [ ] Hapus elemen teks di satu balon, lalu minta agent `run_pipeline` detection dengan `region` di balon itu: teksnya terdeteksi lagi.
- [ ] Ulangi di balon yang masih berteks: hasil tool memuat `skipped` berisi `page`, `stage`, dan `reason` (mis. "bubble … already holds text element …").

**R1-05. Status beberapa halaman sekaligus (#16)** ⭐
- [ ] Ctrl+klik 3 halaman, lalu ubah status dari menu ⋯ salah satunya: ketiganya berubah, dan satu Undo mengembalikan ketiganya.
- [ ] Ctrl+klik dua halaman dengan cepat: keduanya tetap terpilih.

**R1-06. Jawaban tool tetap terkirim saat server dimatikan (#17)**
- [ ] Ulangi #17: saat agent menjalankan `run_pipeline` ocr seluruh project, matikan switch **MCP server**. Status **Stopping…**, panggilan yang berjalan selesai dan klien **menerima hasilnya** (bukan "no response message received from handler"), baru kemudian **Off**.
- [ ] Panggilan baru selama Stopping… ditolak dengan pesan jelas. **Stop now** membatalkan, dan klien menerima hasil "cancelled".

**R1-07. Tombol profil tidak gelap (#01)**
- [ ] Klik profil lain di **Settings → MCP Tools** dan biarkan kursor di atasnya: tombol langsung pink dengan teks terang.

**R1-08. Angka zoom tidak menumpuk Compare (#04)**
- [ ] Pada zoom 37%, 100%, 144%, dan 800%, angka zoom selalu berjarak dari tombol **Compare**.

**R1-09. Ctrl+Z tanpa riwayat tidak memunculkan error**
- [ ] Setelah **File → Free up disk space…**, tekan Ctrl+Z dan Ctrl+Shift+Z: tidak terjadi apa pun, tanpa toast merah.

**R1-10. Pemasangan referensi yang mudah diatur (#06, #07)** ⭐
- [ ] Import 11 referensi `id_…` untuk 11 halaman `ja_…`: langsung **11 of 11** benar dari nama file, apa pun urutan filenya. Ujung nama file (mis. `…_E33P01.jpg`) selalu terlihat.
- [ ] Ulangi #06 dengan satu file referensi: bila namanya sepadan, ia langsung jatuh ke halamannya. Bila tidak (mis. diganti nama menjadi `scan.jpg`), ⇅ **Pair with page…** → halaman 4 memindahkannya dalam satu tindakan.
- [ ] Seret thumbnail referensi ke baris lain: referensi di baris tujuan bertukar tempat dengannya. Seret ke **Not paired** untuk melepasnya.
- [ ] **Unpair** di satu baris: halaman itu kosong, baris lain **tidak bergeser**.
- [ ] Ulangi #07 dengan **Shift ▾ → Skip and shift up** dan **Empty here and shift down**: setelah diklik muncul "N pairs shifted" dengan **Undo**, yang mengembalikan pasangan sebelumnya.
- [ ] Attach, lalu satu Undo melepas semua referensi import itu.

**R1-11. Panel Align: label tombol dan reset opacity (#15, #09)**
- [ ] Tombol berbunyi **Save (this page)** dan **Save for this and N following pages**, dengan N = halaman sesudahnya yang punya referensi. Tombol kedua tidak tampil bila N = 0.
- [ ] Setiap simpan memunculkan notifikasi "Alignment saved for …", juga ketika posisinya tidak berubah.
- [ ] Tooltip **Fit to page**: "Reset to the page size and position".
- [ ] **Reference opacity** menampilkan persen. Tombol ↺ kecil dan dobel-klik slider mengembalikannya ke 50%.

### R2 — fitur rasa pakai

**R2-01. Panel bisa digeser dan dilipat (#09)** ⭐
- [ ] Seret toolbar alat dari pegangan ⠿ di atasnya, dan panel Align dari judulnya: keduanya pindah dan berhenti di tepi area canvas.
- [ ] Tombol ˄ melipat toolbar menjadi pegangannya dan panel Align menjadi bar judul; ˅ membukanya lagi.
- [ ] Tutup lalu buka lagi Align, lalu restart aplikasi: posisi dan status lipat tiap panel diingat.
- [ ] Dobel-klik pegangan atau judul mengembalikan panel ke tempat awalnya.

**R2-02. Kalkir di area putih (#10)** ⭐
- [ ] Di halaman berpinggir putih, garis putus-putus fuchsia berlabel **Reference** selalu menandai tepi referensi.
- [ ] **View → Difference**: yang pas menjadi hitam, yang meleset menyala. **Tint**: garis raw cyan, garis referensi merah, garis yang pas hitam. Geser referensi 20 px (Shift+panah dua kali): pergeserannya jelas di kedua mode tanpa melihat panel bergambar.
- [ ] Tahan **C**: raw dan referensi berkedip bergantian; lepas untuk berhenti.

**R2-03. Add reference… per halaman (#12)** ⭐
- [ ] Menu ⋯ halaman tanpa referensi → **Add reference…**: atur **Reference language** (default bahasa target) dan **Trim margins**, lalu **Choose image…** memasang satu gambar ke halaman itu saja.
- [ ] Halaman berreferensi → **Replace reference…** (bahasa default = bahasa referensi lama). Satu Undo mengembalikan referensi lama; Undo pada Add melepasnya.
- [ ] Membatalkan dialog file membiarkan dialog Add/Replace tetap terbuka.

**R2-04. Ctrl+drag untuk zoom ke area (#12)** ⭐
- [ ] **Ctrl+drag** menggambar kotak lalu zoom ke kotak itu di canvas (alat apa pun), di sisi Original pada Compare side by side, dan di mode Align.
- [ ] Di Align, drag biasa tetap menggeser referensi. Di canvas, **Ctrl+klik** tanpa menyeret tetap menambah atau membuang layer dari seleksi.

**R2-05. Tanda teks meluber (#14)** ⭐
- [ ] Beri satu balon terjemahan yang sangat panjang: kotak teksnya bergaris merah di canvas, layernya berikon ⚠ di Layers, dan editor layernya menyebut penyebabnya ("The text runs past its frame" atau "…shrinks below the readable size…").
- [ ] Pendekkan teksnya: tanda hilang.
- [ ] Setelah **Extract text from references**, notifikasinya menyebut "N texts do not fit their frames." bila ada. Setelah **Run Translation**, muncul notifikasi peringatan dengan jumlah itu bila ada teks yang tidak muat.

## Lampiran — jawaban pertanyaan terbuka PRD §9

1. **Detection dengan `Scope::Region` (F3-14).** Didukung. Tahap Detection menyaring hasil ke area itu dan mempertahankan mask teks di luar area. Ia dilewati bila area itu sudah berisi teks atau balon yang sudah berisi teks, supaya teks lama tidak terlepas dari balonnya.
2. **Penyimpanan data baru (tanpa merusak project lama).** Semua memakai komponen scene baru bernamespace `dev.koharu-exp.*`. Project lama terbuka seperti biasa, karena komponen yang tidak ada berarti "belum ada".
   - Status halaman: komponen `PageStatus` di halaman. Tanpa komponen berarti Not started.
   - Glosarium: satu komponen project `Glossary`.
   - Referensi: gambar disimpan sebagai aset halaman ber-role `reference`, yang tidak dibaca oleh render maupun export. Komponen `PageReference` menyimpan bahasa dan posisi (pecahan ukuran halaman). Teks referensi per elemen ada di komponen `ReferenceText`.
3. **`notifications/tools/list_changed` di rmcp.** Didukung untuk dua generasi protokol: lewat sesi (sebelum 2026-07-28) dan lewat `subscriptions/listen` (sesudahnya). Sudah diuji dengan klien rmcp sungguhan di tes otomatis.
4. **Menampilkan gambar asli saja di Compare.** Aset `source` halaman digambar sebagai gambar biasa dengan transformasi kamera yang sama dengan canvas WebGPU. Tidak ada canvas kedua dan visibilitas layer tidak disentuh. Referensi digambar dengan cara yang sama di posisinya.
5. **Memori import PDF referensi besar.** Mesin import kini memproses PDF halaman per halaman: satu halaman 300 DPI ukuran A4 sekitar 33 MiB RGBA saat dirender, lalu langsung dikonversi. Referensi disimpan sebagai JPEG kualitas 90 dan maksimal 4096 px, sehingga per halaman biasanya sekitar 0,5–1,5 MB di RAM sampai di-attach (perkiraan, belum diukur di Windows). Import halaman raw biasa tetap menyimpan PNG semua halaman seperti sebelumnya.
