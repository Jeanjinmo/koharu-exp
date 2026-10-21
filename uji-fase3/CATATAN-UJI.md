# Catatan uji Fase 3 — koharu-exp

Hasil uji pemilik di Windows untuk build `feat/custom` @ `b4445470` (Actions Build #14). Format mengikuti `MANUAL-UJI-FASE3.md` §9. Gambar ada di folder ini.

| # | Judul | Gelombang/fitur | Tingkat | Status |
|---|---|---|---|---|
| 01 | Tombol profil gelap dan tak terbaca setelah diklik | 3B – F3-18 profil | Rendah (tampilan) | Terbuka |
| 02 | `remove` dengan ID elemen meninggalkan sisa coretan teks asli | 3A – F3-2 `remove` | Sedang | Terbuka |
| 03 | Deteksi ulang area dilewati tanpa alasan, dan terblokir setelah elemen dihapus | 3A – F3-14 | Rendah–sedang | Terbuka |
| 04 | Angka zoom menumpuk di atas tombol Compare di status bar | 3C – F3-19 Compare | Rendah (tampilan) | Terbuka |
| 05 | Mode Slider di Compare terasa kaku (masukan UX) | 3C – F3-19 Compare | Rendah (rasa pakai) | Perlu detail |
| 06 | Pasangan referensi tidak bisa dipindah langsung ke halaman tertentu (permintaan fitur) | 3D – F3-20 Import references | Sedang (rasa pakai) | Revisi (disetujui pemilik) |
| 07 | Skip menggeser semua pasangan sesudahnya tanpa peringatan; tidak ada cara melepas satu pasangan tanpa menggeser | 3D – F3-20 Import references | Sedang (rasa pakai) | Terbuka |
| 08 | MCP tidak bisa tahu halaman punya referensi, apalagi melihat gambarnya, sebelum Extract | 3D – F3-20 × MCP | Rendah (sesuai PRD, kandidat mendatang) | Catatan |
| 09 | Panel Align reference dan toolbar canvas tidak bisa digeser atau diperkecil; opacity referensi tanpa tombol reset | 3D – Align reference; UI editor | Sedang (rasa pakai) | Terbuka |
| 10 | Mode kalkir sulit dipakai di area putih: tepi referensi dan pas/tidaknya tidak terlihat | 3D – Align reference | Sedang (rasa pakai) | Terbuka |
| 11 | Mode Align tertutup oleh tombol alat/shortcut (geseran hilang); Ctrl+Z di mode Align membatalkan import referensi | 3D – Align reference | Tinggi | Terbuka |
| 12 | Tambah "Add reference…" di menu ⋯ halaman; Ctrl+drag untuk zoom ke area | 3D – Referensi, Align | Sedang (permintaan fitur) | Terbuka |
| 13 | Extract salah memasangkan teks di balon bertumpuk (dua teks referensi masuk ke satu balon, dua balon kosong) | 3D – Extract text from references | Sedang | Terbuka |
| 14 | UI tidak menandai teks yang meluber keluar balon (peringatan tidak muat baru ada untuk MCP) | Editor / F3-13 | Sedang (permintaan fitur) | Terbuka |
| 15 | Tombol Save dan "Apply to following pages" di Align terasa sama; cakupannya tidak jelas | 3D – Align reference | Rendah (rasa pakai) | Terbuka |
| 16 | Ubah status beberapa halaman sekaligus (Ctrl+klik) tidak berfungsi | 3B – F3-15 status halaman | Sedang | Terbuka |
| 17 | Saat MCP server dimatikan, agent tidak menerima hasil tool yang sedang berjalan (koneksi putus) | 3B – F3-1 | Sedang | Perlu verifikasi |

## Hasil uji MCP oleh Claude Code (2026-10-21)

Project tes `pepper&carrot-chap33` (Pepper&Carrot ep. 33, raw Jepang). Halaman 4 (`…E33P02`) untuk alur terjemahan, halaman 3 (`…E33P01`) untuk alat gambar dan deteksi area.

| Tes | Hasil | Catatan |
|---|---|---|
| Daftar tool | ✅ | 23 tool, instruksi server versi Fase 3 |
| `read_glossary` kosong | ✅ | |
| `view_page` ukuran + skala | ✅ | 2481×3503, `scale` 0,292 |
| `view_page` `region` | ✅ | Potongan resolusi penuh, `scale` 1,0 |
| `run_pipeline` detection lalu ocr (halaman 4) | ✅ | 5 elemen, OCR Jepang benar. SFX dan balon hitam berteks Latin tidak terdeteksi (keterbatasan model) |
| `inspect_page` | ✅ | ±1,4 ribu karakter; `inspect_project` besar terutama karena daftar font |
| `set_glossary_terms` + `read_glossary` | ✅ | 3 istilah tersimpan |
| `remove` dengan ID elemen | ⚠️ | Teks hilang, tapi ada sisa coretan → Bug 02 |
| `remove` dengan `rect` | ✅ | Bersih bila kotak di dalam balon. Kotak yang melewati garis balon membuat garis itu pudar (perilaku model, bukan bug) |
| `set_translations` tanpa `language` | ✅ | Tag otomatis `id-ID`, pemenggalan kata wajar, tanpa peringatan |
| `set_translations` = satu langkah undo | ✅ | 5 balon diberi awalan "TES: " dalam satu panggilan; satu Undo mengembalikan kelimanya bersamaan, satu Redo memunculkan kelimanya lagi (dicek pemilik di panel Layers) |
| `set_translations` validasi semua dulu | ✅ | Satu ID tidak valid → seluruh panggilan ditolak, tidak ada balon yang berubah |
| Peringatan teks tidak muat | ✅ | `font_size: 9`, `overflows: true`; hilang setelah teks dipendekkan |
| `set_page_status` | ✅ | Halaman 4 = translated_by_agent (badge perlu dicek pemilik) |
| `run_pipeline` detection `region` (halaman 3, belum pernah dideteksi) | ✅ | 1 elemen SFX ditambahkan, OCR membacanya |
| `run_pipeline` detection `region` (halaman 4) | ⚠️ | Tidak menambah apa pun → Bug 03 |
| `draw` putih (kotak) | ✅ | Layer cat baru, tepi tepat |
| `erase` layer cat | ✅ | Separuh kotak hilang tepat |
| `erase` layer cleanup | ✅ | Gambar asli muncul lagi di area itu |
| `add_text_box` + `set_source_text` + `set_translation` | ✅ | |
| Follow agent | ✅ (sisi data) | `active_page` ikut berpindah. Hasil `add_text_box` sempat masih menyebut halaman sebelumnya; perlu dicek pemilik di layar |
| `export` PNG satu halaman, 2× | ✅ | Folder export `sample\output\from-mcp`. Tiap export = subfolder baru berisi 1 file (10,4 MB); export kedua di menit yang sama diberi akhiran `_2`, tidak menimpa |
| Profil Text-only model | ✅ | `view_page` langsung hilang dari daftar tool Claude Code tanpa reconnect (`tools/list_changed` diterima) |
| Hilangkan centang `export` | ✅ | Profil otomatis jadi Custom; `export` hilang dari daftar tool Claude Code |
| Activity | ✅ | Jam, status, nama tool, halaman (nomor + nama), durasi; tanpa argumen dan token. Baris `export` tidak menyebut halaman (wajar, bisa banyak halaman) |
| Activity: panggilan gagal | ✅ | `set_translations` dengan ID elemen yang sudah tidak ada tampil dengan tanda ✕ merah dan pesan error lengkap. Setelah halaman dihapus (Clear project), baris lama menampilkan potongan ID halaman, bukan nomor/nama (wajar) |
| Export dari UI (File → Export Project) | ✅ | Tetap seluruh project (11 file), sama dengan bawaan Koharu |

---

## Bug 01 — Tombol profil gelap dan tak terbaca setelah diklik

- **Gelombang/fitur:** 3B – F3-18, Settings → MCP Tools → Tools → Profile.
- **Langkah:**
  1. Buka **Settings → MCP Tools**.
  2. Arahkan mouse ke salah satu tombol profil (Vision model / Text-only model / Read-only / Custom): tampilan hover normal.
  3. Klik tombol itu, dan **biarkan kursor tetap di atasnya**.
- **Yang diharapkan:** tombol yang terpilih langsung tampil dengan gaya aktif (latar pink, teks terang), seperti `bug01-profil-normal.png`.
- **Yang terjadi:** tombol yang baru diklik berlatar gelap/hitam dengan teks merah gelap yang hampir tak terbaca (`bug01-profil-setelah-klik.png`, tombol "Vision model"). Baru tampil benar setelah kursor dikeluarkan dari tombol lalu diarahkan ke sana lagi.
- **Sering?** Selalu (setiap klik profil).
- **Lampiran:** `bug01-profil-normal.png`, `bug01-profil-setelah-klik.png`.
- **Dugaan awal (belum diverifikasi):** gaya hover/pressed dari varian `ghost` komponen `Button` mengalahkan kelas `data-[active=true]:…` saat tombol masih di-hover tepat setelah status aktif berubah. Kode: `packages/koharu/components/preferences/McpPreferences.tsx` sekitar baris 160–174 (`aria-pressed`, `data-active`, `className` dengan `data-[active=true]:hover:bg-primary/90`). Cek juga apakah status `profile` berubah setelah panggilan `setMcpTools` selesai sehingga hover tidak dihitung ulang di CEF.

---

## Bug 02 — `remove` dengan ID elemen meninggalkan sisa coretan teks asli

- **Gelombang/fitur:** 3A – F3-2 tool MCP `remove`.
- **Langkah:**
  1. Halaman `…E33P02`: `run_pipeline` detection, lalu ocr (5 elemen teks).
  2. `remove` dengan `elements` berisi kelima ID elemen.
  3. Lihat hasilnya dengan `view_page` `region` di tiap balon.
- **Yang diharapkan:** semua coretan teks Jepang di dalam balon hilang, seperti hasil inpainting pipeline.
- **Yang terjadi:**
  - balon tengah: baris pertama elemen dua baris (`ご覧あれ` di atas `この...`) sebagian besar masih terlihat, plus bintik kecil di tepi huruf `任せて`;
  - balon kanan (elemen tanpa `source_box`, kotak 291×109): baris pertama `…私の特別な` masih terlihat sebagian;
  - balon kiri: dua bintik kecil di tepi huruf.
- **Sering?** Selalu pada halaman itu.
- **Penanganan sementara yang terbukti:** `remove` dengan `rect` yang sedikit lebih besar dari teks tapi masih di dalam balon membersihkan semuanya. Kotak yang melewati garis balon membuat garis itu pudar (wajar untuk LaMa).
- **Dugaan (belum diverifikasi):** area dari ID elemen terlalu ketat. Untuk elemen tanpa `source_box` dipakai kotak elemen yang lebih kecil dari teks aslinya; untuk elemen bertepi ketat, goresan di tepi huruf tidak ikut ter-mask. Usulan: pakai mask teks hasil deteksi (`text-mask`) di dalam kotak elemen yang diperlebar beberapa piksel, atau lebarkan kotaknya (dibatasi bentuk balon bila ada).

## Bug 03 — Deteksi ulang area dilewati tanpa alasan, dan terblokir setelah elemen dihapus

- **Gelombang/fitur:** 3A – F3-14 `run_pipeline` operation `detection` dengan `region`.
- **Langkah dan hasil:**
  1. Halaman `…E33P02`, region di balon hitam berteks Latin "Realitas Hackeris Pepperus!" (tidak terdeteksi saat deteksi halaman penuh): `added_elements: []`, `elapsed_ms` ±600. Kemungkinan keterbatasan model (teks putih di balon hitam), bukan bug.
  2. Halaman yang sama: `delete_elements` satu elemen di balon kanan atas, lalu region tepat di balon itu: `elapsed_ms: 0`, revisi tidak berubah, `added_elements: []`. Deteksi tidak dijalankan sama sekali.
  3. Halaman `…E33P01` yang belum pernah dideteksi: region di SFX besar → 1 elemen ditambahkan (mekanisme berfungsi).
- **Yang diharapkan:** setelah elemen teks dihapus, deteksi area di balon itu bisa menemukan teksnya lagi; bila dilewati, hasil tool menyebut alasannya.
- **Yang terjadi:** dilewati diam-diam. Agent tidak bisa membedakan "dilewati" dari "tidak menemukan apa pun".
- **Dugaan:** aturan "dilewati bila area menyentuh balon yang sudah berisi teks" masih menganggap balon itu berisi teks setelah elemennya dihapus (region/relasi balon tertinggal).
- **Usulan:** hasil tool menyertakan `skipped` + alasan; dan periksa apakah balon tanpa elemen teks masih dianggap berisi teks.

## Bug 04 — Angka zoom menumpuk di atas tombol Compare di status bar

- **Gelombang/fitur:** 3C – F3-19, tombol **Compare** di status bar.
- **Langkah:** buka halaman mana saja di editor, lihat status bar bawah (slider zoom, angka zoom, tombol Compare).
- **Yang diharapkan:** angka zoom ("42%") dan tombol Compare (ikon + label + panah dropdown) bersebelahan dengan jarak, tidak saling menutupi.
- **Yang terjadi:** angka "42%" tergambar di atas ikon dan huruf awal label "Compare" (`bug04-statusbar-compare-tumpang.png`).
- **Sering?** Selalu (terlihat di zoom 42%; perlu dicek di nilai zoom lain, mis. 100% yang lebih lebar).
- **Lampiran:** `bug04-statusbar-compare-tumpang.png`.
- **Petunjuk kode:** `packages/koharu/components/editor/StatusBar.tsx`: `<CompareButton />` disisipkan langsung setelah `<span className='w-9 shrink-0 text-right …'>{zoom}%</span>` tanpa jarak; angka zoom bisa melebar keluar dari `w-9`. Komponen tombol ada di `packages/koharu/components/editor/Compare.tsx` (`CompareButton`). Periksa jarak (`gap`/margin) dan apakah tombol memakai margin negatif atau lebar tetap.

## Masukan 05 — Mode Compare (Slider dan Side by side) terasa kaku

- **Gelombang/fitur:** 3C – F3-19, mode **Slider**.
- **Kesan pemilik:** fungsinya berjalan, tapi terasa "kaku"; penyebab pastinya belum bisa dijelaskan. Mode Side by side dan Hold to peek terasa cukup bagus.
- **Hal yang bisa dicek (dugaan, belum diverifikasi):** garis pembagi tidak mengikuti mouse dengan mulus (update tidak per frame), area pegangan garis terlalu sempit (`w-4`) sehingga harus tepat di garis, tidak bisa menyeret dari mana saja di gambar, langkah tombol panah terlalu besar, atau tanpa transisi saat masuk mode.
- **Tambahan pemilik:** di **Side by side** ada jarak/geser antara kedua sisi (`masukan05-side-by-side-jarak.webp`). Sebagian karena posisi referensi halaman itu sudah tergeser saat uji Align (X −287,5, Y 23,1), sehingga sisi kiri ikut bergeser; namun pemilik memang merasa mode Compare "kurang sreg sejak awal" dan perlu diperbaiki.
- **Usulan cek:** perjelas batas kedua sisi (garis pemisah, label Reference/Edit tetap terlihat), sisi kiri dan kanan memakai titik acuan yang sama saat referensi tidak sejajar (atau beri tanda bahwa referensi tergeser), slider yang lebih mulus dan mudah dipegang.
- **Status:** perlu sesi diskusi singkat soal rasa pakai yang diinginkan sebelum dikirim ke sesi perbaikan.

## Masukan 06 — Pasangan referensi tidak bisa dipindah langsung ke halaman tertentu

- **Gelombang/fitur:** 3D – F3-20, dialog **Import references**, daftar pasangan.
- **Situasi:** pemilik memilih **satu** file referensi (`id_…E33P02.jpg`). Karena dipasangkan berdasarkan urutan, file itu jatuh ke halaman 1 (sampul), padahal pasangannya halaman 4.
- **Sekarang:** satu-satunya cara memindahkannya adalah menekan **No reference here** di baris 1, 2, lalu 3, sehingga referensi turun satu baris tiap klik. Bisa, tapi tidak langsung terlihat caranya dan merepotkan bila jaraknya jauh. Alternatifnya memilih semua file lalu Skip/No reference here.
- **Status:** pemilik meminta ini dijadikan revisi (drag and drop).
- **Permintaan:** cara memindahkan pasangan secara langsung, misalnya:
  - **seret** thumbnail referensi ke baris halaman tujuan; dan/atau
  - pilihan **"Pasangkan ke halaman…"** (dropdown nomor/nama halaman) di tiap referensi.
  Tombol Skip / No reference here / Pair again tetap ada.
- **Kriteria terima:** satu referensi bisa dipasangkan ke halaman mana pun dengan satu tindakan; ringkasan "N of M pages gets a reference" ikut benar; Attach + Undo tetap satu langkah.

## Masukan 07 — Skip menggeser semua pasangan sesudahnya tanpa peringatan

- **Gelombang/fitur:** 3D – F3-20, dialog **Import references**.
- **Langkah:**
  1. Project berisi 11 halaman raw (sampul, strip judul, P01–P09). Import 11 file referensi `id` dengan urutan sama → **11 of 11** terpasang pas 1:1 (`bug07-ref-sebelum-skip.png`).
  2. Klik **Skip** di baris 1 dan 2 (referensi sampul dan strip judul).
- **Yang terjadi:** kedua referensi pindah ke "Skipped", dan **semua referensi sesudahnya naik dua halaman**: halaman 1 (sampul) mendapat P01, halaman 2 mendapat P02, dst. Semua pasangan jadi salah (`bug07-ref-setelah-skip.png`).
- **Perilaku saat ini memang sesuai rancangan** (manual §6: Skip = referensi sesudahnya naik satu halaman), yang cocok untuk referensi yang punya halaman ekstra (sampul/kredit) yang tidak ada di raw. Tapi:
  - tidak ada peringatan bahwa banyak pasangan ikut bergeser;
  - tidak ada aksi untuk **melepas referensi dari satu halaman saja tanpa menggeser** yang lain (intuisi pemilik: Skip seharusnya mempertahankan posisi).
- **Usulan:**
  - tambah aksi **Lepas / Unpair** per baris: halaman ini tanpa referensi, pasangan lain tetap di tempatnya;
  - perjelas tombol yang menggeser, mis. label/tooltip "Skip (geser ke atas)" dan "Kosongkan di sini (geser ke bawah)", plus info "N pasangan bergeser" setelah diklik;
  - **pasangkan otomatis berdasarkan nama file** bila nama raw dan referensi punya bagian yang sama (mis. `…_E33P01` ↔ `…_E33P01`), sebelum jatuh ke urutan;
  - drag and drop (Masukan 06) menyelesaikan sisanya.

## Masukan 08 — MCP belum bisa melihat referensi

- **Gelombang/fitur:** 3D – F3-20, dari sisi agent (MCP).
- **Temuan:** `inspect_page` tidak menyebut apakah halaman punya referensi (bahasa, posisi). Field `reference` per elemen baru muncul setelah **Extract text from references**. `view_page` tidak menampilkan referensi (sengaja: referensi tidak ikut render).
- **Status:** sesuai PRD (bagian agent membaca referensi ditunda). Dicatat sebagai kandidat pengembangan berikut:
  - `inspect_page` menyertakan info referensi halaman (ada/tidak, bahasa, posisi penyejajaran);
  - cara agent melihat gambar referensi, mis. `view_page` dengan pilihan `source: reference` (bisa dengan `region`), supaya agent ber-vision bisa membaca teks referensi sendiri dan memeriksa hasil Extract.

---

## Masukan 09 — Panel Align reference dan toolbar canvas tidak bisa digeser atau diperkecil

- **Gelombang/fitur:** 3D – panel **Align reference** (`packages/koharu/components/editor/Tracing.tsx`); toolbar alat canvas (`packages/koharu/components/editor/ToolBar.tsx`, bawaan Koharu).
- **Masalah:** kedua panel mengambang di atas canvas dan kadang menutupi area yang sedang dikerjakan (mis. balon yang mau disejajarkan).
- **Permintaan:**
  - kedua panel bisa **digeser** (drag dari pegangan/judul) dan posisinya diingat;
  - kedua panel bisa **diperkecil/dilipat** (mis. tombol minimize jadi ikon/bar kecil), lalu dibuka lagi.
- **Reset opacity:** slider **Reference opacity** tidak punya tombol reset. Default-nya 50% (`packages/koharu/lib/store.ts:222`, `opacity ?? 0.5`) dan nilai terakhir terbawa ke halaman berikutnya. Usulan: tombol reset kecil di samping slider (kembali ke 50%), tampilkan angka persennya, dan dobel-klik slider juga me-reset.
- **Catatan:** "reset ke default" di Align reference sudah ada, yaitu tombol **Fit to page** (mengembalikan X/Y = 0 dan ukuran = ukuran halaman), lalu **Save**. Usulan kecil: beri tooltip/label yang menjelaskan bahwa ini reset ke posisi awal.

## Masukan 10 — Mode kalkir sulit dipakai di area putih

- **Gelombang/fitur:** 3D – **Align reference** (mode kalkir, opacity).
- **Masalah:** referensi ditumpuk transparan di atas raw. Di area yang sama-sama putih (pinggir halaman, gutter antar panel, balon) raw dan referensi tidak bisa dibedakan, sehingga pemilik tidak tahu mana tepi referensi, mana yang di atas/bawah, dan apakah sudah pas. Ketidakcocokan hanya terlihat di panel bergambar (`masukan10-align-putih-1.png`, `masukan10-align-putih-2.png`). Ini penting justru saat **Fit to page** tidak cukup (referensi beda potongan) dan harus disejajarkan manual.
- **Usulan (teknik umum di aplikasi grafis):**
  1. **Garis tepi referensi** selalu tampil (kotak garis putus-putus berwarna mencolok di batas gambar referensi), plus label kecil "Reference".
  2. **Mode campur "Difference"** sebagai pilihan selain opacity biasa: piksel yang sama jadi hitam, bagian yang tidak pas menyala sebagai garis terang. Putih-di-atas-putih yang pas jadi hitam, yang meleset terlihat jelas.
  3. **Mode warna (tint)**: referensi diwarnai satu warna (mis. merah/cyan) supaya selalu terbedakan dari raw.
  4. (opsional) **Kedip**: tahan satu tombol untuk bergantian raw/referensi dengan cepat, seperti Hold to peek.
- **Kriteria terima:** di halaman dengan pinggir putih, pemilik bisa melihat tepi referensi dan bisa menilai pas/tidaknya tanpa bergantung pada panel bergambar.

## Bug 11 — Referensi hilang dari mode Align saat menekan tombol toolbar/keyboard; Ctrl+drag tidak berfungsi

- **Gelombang/fitur:** 3D – **Align reference**.
- **Langkah (dari pemilik):**
  1. Buka **View → Align reference…**, referensi tampil transparan di atas raw.
  2. Tidak sengaja menekan tombol alat di toolbar (mis. **Text**) atau sebuah tombol keyboard.
- **Yang terjadi:** referensi tiba-tiba hilang dari layar (`bug05-align-tool-berganti.png`: alat Text jadi aktif). Belum dipastikan apakah panel Align ikut tertutup dan apakah geseran yang belum disimpan hilang.
- **Konfirmasi pemilik:** panel Align ikut tertutup dan geseran yang belum disimpan hilang (harus mulai dari awal).
- **Lebih parah — Undo:** menekan **Ctrl+Z** selama mode Align tidak membatalkan geseran referensi, tapi membatalkan langkah project sebelumnya, yaitu **Attach references** (satu langkah undo). Akibatnya **semua referensi hilang dari project** dan menu referensi ikut hilang, sehingga pemilik mengira harus import ulang dari menu File. Pada kejadian itu **Redo tidak mengembalikan referensi** dan pemilik harus import ulang. **Namun** di uji berikutnya, **Remove reference → Undo** mengembalikan referensi dengan benar. Jadi Undo/Redo referensi pada dasarnya bekerja; kegagalan tadi kemungkinan karena riwayat Redo sudah terhapus oleh aksi lain sesudah Undo (mis. menutup panel Align dengan Save, pindah halaman yang auto-save penyejajaran, atau import ulang). **Perlu direproduksi** dengan urutan langkah yang pasti.
- **Yang diharapkan:** selama mode Align, tombol alat dan shortcut alat tidak mengeluarkan pemilik dari mode Align tanpa sengaja (diabaikan, atau minta konfirmasi bila ada perubahan yang belum disimpan), dan geseran yang belum disimpan tidak hilang diam-diam.
- **Juga diharapkan:** selama mode Align, **Ctrl+Z / Ctrl+Shift+Z** bekerja pada geseran referensi yang sedang diatur (undo lokal), bukan pada riwayat project; atau setidaknya diblokir dengan pesan.
- **Petunjuk kode:** `packages/koharu/components/editor/CanvasWorkspace.tsx` handler `keydown` hanya mengecualikan mode Align untuk shortcut Compare (`!state.tracing`, ±baris 355); shortcut alat (`setTool`, ±baris 400–403) dan klik toolbar (`ToolBar.tsx` `setTool`) tetap jalan saat Align. Overlay/state Align ada di `packages/koharu/components/editor/Tracing.tsx` dan `lib/store.ts` (`tracing`, `stopTracing`). Periksa juga input X/Y/Width/Height: mengetik huruf di sana tidak boleh memicu shortcut.

## Masukan 12 — "Add reference…" per halaman, dan Ctrl+drag untuk zoom ke area

- **Gelombang/fitur:** 3D – Referensi dan Align reference.
- **Add reference…:** tambahkan item **Add reference…** di menu ⋯ halaman (di bawah Rename / di bagian referensi). Pemilik memilih satu file gambar, dan file itu langsung dipasang ke halaman itu saja, tanpa dialog pasangan berurutan. Bila halaman sudah punya referensi: "Replace reference…". Ini juga memudahkan kasus satu file di Masukan 06/07.
- **Ctrl+drag = zoom ke area:** saat menyejajarkan, pemilik ingin melihat detail dari dekat. Ctrl+scroll sudah bisa zoom, tetapi Ctrl+drag tidak melakukan apa pun. Usulan: **Ctrl+drag menggambar kotak, lalu tampilan zoom ke kotak itu** (marquee zoom), berlaku di canvas biasa dan di mode Align/Compare.

## Bug 13 — Extract salah memasangkan teks di balon bertumpuk

- **Gelombang/fitur:** 3D – **Process → Extract text from references** (referensi `id`, sebahasa dengan target).
- **Halaman:** raw `…E33P04` (panel kiri bawah: tiga balon Jepang bertumpuk/bersambung; referensi Indonesia punya tiga balon di posisi yang sama).
- **Sebelum** (`bug12-extract-sebelum.webp`): 6 elemen teks Jepang hasil OCR, belum ada terjemahan.
- **Sesudah** (`bug12-extract-sesudah.webp`):
  - 4 elemen terisi teks referensi (balon kakek kiri, balon kakek kanan, balon gadis kanan bawah benar);
  - balon kecil paling atas di tumpukan kiri menerima **gabungan dua teks referensi** (teks balon kedua dan ketiga digabung);
  - balon kedua dan ketiga di tumpukan itu **tetap kosong** (layer masih menampilkan teks Jepang).
- **Yang diharapkan:** tiap balon raw mendapat teks dari balon referensi di posisi yang sama; balon kecil teratas mendapat teks balon kecil teratas referensi.
- **Catatan:** manual §8 menyebut ambang pencocokan dipilih secara teori; ini contoh nyata untuk penyetelan. Kemungkinan deteksi di referensi menggabungkan balon-balon bersambung jadi satu area, lalu dipasangkan ke balon raw yang paling dulu cocok.
- **Temuan lanjutan (pemilik):** bentuk dan posisi balon di edisi referensi **memang berbeda** dari raw. Di Pepper&Carrot balon digambar per bahasa (lang-pack), sama seperti rilis terjemahan yang menggambar ulang balon. Jadi kasus ini realistis, bukan khusus sample.
- **Akibat setelah Inpainting** (`bug13-extract-setelah-inpaint.webp`): teks gabungan di balon kecil meluber jauh keluar balon dan menutupi balon di bawahnya; dua balon lain kosong.
- **Usulan:** bila satu balon raw cocok dengan lebih dari satu balon referensi (atau kecocokannya lemah), **jangan digabung**; biarkan ditandai "tidak cocok" supaya diisi lewat Read from reference…. Pertimbangkan juga mencocokkan berdasarkan urutan baca di dalam panel, bukan hanya tumpang-tindih kotak.
- **Penanganan sementara:** Read from reference… per balon.

## Masukan 14 — Penanda teks meluber di UI

- **Situasi:** setelah Extract, satu balon menerima teks yang terlalu panjang dan meluber menutupi balon lain, tetapi UI tidak memberi tanda apa pun. Peringatan "tidak muat" (F3-13) saat ini hanya dikirim ke agent lewat MCP.
- **Permintaan:** tanda di UI untuk elemen yang teksnya meluber atau mengecil di bawah ukuran terbaca, mis. garis kotak merah di canvas, ikon peringatan di panel Layers/Inspector, dan jumlahnya di notifikasi setelah Extract atau Run Translation.

## Masukan 15 — Save vs "Apply to following pages" di Align terasa sama

- **Gelombang/fitur:** 3D – panel **Align reference**.
- **Pengamatan pemilik:** setelah menggeser referensi (X −287,5, Y 23,1; `uji-align-digeser.webp`), menekan **Apply to following pages** menutup panel dan tampilan kembali normal; saat panel dibuka lagi posisinya tetap yang digeser tadi. Pemilik tidak bisa membedakan Apply dengan Save.
- **Perilaku sebenarnya (kode `Tracing.tsx`):** **Save** menyimpan posisi untuk halaman ini saja; **Apply to following pages** menyimpan posisi yang sama untuk halaman ini **dan semua halaman sesudahnya yang punya referensi**, lalu menutup panel. Notifikasi "applied to N pages" hanya muncul bila lebih dari satu halaman.
- **Usulan:** label yang menyebut cakupannya, mis. **Save (this page)** dan **Save for this and N following pages** (angka N dihitung sebelum diklik), plus notifikasi selalu muncul setelah menyimpan.

## Bug 16 — Ubah status beberapa halaman sekaligus tidak berfungsi

- **Gelombang/fitur:** 3B – F3-15, menu ⋯ halaman → Status.
- **Langkah:** pilih beberapa halaman di daftar Pages dengan **Ctrl+klik**, lalu ubah status lewat menu ⋯ salah satu halaman terpilih.
- **Yang diharapkan (manual §4):** perubahan berlaku untuk **semua** halaman terpilih, dalam satu langkah Undo.
- **Yang terjadi:** tidak berlaku untuk semua halaman terpilih (detail pasti perlu dicek: apakah Ctrl+klik memilih beberapa halaman, atau statusnya hanya berubah di satu halaman).
- **Catatan:** ubah status satu halaman dan Undo-nya berfungsi.

## Bug 17 — Agent tidak menerima hasil tool yang berjalan saat server dimatikan

- **Gelombang/fitur:** 3B – F3-1, toggle **MCP server**.
- **Langkah:** Claude Code menjalankan `run_pipeline` operation `ocr` untuk seluruh project (11 halaman); pemilik mematikan toggle MCP server beberapa detik kemudian, lalu menyalakannya lagi.
- **Yang terjadi:** panggilan di sisi klien gagal dengan `Error POSTing to endpoint: … no response message received from handler`. Belum dipastikan apakah OCR tetap selesai dan tersimpan, dan status apa yang tampil (Stopping… atau langsung Off).
- **Yang diharapkan (PRD F3-1):** tool yang sedang berjalan dibiarkan selesai, hasil tersimpan, dan **jawabannya tetap dikirim ke klien** sebelum koneksi ditutup; panggilan baru ditolak dengan pesan jelas. Kalau agent hanya menerima error, ia bisa mengira pekerjaan gagal lalu mengulanginya.
- **Petunjuk kode:** `crates/koharu-agent/src/mcp/supervisor.rs` (`stop`, ±baris 305; komentar "calls of a server that is waiting for them before it stops"), `mcp/mod.rs` `accept` (koneksi di-abort saat shutdown).

## Catatan Extract (bukan bug)

- Setelah Extract, gambar terlihat "berantakan" karena: (1) Extract **hanya mengisi teks**, teks Jepang asli belum dihapus (perlu tahap Inpainting atau `remove`); (2) screenshot diambil dalam mode **Compare Slider**, sehingga di kiri garis tampil gambar referensi (huruf Indonesia dari edisi terjemahan) bertumpuk dengan hasil edit (`bug12-extract-tampilan.webp`).

## Hasil uji UI oleh pemilik (2026-10-21)

| Tes | Hasil | Catatan |
|---|---|---|
| Compare Side by side / Hold to peek | ✅ | Terasa cukup bagus |
| Compare Slider | ⚠️ | Berfungsi, terasa kaku → Masukan 05 |
| Import references (id, 11 file) | ✅ | Pasangan otomatis pas 1:1; Skip menggeser → Masukan 06, 07 |
| Compare with → Reference (otomatis) | ✅ | Sisi kiri menampilkan referensi bahasa Indonesia di halaman berreferensi |
| Compare with → Original | ✅ | Sisi kiri kembali ke raw |
| Align reference (mode kalkir) | ✅ | Referensi ditumpuk transparan di atas raw, sesuai harapan pemilik |
| Trim margins | ⚠️ | Dengan trim, referensi P&C jadi tidak sejajar (gutter putih bergeser vertikal, `uji-trim-margins-slider.webp`). Sesuai dugaan: untuk gambar identik trim harus mati |
| Align: Save / Apply to following pages | ✅ | Posisi tersimpan dan muncul lagi saat panel dibuka; cakupan tombol membingungkan → Masukan 15 |
| Tab Glossary | ✅ | 3 istilah dari agent tampil (`uji-glossary-tab.png`); tambah `剣 → pedang` ✅; cari ✅; istilah ganda ditolak "This term is already in the glossary." ✅ (`uji-glossary-duplikat.png`); hapus lalu Undo ✅. Edit belum dicek |
| Persistensi project | ✅ | Tutup lalu buka project: glosarium **dan referensi** tetap ada |
| MCP server dimatikan saat agent bekerja | ⚠️ | Server bisa dimatikan dan dinyalakan lagi; panggilan yang berjalan berakhir error di klien → Bug 17 |
| Status halaman (satu halaman) | ✅ | Ubah dari menu ⋯ dan Undo berfungsi |
| Status halaman (beberapa halaman, Ctrl+klik) | ❌ | → Bug 16 |
| Clear project → Undo | ✅ | Dialog jelas (`uji-clear-project-dialog.png`); semua halaman kembali |
| Clear project + Also free up disk space | ✅ | Notifikasi "Freed 29.1 MB" (`uji-free-disk-freed.webp`); Undo tidak bisa (sengaja). Saat Undo ditekan muncul toast merah "Could not complete that action — nothing to undo" (`uji-clear-disk-undo.webp`); usulan kecil: tombol/menu Undo dinonaktifkan saja, bukan pesan error |
| Undo `set_translations` | ✅ | Lihat tabel MCP |
| Extract text from references (id) | ⚠️ | Teks masuk ke translation; 2 dari 6 balon salah pasang → Bug 13 |
| Undo/Redo Extract | ✅ | Satu Undo membatalkan seluruh hasil Extract sekaligus, satu Redo mengembalikannya |
| Undo/Redo setelah referensi hilang (dari mode Align) | ❌ | Tidak bisa dipulihkan → Bug 11, perlu reproduksi |
| Remove reference → Undo | ✅ | Referensi kembali (setelah Extract) |
| Referensi tidak ikut export | ✅ | MCP `export` PNG halaman 5 (`…E33P03`, ber-referensi `id`): hasil hanya raw Jepang, tanpa gambar referensi (`sample\output\from-mcp\…_2222`) |

## Sisa uji (belum dicoba, per 2026-10-21)

Persiapan: pastikan referensi masih terpasang (badge **Reference** di daftar halaman). Kalau hilang karena Undo (Bug 11), coba **Edit → Redo** dulu; kalau tidak kembali, import ulang `sample\id\` (11 file).

1. [ ] ⭐ **Process → Extract text from references**: notifikasi jumlah terisi/tidak cocok; kolom Reference (…) di Inspector; teks referensi `id` masuk ke translation; terjemahan agent di halaman 4 **tidak ditimpa**; Undo sekali membatalkan semua hasil Extract.
2. [ ] ⭐ **Read from reference…** untuk satu balon yang tidak terisi.
3. [ ] **Align**: Save, Cancel, Apply to following pages; Undo membatalkan penyejajaran yang sudah di-Save (jangan tekan Undo saat panel Align masih terbuka, lihat Bug 11).
4. [ ] **Remove reference** dari menu ⋯ halaman.
5. [ ] **Export Project**: referensi tidak ikut.
6. [ ] (opsional) Referensi `en` untuk satu halaman → Extract → teks masuk ke **Reference**, bukan translation.
7. [ ] **Tab Glossary**: 3 istilah dari agent tampil; tambah/edit/hapus/cari; istilah ganda ditolak; Undo; tetap ada setelah project ditutup-buka.
8. [ ] **Status halaman** dari menu ⋯: satu halaman, beberapa halaman sekaligus, Undo.
9. [ ] **Server MCP dimatikan saat agent bekerja** (bersama Claude): Stopping… (waiting for N tasks) → Off → nyala lagi, klien tersambung tanpa ubah config.
10. [ ] **Hermes**: satu halaman dengan alur baru.
11. [ ] **Kompatibilitas**: salinan project tes dibuka di Koharu resmi; salinan project lama dibuka di build exp.
12. [ ] Terakhir: **Clear project** → Undo; **Free up disk space**.

## Backlog: dibahas nanti (belum dibutuhkan)

- **MCP untuk Referensi:** agent bisa tahu halaman punya referensi dan melihat gambarnya (lihat Masukan 08); termasuk kemungkinan agent menjalankan Extract / Read from reference.
- **MCP untuk Compare:** agent bisa memakai pembanding (raw/referensi vs hasil edit) untuk memeriksa hasilnya sendiri.
- Ditetapkan pemilik 2026-10-21: dicatat saja, didiskusikan kapan-kapan, tidak masuk perbaikan pasca-uji.
- **Mode pengembang "Full UI access" (daftar keinginan, belum prioritas; ditetapkan pemilik 2026-10-21):**
  - Tujuan: agent bisa mengendalikan UI Koharu (klik, menu, isi field, baca panel) untuk menguji UI tanpa computer use. Computer use di laptop pemilik gagal menangkap layar (hasil selalu abu-abu rata).
  - Dasar: CEF remote debugging sudah ada, tapi hanya di build debug (`crates/koharu-app/src/app.rs:72`, `#[cfg(debug_assertions)]`, port 4000), dipakai developer Koharu dengan `chrome-devtools-mcp` (lihat `AGENTS.md`).
  - Bentuk: pengaturan di config, **mati secara default**, kartu peringatan khusus di Settings; berlaku setelah restart (opsi CEF dibaca saat start); hanya `127.0.0.1`; plus catatan cara mendaftarkan `chrome-devtools-mcp` ke klien.
  - **Risiko:** jalur DevTools tidak bertoken dan melewati semua pembatasan MCP (token, profil, centang per tool, Activity); program lokal apa pun bisa mengendalikan Koharu selama aktif. Pakai sementara saja.
  - Keterbatasan: canvas WebGPU kadang tidak tertangkap lewat DevTools; untuk hasil render tetap pakai `view_page`.
