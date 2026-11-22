# GERBANG ELIGIBILITY KIROWEEN — Aruna Core (dibuat 23 Nov 2026)

Sumber: full Official Rules Kiroween 2026 (kiroween.devpost.com/rules, 621 baris, dibaca penuh Elsa 23 Nov 2026 06:37 WITA, versi updated 16 Nov 2026).
Tujuan: tidak ada aplikasi selesai yang gugur karena syarat teknis. Checklist ini ditempel ke Checkpoint 11 dan Checkpoint 15 — keduanya TIDAK BOLEH dinyatakan PASS sebelum semua baris di bagian yang relevan berstatus PASS terverifikasi dari clone segar + URL live (bukan dari laporan Kiro saja).

## A. Sudah PASS — terverifikasi 23 Nov 2026 (jaga, jangan sampai regresi)
- [x] Peserta eligible: Indonesia tidak di daftar larangan §3; masuk individu/founder.
- [x] Proyek baru dibangun di dalam Submission Period 30 Okt–4 Des 2026 (spec 18 Nov, repo 19 Nov, nol kode lama disalin).
- [x] Repo GitHub PUBLIK github.com/dear-aseif/aruna-core + LICENSE MIT terdeteksi.
- [x] `/.kiro` di ROOT repo, ter-commit 10 file (specs + hooks 2 + steering), TIDAK di-.gitignore.
- [x] Kategori dikunci: Skeleton Crew. Bonus diklaim: Best Startup Project.

## B. MERAH — harus ditutup SEBELUM Grup 12 mulai (keputusan 23 Nov)
- [ ] B1. Struktur 2 aplikasi: rule §4 Skeleton Crew — "repo must contain 2 separate repo folders for the 2 separate applications".
      Kondisi sekarang: 1 aplikasi Next.js + `playbooks/denana.json` + `playbooks/toko-seragam.json`.
      KEPUTUSAN YANG DIBUTUHKAN DEVINA: struktur folder aplikasi per pack disiapkan di awal Grup 12/13
      (kode pack lahir langsung di folder aplikasinya masing-masing, berbagi core — bukan dipindah di akhir).
      Bukti PASS: dari clone segar, juri yang membuka repo langsung melihat Core + folder App 1 + folder App 2,
      dan README root memetakan ketiganya dalam 1 layar.
- [ ] B2. Grup 12 (Retail) + Grup 13 (Services) adalah BUKTI Skeleton Crew — tanpa keduanya, klaim kategori kosong.
      Jaga tanggal: pack mulai paling lambat 27 Nov (peta S3). Grup 9 TIDAK boleh memakan jendela pack;
      bila Grup 9 molor melewati 26 Nov, yang dipotong adalah polish UI, bukan pack.

## C. Wajib masuk Checkpoint 11 (core complete) — deploy DINI
- [ ] C1. Deploy smoke core ke Lightsail + HTTPS berhasil dari Grup 14.1 yang ditarik maju (deploy dua kali: core di 11, final di 14).
- [ ] C2. URL live bisa dibuka dari HP; kredensial evaluator disiapkan (hanya di form Devpost, TIDAK di repo — task 14.3).
- [ ] C3. Cron live terverifikasi di instance (expiry sweep + routine engine bila sudah ada).
- [ ] C4. Folder B1 sudah terbentuk strukturnya (kosong/scaffold boleh, asal pola folder aplikasi terkunci).

## D. Wajib terkumpul PARALEL mulai 23 Nov (bukan menumpuk di S4)
- [ ] D1. Draf form Devpost dibuat SEKARANG (kategori, bonus Startup: konfirmasi founder + LinkedIn + website pahamai.com).
- [ ] D2. Teks disclosure karya pra-periode ditulis: blueprint Aruna 9 Okt 2026 + WA Follow-up Agent (live 27 Okt 2026)
      = bahan requirements saja, nol kode disalin, semua kode submission dibangun 18 Nov–4 Des 2026.
