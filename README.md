# Modal $30 — starter kit

**Kenapa file ini ada:** kamu dapet $30 kredit compute GRATIS tiap bulan di Modal.
Aturannya: **hangus tiap akhir bulan, nggak bisa ditabung.** Kredit Oktober hangus
31 Okt. Daripada hangus cuma karena nggak dicoba, ini paket siap jalan 3 perintah.

## Yang $30 bisa beli (rate card resmi Modal, dicek 19 Okt 2026)

| Resource | Tarif/jam | $30 = kira-kira |
|---|---|---|
| CPU | $0.047/core-jam | 638 jam (1 core) |
| GPU T4 | $0.59/jam | ±50 jam |
| GPU L4 | $0.80/jam | ±37 jam |
| GPU A10 | $1.10/jam | ±27 jam |
| GPU H100 | $3.95/jam | ±7.5 jam |
| Memori | $0.008/GiB-jam | (nempel di atas tarif CPU/GPU) |

Konteks: script `modal_starter.py` di folder ini jalan ±2 menit di CPU = **±$0.003**.
Satu eksperimen kecil GPU T4 10 menit = ±$0.10. Jadi $30 itu gede banget buat
ukuran eksperimen — yang bikin jebol cuma satu (baca jebakan di bawah).

Sumber angka: halaman pricing resmi Modal (modal.com/pricing) + teardown
independen. Tarif bisa berubah — cek halaman resminya sebelum budgeting serius.

## 3 perintah buat jalanin eksperimen pertama

```bash
pip install modal
modal setup          # buka browser, link akunmu
modal run modal_starter.py --query "berapa biaya AI untuk toko kecil"
```

Yang terjadi: Modal bangun container, download model embedding open-source
(~90MB, sekali aja), embed 10 hook Threads punyamu sendiri, lalu ranking mana
yang paling nyambung sama query-mu. Itu **langkah "R" dari RAG** (retrieval) —
item "next" di roadmap skill-mu. Hasilnya muncul di terminal; biaya + log-nya
bisa dilihat di dashboard Modal → app `devina-modal-starter`.

## Satu jebakan yang wajib tahu

**Jangan biarkan container "warm" nganggur.** Modal nagih per detik *selama
container nyala* — kalau kamu set container biar standby terus (keep-warm /
scaledown window lama), meterannya jalan walau nggak ada yang dipakai. Ini
satu-satunya cara tagihan Modal meledak. Default-nya scale-to-zero (mati pas
nggak dipakai) — itu yang bener buat eksperimen. Script ini pakai default.

## Habis ini, 4 eksperimen lanjutan (naik level)

1. **Rasa GPU:** tambah `gpu="T4"` di decorator `@app.function` — kode sama
   persis, jalan di GPU beneran, tagihan per detik $0.59/jam.
2. **Scheduled job:** `@app.function(schedule=modal.Cron("0 7 * * *"))` = fungsi
   Python yang jalan otomatis tiap jam 7 pagi. Calon potongan "follow-up
   otomatis" versi Python (n8n tetap buat orkestrasi WA-nya).
3. **RAG beneran:** sambungin retrieval ini ke LLM — pakai $5 xAI pilot-mu atau
   tier Contributor Meta ($0.10/1M token, buat data dummy). Retrieve → generate.
4. **Webhook:** `@app.function()` + `modal.web_endpoint` = URL publik buat
   fungsi Python-mu. Berguna kalau suatu gig butuh "API kecil" tanpa sewa server.

## Kaitannya sama minggu ini

- **Roadmap skill:** ini latihan RAG termurah yang ada — GPU + infra gratis.
- **Margin:** workload kecil klien (script harian, bot ringan) di Modal biayanya
  nyaris nol di dalam $30 gratisan → margin gig makin tebel.
- **Bukan pengganti n8n:** prototipe WA hari ini tetap n8n (Node.js). Modal =
  potongan Python-nya (logic AI, scheduled job, eksperimen).

Satu aturan main Modal: **kredit $30 dipotong duluan** sebelum mereka nagih uang
beneran, dan workspace-mu juga punya plafon pemakaian (punyamu $42.50/bln).
Selama di bawah itu, spend = $0.