- [ ] D3. Log write-up Kiro diisi PER GRUP (bukan direkonstruksi 2 Des): specs, steering, hooks (2 hook aktif),
      custom agents bila ada, MCP, PBT (Property 1–10 di tasks.md), powers bila dipakai.
      KOREKSI double-check 23 Nov: jembatan Talk-to-Figma Grup 9 digerakkan OpenCode, BUKAN Kiro — ia masuk
      write-up sebagai transparansi alat desain (preseden Wonder.design), TIDAK BOLEH diklaim sebagai pemakaian
      MCP oleh Kiro. Klaim MCP/custom agent/powers hanya bila Kiro benar-benar memakainya; bila tidak dipakai,
      tulis apa adanya — write-up yang jujur mengalahkan klaim kosong yang bisa diaudit dari `/.kiro`.
- [ ] D4. Storyboard video = smoke path task 14.4 persis (2 aplikasi, end-to-end, <3 menit, EN, YouTube publik).
- [ ] D5. (Opsional, murah) Blog post publik menyebut Kiroween 2026 + post sosial diawali #KiroweenHackathon26 — dikerjakan hanya bila D1–D4 aman.
- [ ] D6. Kepatuhan pihak ketiga (§4 Third Party Integrations + Intellectual Property): semua SDK/API/data pihak ketiga
      yang dipakai (Bedrock, Next.js, pustaka OSS) harus sah dipakai menurut lisensinya; tidak ada kode GPL disalin
      ke repo MIT (aturan Bank Usaha); tidak ada aset/trademark pihak ketiga di demo/video tanpa izin.

## E. Wajib masuk Checkpoint 15 (final) — audit eligibility penuh oleh Elsa dari clone segar
- [ ] E1. `/.kiro` masih lengkap di root + tidak ter-gitignore sesudah semua grup selesai.
- [ ] E2. README runbook terbukti: clone segar + langkah terdokumentasi = demo jalan (task 14.3, dijalankan beneran).
- [ ] E3. Kedua aplikasi jalan end-to-end dari deployment LIVE (task 15.1) — bukan lokal.
- [ ] E4. Video <3 menit publik di YouTube, tanpa musik/trademark pihak ketiga tanpa izin.
- [ ] E5. Semua materi submission berbahasa Inggris (atau terjemahan EN tersedia).
- [ ] E6. Rencana hidup demo: instance + DB Lightsail TIDAK dimatikan sampai Judging Period berakhir 29 Jan 2027;
      biaya berjalan dicatat (DB $15/bln dari pool Activate) + cek hidup di awal Januari 2027.
- [ ] E7. Teks submission final cocok dengan isi D1+D2+D3; tidak ada klaim melebihi yang didemokan.
- [ ] E8. Repo final memenuhi bunyi harfiah §4: berisi SEMUA source code + aset + instruksi agar proyek fungsional,
      lisensi tampil terdeteksi di bagian About GitHub, dan deskripsi submission memuat fitur/fungsi + kasus
      dampak untuk audiens nyata (Denana + Toko Seragam) — peta bukti per 5 kriteria penjurian §6 dibuat 1 halaman:
      Potential Impact / Technological Implementation / Design / Innovation / Presentation, masing-masing menunjuk bukti konkret.
- [ ] E9. Beku sesudah deadline (§5): sesudah Submission Period berakhir (4 Des 14:00 PT) submission TIDAK diubah;
      target internal submit 3 Des WITA di RENCANA-TAHAP adalah garis amannya — semua koreksi harus selesai sebelum itu.

## F. Risiko residual — diterima sadar, bukan ditutup
- F1. Financial/preferential support dari Sponsor (AWS): kredit Kiroween 4.000 = allotment resmi rules (aman).
      Infra di pool AWS Activate = area abu-abu rule §4. Perlakuan: jangan jadikan Activate sebagai klaim
      pendanaan proyek di submission; catat sebagai risiko residual yang diterima devina, bukan dinyatakan PASS.
- F2. Regional Restrictions §4: model/fitur yang tak tersedia di region peserta = tanggung jawab peserta.
      Mitigasi: model Bedrock Aruna sudah terverifikasi hidup di akun devina (ap-southeast-1/us-east-1). Risiko rendah.
