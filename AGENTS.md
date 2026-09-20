# AGENTS.md — war-service

Panduan untuk agent/AI yang bekerja di repo ini. Baca sampai habis sebelum
mengubah kode. war-service **menggabungkan** dua otomatisasi yang sudah terbukti:
`siak-war` (Playwright, portal SIAK NG) dan `slcm` (API murni, portal SLCM).
Banyak keputusan di sini lahir dari perilaku aneh kedua portal — bukan
preferensi gaya. Kalau ragu, cek `../siak-war/AGENTS.md` dan `../slcm/AGENTS.md`.

## Apa ini

Service yang menjalankan **war IRS** untuk SIAK **dan** SLCM di balik satu
antarmuka seragam. Dua goal:

- **G1 — cek jadwal** (`goal: CHECK_SCHEDULE`)
- **G2 — isi IRS** (`goal: FILL_IRS`): login → poll → fill → check

**war-service adalah backend utamanya** — bukan service terpisah di belakang
gateway lain. Frontend/klien memanggil API-nya langsung. Eksekusi war berjalan di
**worker** (BullMQ), bukan di request HTTP — jadi war banyak akun bisa jalan
paralel, request HTTP tidak nge-block, dan status tetap konsisten meski proses
restart.

## Tech stack

| Lapisan        | Teknologi                    | Alasan                                                 |
| -------------- | ---------------------------- | ------------------------------------------------------ |
| API            | Fastify + Zod                | validasi ketat, cepat, dipanggil frontend/klien        |
| Queue/worker   | BullMQ + Redis               | war long-running & time-sensitive, skala horizontal    |
| State durable  | PostgreSQL + Prisma          | konsistensi status/hasil, audit event                  |
| Browser (SIAK) | Playwright (chromium)        | SIAK server-rendered + CAPTCHA                         |
| HTTP (SLCM)    | native `fetch`               | SLCM API JSON, tanpa browser                           |
| Logging        | pino                         | terstruktur, per-job/akun                              |
| Auth user      | better-auth + adapter Prisma | email+password & sesi cookie, tabel dikelola Prisma    |
| Pembayaran     | QRIS statis→dinamis (lokal)  | tanpa payment gateway; verifikasi manual via kode unik |

## Perintah

```bash
pnpm install
pnpm install:browsers      # playwright install chromium (wajib sekali di awal)
docker compose up -d postgres redis
pnpm db:migrate            # buat skema DB (dev)
pnpm db:reset              # hapus data, apply ulang migrasi, lalu seed (dev)
pnpm db:generate           # regen client setelah ubah schema.prisma

pnpm dev                   # ROLE=all — API + worker satu proses (dev)
pnpm api                   # hanya API
pnpm worker                # hanya worker
pnpm catalog:sync          # sync katalog langsung dari terminal
pnpm sync:new              # admin: perbarui jadwal SLCM semua akun SSO terverifikasi
pnpm sso:audit             # admin: cek login SSO + pilihan jadwal + setup war semua akun
pnpm typecheck             # tsc --noEmit
pnpm build                 # compile ke dist/
pnpm run ci                # generate Prisma + typecheck + build — wajib sebelum handoff
```

`pnpm sync:new` juga berfungsi sebagai migrasi classId: duplikat logis dengan
`courseCode + courseName + className` sama dipadatkan ke payload terbaru,
`isChoosed` dan Plan/War `SCHEDULED` diarahkan ke classId pengganti, lalu baris
jadwal/katalog lama dihapus. Pencocokan ini tidak pernah dilakukan saat ganti
portal SIAK ↔ SLCM.

`catalog:sync` dapat memakai akun database seperti biasa, atau credential
langsung dengan `--username` + `--password`. Untuk mencegah sandi masuk shell
history, utamakan `CATALOG_SSO_USERNAME` dan `CATALOG_SSO_PASSWORD`. Credential
langsung hanya hidup di memori selama proses dan tidak disimpan sebagai SsoUi.
CLI menerima separator argumen pnpm, misalnya
`pnpm catalog:sync -- --username <sso> --password <sandi>`. Periode tidak dapat
di-override: CLI, API admin, endpoint user, dan kontribusi jadwal SLCM semuanya
harus memakai satu baris `Period.isActive`.

**Tidak ada test suite & tidak ada linter.** Completion gate-nya adalah
`pnpm run ci`, dan harus selalu hijau sebelum selesai. Perintah itu menjalankan
`db:generate`, typecheck, lalu production build. `.github/workflows/ci.yml`
menjalankan gate yang sama untuk setiap push dan pull request di semua branch,
dengan frozen lockfile dan validasi peer dependency yang strict.

## Peta arsitektur (di mana harus menyentuh apa)

```
src/
  domain/            ← KONTRAK. Ubah di sini = ubah semua provider.
    provider.ts        AcademicProvider (interface tunggal SIAK & SLCM)
    models.ts          bentuk ternormalisasi (ScheduleEntry, IrsResult, ...)
    events.ts          WarEventType — taksonomi log per-langkah
  providers/
    provider-factory.ts  'SIAK'|'SLCM' → implementasi
    siak/              ← port dari ../siak-war (browser, CAPTCHA, guard)
    slcm/              ← port dari ../slcm (OIDC+PKCE, endpoint JSON)
  war/
    war-runner.ts      ← orkestrasi provider-agnostic (login→[wait]→poll→fill→check)
    scheduling.ts      ← dispatch tepat scheduledAt + gate runtime job lama
  catalog/
    slcm-catalog.ts       ← pembaca endpoint organisasi & class/whole (fakultas→prodi→kelas)
    catalog-sync.ts       ← penarikan katalog oleh admin (idempoten, gagal-sebagian aman)
    catalog-contribution.ts ← cek jadwal user SLCM ikut mengisi katalog (tak pernah menghapus)
    catalog-service.ts    ← pencarian + salin katalog jadi Schedule akun
    faculty-lookup.ts     ← org_code → fakultas/prodi (dari katalog, bukan tabel hard-code)
  queue/               ← BullMQ: queue war (delayed job) + queue catalog, pub/sub cancel
  auth/
    auth.ts            ← instance better-auth (email+password, field phoneNumber)
    session.ts         ← requireUser / requireAdmin (preHandler Fastify)
    phone.ts           ← normalisasi nomor ke +62
  payment/
    qris/              ← port verssache/qris-dinamis: parser, converter, crc16
    pricing.ts         ← SATU-SATUNYA aturan harga (promo > harga asli)
    payment-service.ts ← tagihan, kode unik, verifikasi manual
    entitlement.ts     ← requirePaidAccess (gating fitur berbayar)
  api/                 ← Fastify server + routes (auth, period, payment, account, war, schedule, catalog)
  observability/       ← emitter: WarEvent → DB + pino
  persistence/prisma.ts
  config/env.ts        ← semua env divalidasi Zod di sini
  shared/              ← logger, errors, utils, http (timeout+retry), time (WIB)
```

### Aturan emas: war runner TIDAK boleh tahu provider mana

`WarRunner` hanya bicara ke `AcademicProvider`. Semua perbedaan SIAK vs SLCM
disembunyikan di balik interface. Kalau menambah portal baru (mis. kampus lain):

1. Buat folder `providers/<nama>/`, implementasikan `AcademicProvider`.
2. Tambah satu cabang di `provider-factory.ts`.
3. Tambah nilai enum `Provider` di `schema.prisma` + `providerSchema` di
   `api/schemas.ts`.
4. **Jangan** menyentuh `war-runner.ts` atau `war-worker.ts`.

## Kontrak `AcademicProvider` (jantung desain)

Siklus hidup wajib: `login()` → operasi → `dispose()` (selalu di `finally`,
sudah dijamin `WarRunner`). `ProviderSession` sengaja `unknown` — SIAK
menyimpannya sebagai BrowserContext+page objects, SLCM sebagai token bundle.
Runner tak boleh mengintip isinya.

Method: `login`, `checkSchedule`, `pollUntilOpen`, `fillIrs`, `checkResult`,
`dispose`. Semantik detail ada di JSDoc `src/domain/provider.ts` — baca sebelum
mengubah signature.

### Kontrak error (menentukan retry/status akhir)

Lempar tipe dari `src/shared/errors.ts`, jangan `Error` generik di jalur
bermakna:

| Error                  | Arti                                 | Efek                            |
| ---------------------- | ------------------------------------ | ------------------------------- |
| `RecoverablePageError` | insiden sementara (request rejected) | polling `continue`              |
| `UnexpectedPageError`  | halaman tak dikenali                 | polling `continue` (terbatas)   |
| `AuthenticationError`  | kredensial salah                     | **JANGAN retry**, status FAILED |
| `IrsWindowClosedError` | periode belum/sudah tutup            | kondisi valid, bukan bug        |
| `CourseNotFoundError`  | tidak ada target yang aman dikirim   | **JANGAN retry**, status FAILED |

### War TIDAK boleh dijalankan ulang otomatis

`attempts: 1` (queues.ts) **dan** `maxStalledCount: 0` (war-worker.ts) harus
tetap begitu. War tidak idempoten: mengulang `FILL_IRS` berarti berpotensi
submit IRS dua kali. `maxStalledCount` default BullMQ adalah 1, artinya job yang
"stalled" — lock tidak diperbarui karena proses worker mati/di-kill — akan
**dieksekusi ulang**, dan itu terbukti terjadi (kolom `WarJob.attempts` naik
jadi 2 saat dev server di-restart di tengah war). Dengan 0, job stalled langsung
gagal, tidak diulang.

Konsekuensinya kegagalan bisa terjadi **di luar `processJob`**, sehingga
`handleError` tidak jalan dan baris WarJob nyangkut di RUNNING. Itu ditangani
`reconcileFailure` di listener `worker.on("failed")`: menurunkan status ke
FAILED + menulis `WarEvent`, tapi **hanya bila belum terminal** (jangan menimpa
SUBMITTED/CANCELLED yang sudah ditulis `processJob`).

## Trace jaringan SLCM (log operator)

Selain event per-langkah, SETIAP request/respons SLCM dicatat penuh ke pino:
endpoint, method, header, payload, status, body, durasi. Berlaku untuk **kedua**
jalur — HTTP (`httpFetch`) maupun browser (Playwright) — termasuk login SSO.
**SIAK tidak ikut**: `httpFetch` memang hanya dipakai modul SLCM, dan listener
browser hanya dipasang pada BrowserContext SLCM.

- Sumbernya `shared/network-trace.ts`; penyensoran ada di `shared/redact.ts`
  supaya jalur HTTP dan browser tak mungkin punya aturan berbeda.
- Tiap percobaan punya `traceId` untuk memasangkan baris `request` ↔ `response`
  ↔ `failed`. `jobId`, `account`, dan `step` menempel lewat `AsyncLocalStorage`
  (`withNetworkTrace`, dipasang di tiap metode `SlcmProvider`) — tanpa itu log
  delapan war paralel tak bisa dipisahkan. Listener Playwright berjalan di luar
  jangkauan ALS, jadi jalur browser mengoper konteksnya secara eksplisit.
- Request `/akademik/api/**` dicatat di handler `context.route`, BUKAN di
  listener umum: hanya di sanalah header final terlihat, termasuk
  `x-captcha-token` hasil tukar token.
- Trace TIDAK masuk `WarEvent`. Event itu dibaca mahasiswa di layar, dan
  memasukkan header HTTP ke sana akan membanjiri DB tiap war.
- Rahasia (token, cookie, password, api-key) diganti `[REDACTED n chars]` —
  panjangnya dipertahankan karena itu yang biasanya dibutuhkan saat debug
  ("token-nya kosong atau ada?"). Body HTML tidak dicetak.

| Env | Default | Guna |
| --- | --- | --- |
| `SLCM_TRACE_HTTP` | `true` | trace jalur HTTP |
| `SLCM_TRACE_BROWSER` | `true` | trace jalur browser |
| `SLCM_TRACE_BODY_MAX_CHARS` | `4000` | batas potongan body per baris |
| `SLCM_TRACE_BROWSER_STATIC` | `false` | ikut mencatat aset statik (160+ request per buka SPA) |
| `SLCM_TRACE_UNREDACTED` | `false` | **BAHAYA** — cetak header & body apa adanya, termasuk password SSO dan cookie Keycloak |

`SLCM_TRACE_UNREDACTED` hanya untuk debug sesaat di mesin sendiri. Menyalakannya
di produksi berarti kredensial mahasiswa tertulis di log yang bisa dikirim ke
mana-mana.

## Logging per-langkah (requirement inti)

Setiap kejadian penting **wajib** `ctx.emit({ type, level, message, data })`.
Ini yang memenuhi requirement "logger detail di tiap proses, termasuk apakah ada
CAPTCHA". Emitter (`observability/event-logger.ts`) menulis ke tabel `WarEvent`
**dan** pino sekaligus. Frontend/klien membacanya via `GET /wars/:id/events`.

- Jangan pakai `console.log`. Jangan log kredensial/token.
- Tambah tipe baru di `WarEventType` (`domain/events.ts`) sebelum memakainya.
- CAPTCHA SIAK: `CAPTCHA_DETECTED` → `CAPTCHA_SOLVED`/`CAPTCHA_FAILED`
  (lihat `providers/siak/captcha-solver.ts`).

## Konkurensi & isolasi (multi-akun paralel, jumlah dinamis)

- Satu **job BullMQ = satu war satu akun**.
- **Konkurensi worker DINAMIS** (`queue/autotune.ts` +
  `queue/dynamic-worker-fleet.ts`): jumlah war tidak di-hardcode. Worker dasar
  start di `WORKER_MIN_CONCURRENCY`; autotuner membuat **burst lane** baru
  mengikuti jumlah job yang akan dispatch, dibatasi `WORKER_MAX_CONCURRENCY`,
  lalu menutup lane saat kembali idle. Jangan ganti ini dengan setter
  `worker.concurrency` pada worker yang sedang penuh: main loop BullMQ tidak
  bangun sampai salah satu job panjang selesai, sehingga burst dapat mentok di
  concurrency awal. **Jangan** kembalikan ke concurrency statik.
- **SIAK** dibatasi terpisah oleh **semaphore `SIAK_MAX_BROWSER_CONTEXTS`** di
  `browser-manager.ts` (browser mahal). `acquireContext()` memberi `{ context,
release }`; `release` WAJIB dipanggil di `dispose` (dan di jalur error `login`)
  — kalau tidak, permit bocor dan war SIAK berikutnya menggantung selamanya.
  Satu Chromium per worker, tiap job dapat **BrowserContext terisolasi**.
- **SLCM** (HTTP murah) tidak dibatasi semaphore — boleh burst besar; tiap job
  punya `SlcmSession` sendiri (token + xAppToken, auto-refresh). Egress default
  tetap WARP. Jika WARP timeout/gagal transport atau SLCM membalas tepat
  `403 {message:"Access denied"}`, request GET diulang melalui Decodo dengan
  token dan xAppToken dari sesi yang sama serta sticky IP per job. Login melalui
  Decodo hanya diulang bila kegagalan WARP terjadi sebelum sesi pertama siap.
  Jika `DECODO_PROXY_PORTS` diisi, hash `jobId` memilih satu
  sticky port secara deterministik; username tidak dimodifikasi. Tanpa port
  pool, username mendapat parameter `session` + `sessionduration`. `401`,
  `429`, respons bisnis, dan 5xx tidak membuka
  failover. Balasan autentikasi `401/403` biasa tetap memicu refresh/login ulang.
  HTTP client tidak memindahkan egress lalu mengulang POST secara langsung;
  gangguan koneksi POST dieskalasi ke lifecycle recovery agar sesi lama dibuang.
  `403 Access denied` baru dihitung ke circuit jika request pembanding
  melalui Decodo berhasil; bila Decodo memberi 403 yang sama, itu dianggap
  pembatasan endpoint/akun dan circuit WARP tetap tertutup. Circuit breaker
  worker mengarahkan job baru ke Decodo sementara WARP cooldown. Tidak ada
  shared mutable state selain circuit lokal proses. Yang
  diserialkan hanya critical section penulisan katalog
  bersama melalui `catalog-write-gate.ts`; login, fetch, simpan jadwal akun, dan
  war tetap paralel. Kontribusi katalog memakai `deleteMany` + `createMany`
  batch, bukan ratusan `upsert` berurutan di dalam satu transaksi.
- **Mode browser-submit SLCM ikut aturan egress yang sama.** Dulu Chromium
  selalu dipaksa lewat Decodo; sekarang `slcm-browser.ts` mencoba WARP dulu
  (`SLCM_PROXY_URL`) dan turun ke Decodo bila WARP tak menjangkau SLCM. Sebelum
  Chromium di-launch ada probe murah (satu GET `slcm.ui.ac.id`, batas 4 dtk)
  lewat proxy yang persis sama — supaya kegagalan WARP tak dibayar dengan
  launch browser + navigasi SPA yang mentok. Circuit breaker-nya TERPISAH dari
  milik flow HTTP dan berambang **1**: satu alur browser gagal (SPA tak sempat
  terbaca) langsung membuang jalur WARP selama cooldown, karena satu percobaan
  browser jauh lebih mahal daripada satu request HTTP. Yang terjadi SESUDAH
  halaman IRS terbaca (IRS belum dibuka, sesi ditolak) bukan salah egress dan
  tidak dihitung. Warm cache ikut jalur yang sama tetapi `observeOnly` — tak
  mengklaim slot probe dan tak mencatat kegagalan. `SLCM_EGRESS_DEFAULT=DECODO`
  tetap mematikan seluruh percobaan WARP, HTTP maupun browser.
- **Mode browser MEMILIH kelas, tidak sekadar menekan submit.** Sampai 17 Agu
  2026 ia hanya menekan "Kirim Pengajuan IRS" atas draf yang ada, sehingga plan
  A/B/C, remap kode kelas, dan deteksi kelas penuh tidak berpengaruh sama sekali
  — dan trail war tetap melaporkan daftar plan seolah terkirim. Sekarang
  keputusan isi IRS dipusatkan di `irs-plan.ts` (`decideIrsPlan` +
  `emitIrsPlanDecision`) dan dipakai KEDUA mode, jadi keduanya tak mungkin
  memilih kelas berbeda. Di browser, keputusan itu diterapkan dengan mencentang
  baris tabel: penalarannya murni di `irs-row-match.ts` (teruji tanpa browser),
  kode dalam halaman hanya membaca baris dan mengklik. Aturan yang tak boleh
  dilanggar: **baris yang keadaannya sudah benar tidak pernah diklik** (klik itu
  toggle → mencentang yang sudah tercentang justru melepasnya), dan satu-satunya
  centang yang boleh dilepas adalah kelas bawaan yang mata kuliahnya digantikan
  plan — sama persis dengan yang dijatuhkan jalur HTTP saat menyusun payload.
  Sumber datanya respons `offered-classes` milik SPA sendiri (ditangkap di
  interception), bukan fetch HTTP tambahan. Bila tak satu pun kelas target
  berhasil dicentang, lempar `IrsWindowNotOpenError` — submit yang "berhasil"
  tanpa kelas war adalah kegagalan diam-diam. Begitu juga bila tombol submit
  tetap tidak aktif sesudah pencentangan (kemungkinan besar total SKS lewat
  batas): jangan diklik, lempar `IrsWindowNotOpenError` dengan angka SKS-nya —
  mengklik tombol mati hanya menghasilkan timeout Playwright yang tak dikenali
  runner. Yang dilaporkan sebagai kelas
  terkirim adalah isi payload `POST /course-plan` yang benar-benar dikirim SPA,
  bukan daftar plan.
- **Dua biaya tetap mode browser dipindahkan ke luar jam war.** Diukur dari
  trace produksi 17 Agu 2026 (jam war → `POST /course-plan` = 28,2 dtk): (a)
  ekstensi CapSolver **tidur 5 detik sebelum polling pertama**
  (`pollingInterval:5`, dan loopnya `setTimeout` DULU baru bertanya) padahal
  tokennya selalu sudah `ready` di polling pertama — dua kali per war, ~10 dtk,
  yang kedua persis di antara tombol ditekan dan submit; `prepareExtensionDir`
  kini menambalnya jadi 1 detik dan **wajib bersuara** bila polanya tak ketemu,
  karena bundle-nya minified dan update ekstensi bisa menghapus polanya. (b)
  `launchPersistentContext` + memuat ekstensi memakan 6 dtk yang seluruhnya
  dibayar sesudah jam war; sekarang Chromium dinyalakan di jendela prewarm
  (`prelaunchBrowserForJob`) dan diambil oleh `submitIrsViaBrowser`. Aturan
  pre-launch: TIDAK boleh mengantre slot dan TIDAK boleh mengambil slot terakhir
  (`PRELAUNCH_KEEP_FREE_SLOTS`) — war yang sedang berjalan lebih berhak; context
  yang mati saat menganggur dibuang dan war menyalakan sendiri; dan `war-worker`
  WAJIB memanggil `discardPrelaunchedBrowser` di setiap jalan keluar (batal
  sebelum mulai, job hilang, job CANCELLED, dan `finally`) supaya tidak ada
  proses Chromium maupun slot pool yang tergenggam selamanya.
- **Token Captcha mode browser memakai kolam yang sama dengan jalur HTTP.**
  Dulu interception Chromium menyolve sendiri dan mengabaikan kolam, sedangkan
  `prefetchTurnstile` di login menaruh token ke prefetch SESI yang di mode
  browser tak pernah dikonsumsi — hasilnya satu verifikasi terbuang tiap war dan
  satu solve penuh (5–15 dtk) tepat di jalur kritis. Sekarang: di mode browser
  login mengisi **kolam** (`topUpPoolTokens`, dilewati bila kolam masih berisi),
  dan interception mengambil dari kolam dulu sebelum menyolve baru. Syaratnya
  sitekey kedua mode harus sama sumbernya — karena itu browser kini memakai
  `resolveSlcmTurnstileConfig` (sadar rotasi), dengan konstanta keras hanya
  sebagai jaring pengaman bila discovery gagal. Token hanya terikat
  (sitekey, action) — tanpa proxy/cookie/sesi — jadi sah dipakai lintas mode.
  Setelah respons submit tertangkap, JANGAN menyolve apa pun lagi: SPA memuat
  ulang daftar kelas dan verifikasi untuk data yang tak dibaca siapa pun itu
  hanya membakar biaya lalu mati bersama context. Solve yang mati karena
  pembatalan dilaporkan `level: "debug"` dengan pesan "dibatalkan", bukan error —
  war yang sukses tidak boleh diakhiri baris "Verifikasi Captcha gagal".
- **Kelas penuh tidak pernah menghalangi pengambilan.** Ia tetap membuat sebuah
  plan dianggap tidak lengkap — itu yang membuat plan lain yang kelasnya kosong
  diutamakan — tetapi bila TIDAK ADA alternatif, kelas penuh itu tetap dicentang
  dan dikirim (mode `FULL_ANYWAY`). Kapasitas yang terbaca bisa basi dalam
  hitungan detik saat war, dan yang berhak menolak adalah SLCM; mundur duluan
  berarti kalah tanpa mencoba. Kelas seperti ini TIDAK dilaporkan sebagai
  `COURSE_MISSING` — ia diambil, bukan dilewati.
- **War "matkul eksternal" memastikan matkulnya ADA, dan tidak mati setelah
  submit pertama.** Toggle per-war (`WarJob.externalMode`, default mati; SLCM
  saja). Menyala mengubah tiga hal, dan hanya tiga: (a) **wajib ada** — kelas
  yang tidak ditawarkan portal tidak pernah dikirim, jadi tidak ada `RAW_PLAN`
  sama sekali, dan bila tak ada kelas BARU yang bisa ditambahkan POST tidak
  ditembakkan (di mode browser halaman bahkan tidak disentuh: submit hanya untuk
  mengirim ulang isi yang sama berarti membakar satu ronde dan satu verifikasi
  captcha); (b) **submit duluan, jangan mati** — begitu SEBAGIAN matkul muncul,
  yang itu dikirim sekarang juga dan war tetap hidup menunggu sisanya; (c)
  **berhenti tanpa gagal** — selesai ketika semua matkul aman ATAU batas waktu
  habis, dan habisnya batas ditutup sebagai war SELESAI dengan kelas seadanya.
  Aturan lama tetap berlaku: kelas yang sudah ada di IRS tidak pernah dilepas.
  Yang membuat ini aman diulang: `POST /course-plan` bersifat replace, dan kelas
  yang sudah aman terbaca `selected:true` pada ronde berikutnya sehingga ikut
  sebagai kelas bawaan — jadi keadaan "sudah aman" TIDAK PERNAH disimpan di
  memori sebagai kebenaran, ia dibaca ulang dari portal tiap ronde. Karena itu
  login ulang / restart koneksi di tengah war panjang tidak membuat war
  kehilangan jejak. Loopnya ada di `WarRunner.fillIrsExternal` (SATU tempat,
  dipakai kedua mode) dan satu ronde = `AcademicProvider.fillIrsRound`; angka
  penentunya `decideIrsPlan`: `notOffered` (yang ditunggu — sengaja hanya
  `MISSING`, sebab ambigu tidak akan membaik dengan menunggu), `newTargets`
  (yang membuat submit ada gunanya), dan `securedTargets`. **Tanpa batas waktu**
  (`SLCM_EXTERNAL_MAX_DURATION_MS=0`, standar): kelas susulan bisa dibuka
  berjam-jam setelah jam war, dan war yang mati duluan berarti kursinya lewat
  begitu saja — yang mengakhirinya adalah semua matkul aman, user membatalkan,
  atau portal menutup window. Konsekuensinya harus disadari: satu war seperti
  itu MENGGENGGAM satu slot worker selama ia hidup; isi env-nya dengan angka
  bila slot mulai berebut. Karena itu cadence-nya TIDAK tetap:
  `war/external-cadence.ts` menentukannya dari **jam WIB** — 1 menit di
  08.00–10.00 (jendela pembukaan IRS), 2 menit pada 18.00–22.00 (admin prodi
  kerap merapikan kelas sesudah jam kantor), melebar sampai ATAP 10 menit pada
  larut sampai subuh — dan selalu menyetel jeda ke **grid jam dinding** (09.00.00, 09.01.00),
  bukan "60 detik sejak ronde terakhir" yang pelan-pelan hanyut karena tiap ronde
  memakan beberapa detik. Terukur: 426 pengecekan sehari penuh (60×/jam pada
  08.00–10.00, 30×/jam pada 18.00–22.00), dibanding 5.760 bila 15 detik tetap →
  **427 verifikasi Captcha per akun per 24 jam** bila submitnya sekali (426
  `load_fill_irs`, 1 `submit_irs`) — disimulasikan dengan kolam token yang SEBENARNYA, dan biaya
  satu ronde browser diukur langsung ke portal: tepat 1 token per ronde.
  Angka itu baru benar SETELAH dua kebocoran ditutup, keduanya berakar pada umur
  token 240 dtk: (a) token yang disiapkan sebelum jeda 5–10 menit dijamin basi
  sebelum dipakai, dan (b) `topUpPoolTokens` menyegarkan token `submit_irs`
  setiap kali kolamnya kosong — di mode eksternal itu berarti prime ulang tiap
  ~4 menit sepanjang jam sibuk untuk token yang tidak pernah dikonsumsi
  (terukur 33 verifikasi terbuang per akun per hari; karena itu
  `TopUpArgs.includeSubmit` dimatikan di mode eksternal). Atap 10 menit itu batas atas yang diuji (`10 menit adalah
  jeda paling renggang yang mungkin`): lebih renggang membuat kelas yang dibuka
  lewat tengah malam terlalu lama tak ketahuan. Cadence yang sama dipakai sebagai jeda login-ulang
  (`minNotOpenDelayMs`, kini sebuah fungsi karena nilainya berubah menurut jam).
  Karena war bisa hidup seharian, ronde yang keadaannya TIDAK berubah juga tidak
  boleh menulis baris yang sama ke trail berulang-ulang: `quietRepeats`
  mengalihkan pesan identik berturut-turut ke `POLL_TICK` yang memang tidak
  dipersist, kecuali event kemajuan (submit/selesai/error) yang selalu tampil.
  **Biaya captcha-nya linear terhadap jumlah ronde**: tiap ronde
  memakai satu token `load_fill_irs` (jalur HTTP: GET offered-classes; mode
  browser: SPA menembaknya sendiri saat halaman dimuat), ditambah satu
  `submit_irs` hanya pada ronde yang benar-benar mengirim — jadi cadence
  menukar kecepatan menyambar kursi dengan biaya verifikasi. Yang WAJIB dijaga: token hanya disiapkan
  selama jeda yang **lebih pendek dari umur token** — `TURNSTILE_TOKEN_MAX_AGE_MS`
  240 dtk, dan `TurnstileTokenPool.take()` membuang yang lewat umur, jadi
  menyiapkan token sebelum jeda 5–10 menit berarti membakar verifikasi berbayar
  untuk sesuatu yang dijamin mati sebelum dipakai (dan rondenya tetap menyolve
  inline). Selebihnya: token disiapkan **selama jeda antar ronde**
  (`prepareForNextAttempt` dipanggil
  sebelum tidur), bukan saat permintaannya berangkat. Tanpa itu ronde
  terpenting — ronde tempat matkul yang ditunggu akhirnya muncul — harus
  menyolve token submit dari nol (~5 dtk) tepat di detik kursinya diperebutkan.
  Kolam token dibaca kedua mode (`turnstileHeaders` di HTTP, `acquireToken` di
  interception Chromium), jadi satu panggilan itu menutup keduanya. Cadence itu
  juga dipakai sebagai jeda
  minimum login-ulang (`minNotOpenDelayMs`): tanpa itu, window yang tertutup di
  tengah war 30 menit memicu login beruntun tanpa jeda. Satu konsekuensi yang
  harus disadari: bila SEBUAH plan lain sudah lengkap, plan itulah yang menang
  dan war selesai — mode eksternal menunggu matkul yang kurang **pada plan yang
  terpilih**, bukan menunggu Plan A secara khusus. Terverifikasi di halaman asli
  19 Agu 2026 (`pnpm irs:inspect --external`): plan `mk:CSIM603183` (sudah
  tercentang) + `mk:ZZZZ999999` (tak pernah ditawarkan) → `secured`
  `["820927-3"]`, `pending` `["mk:ZZZZ999999"]`, halaman tidak disentuh, submit
  tidak ditekan.
- **Pesan di trail war ditulis untuk MAHASISWA, bukan untuk yang menulis
  kodenya.** Aturannya: sebut nama mata kuliah + nama kelasnya (`Aljabar Linier
  (Alin A)`), bukan kode kelas — `820927-3` tidak berarti apa-apa di layar user;
  jangan membocorkan istilah internal (`RAW_PLAN`, "ambigu", "mode VALIDATED")
  tanpa menjelaskannya; dan SELALU sebut apa yang terjadi sesudahnya, karena
  "dilewati" saja membuat orang mengira warnya sudah menyerah. Kalimat lanjutan
  itu berbeda per mode, jadi `emitIrsPlanDecision` menerima `{ externalMode }` —
  dan di mode eksternal pesan "dikirim ulang supaya tidak hilang" WAJIB ditahan
  saat tak ada kelas baru, sebab mode itu memang tidak menembak POST sama sekali
  di ronde tunggu (`willSubmit`). Angka mentah tetap lengkap di `data` untuk
  diagnosis; yang diringkas hanya `message`.
- **Mata kuliah manual dipilih lewat KODE MATA KULIAH, bukan kode kelas.**
  Kelas yang belum ada di jadwal tersimpan mustahil ditunjuk dengan kode kelas:
  `820926` adalah nomor urut per-periode yang berganti tiap semester dan tak
  pernah ditampilkan ke mahasiswa (hanya ada di `href`). Yang stabil dan pasti
  diketahui user adalah kode mata kuliah — dan ia tersedia di KEDUA mode
  (`course_code` di offered-classes; baris grup `… - CSGE602012 (3 SKS)` di
  DOM). Terukur pada data asli (akun SI 2024, periode 2026-1, 187 kelas / 87
  matkul): 60% mata kuliah hanya punya SATU kelas, jadi kode matkul saja sudah
  cukup; nama mata kuliah TIDAK unik lintas prodi (171 dari 1.642 nama di
  katalog dipakai >1 kode) sehingga tidak sah dijadikan kunci; nama kelas tidak
  bisa ditebak user ("MatDis 1-A", "Islam-Fasilkom C", "Tatap Muka 01A",
  "Reguler") sehingga ia OPSIONAL. Bentuk tokennya `mk:<KODE>[/<nama kelas>]`
  (`domain/manual-course.ts`) — tak mungkin bentrok dengan `<class_code>-<sks>`
  yang selalu angka — pemisah segmennya `|`, dipilih dari data: `|` TIDAK PERNAH
  muncul pada 4.325 nama kelas & matkul katalog 2026-1, sedangkan `/` muncul di
  6 nama matkul dan 57 nama kelas ("KajianMandiri/Sempro"); token bentuk lama
  ber-`/` tetap dibaca supaya war tersimpan tidak mendadak ditolak. Nama matkul
  & nama kelas di dalamnya adalah **petunjuk, bukan kunci**: keduanya
  dicocokkan LONGGAR (`looselyMatch`) — sama persis → semua kata yang diketik
  ada di nama aslinya → tiap kata cukup jadi awalan → substring, dan tahap
  pertama yang berbuah dipakai. Itu yang membuat "Analisis Perancangan"
  menemukan "Analisis dan Perancangan Sistem Informasi" dan "Islam B" menemukan
  "Islam-Fasilkom B", sebab nama asli SLCM hampir selalu lebih panjang daripada
  yang diingat user. Urutan kewenangannya tegas: **kode menang**, nama hanya
  dipakai bila kode tidak menemukan apa pun, dan sebagai jaring terakhir nama
  dicocokkan ke nama KELAS juga (yang tampak di layar portal justru singkatan
  kelas, mis. "Anaperancis"). Longgar tapi tidak menebak: nama yang mengenai
  lebih dari satu KODE mata kuliah tetap `AMBIGUOUS` — terukur pada 187 kelas
  asli, "Matematika Diskret" mengenai Diskret 1 DAN 2, dan itu memang harus
  ditolak. **Kodenya sendiri OPSIONAL**: kadang yang user punya cuma nama mata
  kuliahnya (`mk:|Kewirausahaan SI|A`). Yang wajib adalah "salah satu dari kode
  atau nama ada", dan itu dijaga oleh TIPE (`ManualCourseRequest` sebuah union),
  bukan hanya oleh validator di tepi — entri tanpa keduanya tidak menunjuk apa
  pun dan harus mustahil dibentuk. **Disimpan sebagai baris
  `ScheduleClass`** (ditambahkan di
  halaman Jadwal lewat `POST /accounts/:id/schedules/manual-classes`), dikenali
  dari bentuk `classId`-nya saja — sengaja TANPA kolom penanda, supaya penanda
  dan identitasnya tak mungkin berselisih, dan tanpa migrasi. Dua sifat yang
  mengikuti dan tak boleh dilanggar: (a) `classCode`-nya `null`, dan itulah yang
  menjaga baris karangan ini tak pernah bocor ke katalog bersama —
  `contributeFromUserSchedule` menyaring baris tanpa `classCode`, di samping
  fakta bahwa baris manual memang tak pernah muncul di snapshot portal; (b)
  `saveSnapshot` melakukan replace penuh, jadi baris manual WAJIB diselamatkan
  melewati `deleteMany` — tanpa itu, mengambil jadwal ulang menghapusnya
  diam-diam (dan ia dibuang dengan sengaja bila portalnya berganti ke SIAK,
  karena token `mk:` hanya berarti di offered-classes SLCM). Nama & SKS diisi
  dari katalog bila kodenya dikenal, semata agar UI dan hitungan SKS tidak
  menampilkan tanda tanya. Terjemahannya terjadi di `plan-selector.ts` lewat
  `resolveManualCourse`, dan HASILNYA kode kelas biasa: setelah titik itu tidak
  ada lagi jejak "manual", jadi payload HTTP, pencentangan baris, carry-over,
  dan hitungan SKS memperlakukannya identik — itulah yang menjamin kedua mode
  tak bisa berbeda. Aturan yang menyertainya: tanpa preferensi kelas, kelas
  dipilih otomatis (yang sudah ada di IRS menang, lalu sisa kursi terbanyak,
  penuh pun tetap diambil); preferensi kelas yang tegas TIDAK pernah diam-diam
  diganti kelas lain (bisa berarti jam bentrok) — ia jadi `COURSE_MISSING`; dan
  entri manual WAJIB dibuang dari `RAW_PLAN` karena `mk:` bukan kode kelas.
  Validasi API sengaja melewati entri manual (`checkPlans`): ia memang tidak ada
  di jadwal — itu gunanya — sehingga bentrok jadwal & SKS-nya baru diketahui
  saat war. Terverifikasi di halaman asli 19 Agu 2026: `mk:CSIM603183` → 820927
  (Anaperancis B, otomatis dari 4 kelas, sudah tercentang → **0 klik**),
  `mk:UIGE600004` → 820960 (Islam-Fasilkom B, otomatis dari 13 kelas, 1 klik),
  6 kelas bawaan utuh, tanpa submit.
- **Dua fakta DOM SLCM yang tidak boleh dilupakan** (diverifikasi dari halaman
  asli 17 Agu 2026, bukan tebakan): (a) **kode kelas tidak pernah muncul sebagai
  teks** — ia hanya ada di tautan `/akademik/class/820521?fromNewTab=true`,
  sedangkan kolom yang terlihat cuma "Kelas &lt;nama kelas&gt;"; (b) **nama mata
  kuliah ada di baris grup**, `<td colspan="10">Aljabar Linier - CSGE602012 (3
  SKS), …</td>`, bukan di baris kelasnya — jadi pembacaan baris wajib membawa
  teks grup terakhir. Checkbox-nya `input[type="checkbox"]` Vuetify, tanpa
  `role`/`aria-checked`. Verifikasi ulang tanpa jaringan: `pnpm irs:inspect
  --out DIR` menyimpan HTML asli (tidak pernah menekan submit), `pnpm irs:verify
  DIR/halaman-sebelum.html` menjalankan pembaca & pencocok yang sebenarnya
  terhadap HTML itu.
- **Kode yang dikirim ke `page.evaluate` tidak boleh punya fungsi bernama di
  dalamnya** — baik `const f = () => …` maupun `function f() {}`. esbuild (yang
  dipakai `tsx`) membungkus tiap fungsi bernama dengan helper `__name` yang tak
  ada di dalam halaman, sehingga evaluasinya gagal `ReferenceError: __name is
  not defined`. Di build `tsc` produksi hal ini tidak muncul, jadi bug seperti
  ini lolos sampai jalur itu benar-benar dipakai. Hanya arrow anonim inline
  (argumen `.map`/`.find`) yang aman. Karena itu semua penalaran ditaruh di modul
  murni (`irs-row-match.ts`) dan kode in-page dibuat sedangkal mungkin.
- Jika retry request SLCM dan kedua jalur egress tetap habis karena gangguan
  jaringan, timeout, `429`, atau `5xx`, lempar
  `TransientProviderConnectionError`. `WarRunner` membuang sesi/provider lama
  dan mengulang lifecycle **dari login dalam job BullMQ yang sama**; status job
  tetap `RUNNING` dan kolom `attempts` tidak bertambah. Loop berhenti hanya saat
  berhasil, dibatalkan, atau max-duration job tercapai. Error kredensial,
  kelas, konfigurasi, dan respons bisnis tidak boleh masuk jalur ini. Setelah
  POST IRS sukses terkonfirmasi, kegagalan cek hasil tetap `SUBMITTED` dan tidak
  boleh memicu submit ulang dari awal.
- `CourseNotFound` SLCM tidak boleh langsung menggagalkan submit normal. Kirim
  kombinasi plan terbaik yang tervalidasi. Jika nol target tervalidasi,
  pertahankan kelas IRS `selected` yang ada; bila itu juga kosong, kirim kode
  plan terbaik apa adanya (`RAW_PLAN`). Log wajib membedakan ketiga mode agar
  user tahu payload tersebut tervalidasi, carry-over saja, atau best-effort raw.
- Prefetch Turnstile SLCM tetap membuat dua token single-use per war, tetapi
  `createTask` dan `getTaskResult` diratakan global lintas replica lewat Redis.
  Sebelum `scheduledAt`, hasil hanya dipoll tiap 5–8 detik dengan jitter; sleep
  terakhir berhenti tepat pada jadwal, lalu polling berubah menjadi tiap 1 detik.
  Gangguan polling sementara harus mempertahankan `taskId` yang sama agar tidak
  membuat task berbayar duplikat.
- `POLL_TICK` tetap dicetak ke terminal tetapi tidak disimpan ke `WarEvent`.
  Tick berfrekuensi tinggi tidak boleh membuat polling war menunggu connection
  pool PostgreSQL; event penting lain tetap durable dan realtime.
- File temp CAPTCHA di-namai `captcha-<jobId>.png` di `tmpdir` — jangan
  kembalikan ke satu `captcha.png` global; itu akan bertabrakan antar war.

## Kredensial (penting — dibaca ulang tiap kali menyentuh akun)

- Model Prisma kredensial = **`SsoUi`** (delegate `prisma.ssoUi`, tabel `SSO_UI`
  via `@@map`). Menyimpan username + `password` **plaintext** (dipakai apa adanya
  untuk login SIAK/SLCM; bukan hash). Ini keputusan produk — jangan diam-diam
  meng-hash/enkripsi tanpa diminta.
- `SsoUi.orgCode` menyimpan prodi akun dari metadata `/user` SLCM setelah OIDC
  berhasil. Pembacaannya best-effort dan **bukan cek jadwal**; kegagalan metadata
  tidak membatalkan verifikasi kredensial. Nilai ini nullable dan tidak boleh
  ditebak dari username. Frontend memakainya untuk mengadopsi katalog bersama
  secara otomatis sebelum perlu memanggil `class/table` milik akun.
- Karena plaintext, akses DB = akses password. Perlakukan Postgres sebagai
  penyimpan rahasia (least-privilege, network policy).
- Payload job Redis **hanya `{ jobId }`** — tidak ada kredensial di Redis.
  Worker memuat `SsoUi` dari Postgres (`include: { account: true }`) saat run.
  Relasi di `WarJob` masih bernama `account` (FK `accountId`) — API tetap pakai
  `accountId`; hanya model & delegate yang berganti nama.
- **Jangan** kembalikan password lewat API. **Jangan** log kredensial.

## Auth, periode, & pembayaran

- **Satu lapis identitas: sesi better-auth (cookie).** Dipasang per-route lewat
  `requireUser` / `requireAdmin` / `requirePaidAccess`. Ini satu-satunya
  penjaga — **route baru tanpa `preHandler` = endpoint terbuka.** Yang membatasi
  asal request cuma CORS (`AUTH_TRUSTED_ORIGINS`), dan karena semua endpoint
  hanya menerima `application/json`, preflight-nya itu juga yang menahan CSRF.
- Bearer `API_KEY` **sudah dihapus** — frontend-nya SPA, jadi kunci apa pun di
  sana terbaca publik. Jangan dihidupkan lagi sebagai "lapisan tambahan".
- `User` ≠ `SsoUi`. `User` adalah pembeli (email + password + nomor telepon);
  `SsoUi` adalah kredensial portal UI milik user itu. **Setiap query SsoUi/WarJob
  wajib disaring `ownerId`/`account.ownerId`** — kalau tidak, siapa pun bisa
  membaca kredensial portal atau war orang lain hanya dengan menebak id.
  Akun milik orang lain dibalas **404**, bukan 403 — jangan bocorkan keberadaan
  id-nya.
- `role` di better-auth **`input: false`** — user tidak bisa mendaftar sebagai
  admin lewat body sign-up. Promosi admin hanya lewat DB. Setelah role diubah,
  user harus **login ulang** (sesi lama masih memuat role lama).
- Nomor telepon dinormalkan ke `+62…` di `databaseHooks.user.create.before`
  (`auth/phone.ts`), bukan di route — jadi apa pun jalur masuknya, yang
  tersimpan selalu satu bentuk.
- **Entitlement**: fitur berbayar (cek jadwal, war, selection) butuh
  `requireUser` **lalu** `requirePaidAccess`. Aturannya: ada `Payment` berstatus
  `PAID` pada `Period` yang `isActive`. Bayar di periode lain tidak berlaku.
  Ditolak dengan **402** + `code` (`NO_ACTIVE_PERIOD` / `NOT_PAID`). Admin
  dilewatkan tanpa bayar.
- **Hanya satu periode boleh aktif.** Mengaktifkan periode menonaktifkan yang
  lain **dalam satu transaksi** (period.routes.ts) — jangan diubah jadi dua
  operasi terpisah.
- **Harga**: `resolvePrice()` di `payment/pricing.ts` adalah SATU-SATUNYA tempat
  aturan harga hidup — promo dipakai bila ada, kalau tidak harga asli. Jangan
  menghitung harga di tempat lain. Promo `0` sah (gratis), promo negatif atau
  lebih mahal dari harga asli diabaikan (pasti salah input).
- **QRIS statis → dinamis** (`payment/qris/`, di-port dari
  `verssache/qris-dinamis`): ubah tag 01 `11`→`12`, sisipkan tag 54 (nominal)
  **sebelum** tag 58 karena urutan tag EMVCo harus menaik, lalu **hitung ulang
  CRC16** di tag 63. Murni lokal, tanpa panggilan jaringan.
- **Kode unik itu inti verifikasi manual.** Nominal = harga + kode unik, dan
  wajib unik di antara tagihan `PENDING` pada satu periode — kalau dua orang
  menunggu dengan nominal sama, admin tak bisa membedakan mutasinya. Dijaga
  **partial unique index** (`WHERE status = 'PENDING'`) lewat SQL, bukan
  `@@unique` biasa: dua tagihan EXPIRED bernominal sama itu wajar.
- `POST /payments` tidak butuh body, tapi klien lazim mengirim
  `content-type: application/json` dengan body kosong. Ada `addContentTypeParser`
  yang memperlakukan body kosong sebagai `{}` — jangan dihapus, tanpa itu
  Fastify membalas `FST_ERR_CTP_EMPTY_JSON_BODY`.

## Jadwal kelas (tabel `Schedule`)

- **Keluaran SIAK & SLCM WAJIB identik.** Bentuknya `ScheduleEntry`
  (`domain/models.ts`) dan sengaja **minimal** — hanya field yang bisa dipenuhi
  kedua portal (id, classCode, className, courseCode, courseName, sks,
  curriculumCode, section, schedules, lecturers). Field kaya khas SLCM
  (kapasitas, jumlah mhs, rentang tanggal) **jangan** ditambahkan lagi; SIAK
  tidak bisa menyediakannya, dan keluaran jadi tidak sebanding.
  Kesamaan bentuk dijamin compiler: kedua mapper bertipe `ScheduleEntry`.
- **Setiap akun mengambil jadwalnya sendiri** — tidak ada cache lintas akun.
  **Satu baris `Schedule` per akun** (`accountId` unique), bukan per portal:
  SIAK dan SLCM menawarkan kelas yang sama, jadi menyimpan keduanya cuma
  duplikat. Ambil ulang dari portal mana pun = jadwal lama **diganti**
  (`upsert` + `deleteMany`/`createMany` dalam satu transaksi), bukan menumpuk.
  Konsekuensinya `GET /accounts/:id/schedules` mengembalikan 0 atau 1 item dan
  **tidak** punya filter `?source=` — nilainya sudah ada di hasil.
- `lastUpdatedAt` + `source` menjawab "terakhir diperbarui via SIAK/SLCM".
- **`ScheduleClass.isChoosed`** = kelas yang ditandai user untuk di-war-kan.
  Diubah lewat `PUT` (ganti semua) / `PATCH` (sebagian) `/accounts/:id/schedules/selection`.
  ⚠️ `saveSnapshot` menghapus-dan-membuat ulang baris kelas, jadi pilihan
  **wajib** dipanen sebelum `deleteMany`. SLCM dapat mengganti `classId` untuk
  kelas yang tetap sama, jadi pada portal yang sama pencocokan memakai
  `classId` ATAU identitas stabil `courseCode + courseName + className`.
  `pnpm sync:new` sekaligus memindahkan tanda pilihan dan referensi pada war
  `SCHEDULED` ke classId terbaru. Kelas lama dihapus hanya bila penggantinya
  benar-benar ada. Kelas yang hilang tanpa pengganti dilaporkan sebagai
  `droppedChoices` di event `SCHEDULE_SAVED`.
- ⚠️ **Kode kelas SIAK ≠ kode kelas SLCM.** Diverifikasi pada dua snapshot
  periode yang sama (SIAK "2026/2027 - 1", SLCM "2026-1"): **34 kelas** yang
  cocok `courseCode` + nama kelas (Alin, SDA, PBP, RPL, Statprob, Jarkom, DDP 2,
  Matdis 2, Forensik Digital) punya `sks` sama 34/34 dan kurikulum sama 33/34,
  tapi **`classId` sama 0/34** — mis. Alin A = `820521-3` di SIAK, `813664-3` di
  SLCM. Selisih `classCode` tidak tetap (6848–7599), jadi **tidak ada rumus
  konversi**. Jam/ruangnya pun berbeda, jadi keduanya memang record berbeda,
  bukan sekadar penomoran ulang.
  Konsekuensi: ganti portal **pasti** mereset seluruh `isChoosed` — itu benar,
  karena kode SLCM tidak bisa disubmit ke SIAK. `sourceChanged` di
  `SCHEDULE_SAVED` membedakan kasus ini dari "kelas hilang dari portal".
  **Jangan** mencocokkan pilihan lintas portal lewat `courseCode`+`className`:
  nama pun beda (SIAK memberi prefiks "Kelas "), dan hasilnya tebakan yang bisa
  salah submit.
- **War wajib satu portal dengan jadwalnya — ditolak keras.** `checkPlans` di
  `war.routes.ts` membandingkan `WarJob.provider` dengan `Schedule.source` pada
  `POST /wars` dan `PATCH /wars/:id/courses`, dan membalas **409** dengan
  `code: "PROVIDER_MISMATCH"` atau `"UNKNOWN_COURSES"`. Job tidak dibuat /
  `courses`/`plans` tidak berubah. Alasannya: war yang matkulnya salah pasti gagal, dan
  baru ketahuan saat war jalan — sudah terlambat diperbaiki.
  **Pengecualian:** akun yang belum pernah mengambil jadwal tidak divalidasi —
  tidak ada dasar pembanding. Jangan mengubahnya jadi "wajib ambil jadwal dulu"
  tanpa keputusan produk.
- ❓ **Belum terverifikasi:** war SLCM memakai `offered-classes`, sedangkan cek
  jadwal memakai `class/table` — apakah `classcode` keduanya identik belum bisa
  dibuktikan karena periode IRS sedang tutup (`success:false`). Verifikasi ini
  saat window buka; kalau ternyata beda, `isChoosed` dari cek jadwal SLCM tidak
  bisa dipakai langsung sebagai `WarJob.courses`.
- `isChoosed` **terpisah** dari `WarJob.courses`. Menandai kelas tidak otomatis
  membuat/mengubah war; `courses` tetap ditentukan saat `POST /wars` atau
  `PATCH /wars/:id/courses`.
- Normalisasi lintas portal ada di `domain/period.ts`:
  - `parseSiakPeriodLabel` mengubah label SIAK ("2025/2026 Gasal") ke
    `{ year, term }` ala SLCM. Konvensi: **tahun awal** dipakai (2026/2027 →
    2026), Gasal=1/Genap=2/Pendek=3. Terverifikasi live: pada saat yang sama
    SIAK menampilkan "2026/2027 - 1" dan SLCM "2026-1" untuk periode yang sama.
  - `normalizeSection` menyamakan "Kelas Bersama" ↔ `group`, dst.
- `org_code` **hanya SLCM** yang punya, dan ada **DUA** yang berbeda arti:
  - `Schedule.orgCode` — prodi pemilik **akun**, dari payload xAppToken lewat
    `SlcmSession.orgCode()` (tidak perlu browser). Saat update, nilai null dari
    SIAK **tidak** menimpa nilai lama.
  - `ScheduleClass.orgCode` — prodi pemilik **kelas**, dari field `orgcode` di
    `class/table` (terverifikasi terisi 302/302). Sering **berbeda** dari prodi
    akun: kelas `group`/`external` milik prodi lain, dan satu akun bisa
    mengambil kelas dari **35 prodi berbeda**. Nilai ini disimpan sebagai
    `CatalogClass.ownerOrgCode`; sumbangan katalog sendiri dikelompokkan menurut
    `Schedule.orgCode` agar akun dari prodi yang sama saling berbagi tawaran.

  Keduanya dipetakan ke nama fakultas/prodi lewat `catalog/faculty-lookup.ts`
  (`lookupFaculties` versi banyak-sekaligus — satu jadwal menyentuh puluhan
  prodi, jadi jangan panggil per baris).

## Katalog jadwal bersama (baseline admin + kontribusi akun)

Jalur **kedua** untuk mendapatkan daftar kelas, **berdampingan** dengan cek
jadwal per-akun — bukan penggantinya. Admin menarik baseline kelas UI, lalu
hasil `class/table` akun melengkapinya dan dibagikan ke seluruh akun dengan
`Schedule.orgCode` yang sama.

**Sumbernya SELALU SLCM.** Hanya SLCM yang punya endpoint organisasi, dan
kodenya adalah kode SLCM. Konsekuensinya `Schedule.source` hasil adopsi katalog
= `SLCM`, jadi war provider SIAK otomatis ditolak `checkCourses()` — aturan yang
sudah ada, tidak perlu cabang baru.

Empat endpoint SLCM yang dipakai (semuanya **butuh login**; tanpa token → 401):

| Endpoint                                   | Isi                                   |
| ------------------------------------------ | ------------------------------------- |
| `/v1/organization/kode-jenis-org/3`        | 22 fakultas (`code` "12.01")          |
| `/v1/organization/faculty/{kode}`          | prodi + `org_code` lengkap + jenjang  |
| `/v1/class/period/org-code/{org}`          | periode yang tersedia untuk prodi itu |
| `/v1/class/whole?org=&year=&term=&lang=id` | **seluruh** kelas prodi itu           |

⚠️ `class/whole` ≠ `class/table`. `class/table` terikat akun yang login (hanya
tawaran untuk dia); `class/whole` menerima `org_code` mana pun. **Itulah** yang
membuat satu akun admin bisa menarik katalog seluruh universitas — terverifikasi
dengan akun `06.00.12.01` yang berhasil membaca `01.00.12.01`.

### Hubungan pasti `class/table` ↔ `class/whole` (terukur)

Dibandingkan pada akun yang sama (`06.00.12.01`, Sistem Informasi S1), periode
`2025-1` & `2025-2`, kedua endpoint pada SLCM yang sama:

|                         | 2025-1 | 2025-2 | 2026-1 |
| ----------------------- | ------ | ------ | ------ |
| `table?type=internal`   | 80     | 63     | 0      |
| `table?type=group`      | 40     | 111    | 41     |
| `table?type=external`   | 182    | 270    | 0      |
| `whole?org=06.00.12.01` | 79     | 61     | 0      |
| irisan table ∩ whole    | 79     | 61     | 0      |
| **hanya di whole**      | **0**  | **0**  | **0**  |

Polanya, dan ini yang menentukan cara memakai katalog:

1. **`whole(X)` = kelas MILIK prodi X**, semua tipe menyatu, tanpa memandang
   siapa yang login. **`internal` = kelas milik prodi AKUN**. Karena itu
   `whole(orgAkun)` ≈ `internal`, dan menjadi baseline katalog untuk audience
   prodi tersebut. Hasil `class/table` user dengan org akun yang sama kemudian
   melengkapinya dengan kelas yang benar-benar ditawarkan ke kelompok akun itu.
2. **`group` & `external` berasal dari prodi LAIN — 0% ada di `whole(orgAkun)`**
   (0/40, 0/111, 0/182, 0/270, 0/41). Contoh paling tajam: pada `2026-1` akun SI
   punya **41 kelas, semuanya `group`, semuanya milik `01.00.12.01` (Ilmu
   Komputer S1)** — prodinya sendiri menawarkan **nol**. Karena katalog USER
   dikelompokkan berdasarkan prodi akun, kontribusi ini tetap muncul di audience
   `06.00.12.01`, sementara `ownerOrgCode` menyimpan `01.00.12.01`. Artinya
   akun SI lain mendapat 41 kelas itu tanpa perlu sync akun sendiri.
3. **Isi field identik.** Untuk kelas yang beririsan: `classname`, `coursecode`,
   `coursename`, `sks`, `currcode`, `forterm`, `dates_rooms`, `lecturers` sama
   **79/79** dan **61/61** setelah di-trim. Satu-satunya beda: `class/table`
   mengirim `coursename` dengan **spasi di ujung** (56/79 kasus), `class/whole`
   tidak. Murni kosmetik — `slcm-catalog.ts` sudah men-trim semuanya.
4. **Satu-satunya yang benar-benar hilang: kelas `special = 1`** (Tugas Akhir /
   skripsi). Kelas **non-special ada 100%** di `whole` (78/78 dan 61/61); yang
   `special` tidak konsisten — 1 dari 2 muncul di `2025-1`, 0 dari 2 di
   `2025-2`. Tidak ada parameter yang mengubahnya (`special=1`, `all=1`,
   `type=all`, `hide=0` semuanya menghasilkan jumlah identik). **Konsekuensi:
   Tugas Akhir tidak bisa diandalkan ada di katalog** — user yang perlu meng-IRS
   TA harus memakai cek jadwal biasa (§4.1).

Tiga aturan `catalog-sync.ts` yang jangan dibalik:

1. **Gagal sebagian ≠ gagal semua.** Ratusan prodi ditarik satu per satu; yang
   error masuk `failedOrgs`, sisanya tetap tersimpan. Sync yang batal total
   karena satu prodi tidak akan pernah selesai.
2. **Fakultas & prodi hanya di-upsert, TIDAK pernah dihapus.** Menghapus prodi
   meng-cascade kelasnya di **semua** periode, termasuk periode lama yang masih
   dipakai. Prodi yang hilang cukup berhenti dapat kelas baru.
3. **Baseline SYNC di-replace per (prodi, periode)** dalam satu transaksi.
   Baris USER yang tidak ditemukan `class/whole` dipertahankan; hanya SYNC lama
   dan irisan USER yang diganti. Jadi sync ulang idempoten tanpa menghapus kelas
   tambahan hasil akun.

Pencarian memakai kolom `CatalogClass.searchText` — gabungan kode kelas, nama
kelas, kode & nama mata kuliah, dan dosen, **sudah huruf kecil** saat sync. Jadi
querynya LIKE biasa (bukan ILIKE) supaya **indeks GIN trigram**
(`CatalogClass_searchText_trgm`, dipasang lewat SQL di migrasi karena Prisma
tidak bisa mendeklarasikannya) benar-benar terpakai. `classId` diperiksa
terpisah agar salin-tempel kode utuh ("810197-3") juga ketemu.

### Katalog diisi DUA arah

Selain sinkronisasi admin, **tiap cek jadwal user SLCM menyumbang ke katalog**
(`catalog-contribution.ts`, dipanggil dari `war-worker` setelah `saveSnapshot`).
Ini menambal celah yang tidak bisa ditambal admin: `class/whole` tidak konsisten
mengembalikan kelas `special = 1`, sedangkan `class/table` memuatnya.

Terbukti pada `06.00.12.01` periode `2025-1`: sync menghasilkan 79 kelas **tanpa**
Tugas Akhir `787245-6`; setelah satu user menyumbang, kelas itu masuk sebagai
`source: USER`; setelah sync dijalankan **ulang**, kelas itu **tetap ada**.
Satu jadwal user dapat memuat kelas milik **36 prodi** sekaligus. Semua kelas itu
disimpan di audience `Schedule.orgCode` (prodi akun), sedangkan prodi pemiliknya
tetap dicatat pada `CatalogClass.ownerOrgCode`. Jadi akun lain dengan org akun
yang sama mendapat gabungan tawaran tersebut tanpa perlu sync sendiri.

Tiga aturan yang menjaga katalog tidak rusak — **jangan dilonggarkan**:

1. **SLCM saja.** Kode kelas SIAK berbeda total (irisan `classId` 0/34).
   Memasukkannya berarti menaruh kode yang tidak bisa disubmit ke SLCM.
2. **Sumbangan user TIDAK PERNAH menghapus.** `class/table` hanya memuat kelas
   yang ditawarkan ke user itu. Ia di-upsert ke audience prodi akun sehingga
   beberapa user dengan org akun sama membentuk union tawaran bersama.
3. **Sync tidak menghapus baris USER yang tidak dilihatnya.** `replaceClasses`
   hanya menghapus `source: SYNC` **dan** baris yang `classId`-nya ada di hasil
   sync (supaya data otoritatif menang di irisan). Baris USER di luar itu
   dibiarkan hidup — justru itu nilainya.
4. **Periode hanya dari `Period.isActive`.** Jangan menerima override periode
   dari query/body/CLI dan jangan memakai periode snapshot user atau fallback
   katalog terakhir sebagai bucket. Metadata portal yang berbeda boleh dicatat
   di event, tetapi kontribusinya tetap dinormalisasi ke periode aktif. Unique
   `(orgCode, period, classCode)` kemudian mencegah kelas user yang sama
   berulang. `classCode` adalah identitas latest-write-wins: bila kode yang sama
   di-sync lagi, payload terbaru (termasuk `classId`/SKS baru) menimpa yang lama.
   Jangan memakai `courseCode` untuk deduplikasi karena satu mata kuliah boleh
   punya beberapa kelas paralel.

`CatalogOrgPeriod` menjawab "last_updated berdasarkan `org_code` akun/audience":
`lastUpdatedAt`/`lastUpdatedBy`, `lastSyncedAt`, `lastUserFetchAt`,
`classCount`, `userClassCount`. Field turunan **`partial: true`** =
`lastUserFetchAt === null`, artinya katalog prodi itu baru punya baseline
`class/whole` dan belum pernah dilengkapi `class/table` akun. Karena whole dapat
melewatkan group/external/special, tampilkan status ini ke user; jangan
sembunyikan. Tidak adanya `lastSyncedAt` bukan alasan menyebut data akun parsial:
hasil akun justru sumber tawaran yang valid untuk audience `org_code` tersebut.

**Tabel fakultas hard-code sudah DIHAPUS.** `domain/faculty.ts` (1.683 baris) dan
`domain/faculty-lookup.ts` diganti `catalog/faculty-lookup.ts` yang membaca
`CatalogProgram` + `CatalogFaculty`. Alasannya: tabel itu tak punya sumber
kebenaran yang bisa disegarkan — prodi baru atau berganti nama tidak akan pernah
muncul tanpa suntingan manual. Endpoint SLCM memberi data yang sama (22 fakultas,
481 prodi) dan ikut diperbarui tiap sync. Konsekuensi yang harus diterima:
sebelum sync pertama, `faculty` pada `GET /accounts/:id/schedules` bernilai
`null`. Itu jawaban jujur — **jangan** diganti tebakan dari pola `org_code`.

**Adopsi ke jadwal akun** (`POST /accounts/:id/schedules/from-catalog`) sengaja
lewat `saveSnapshot()` yang sama dengan cek jadwal biasa — bukan tulis langsung
ke tabel. Dengan begitu satu-jadwal-per-akun, pelestarian `isChoosed`, dan reset
saat ganti portal ikut berlaku tanpa disalin ulang.

⚠️ **Katalog ≠ hak ambil.** `class/whole` memuat seluruh tawaran prodi,
sedangkan saat war SLCM hanya menerima kelas yang ada di `offered-classes`
akun itu. Kode di luar itu dilewati; bila semua target tidak tersedia, barulah
`CourseNotFoundError` menggagalkan submit. Karena itu balasan adopsi menyertakan `note` peringatan; jangan
dihapus tanpa mengganti dengan validasi yang sebenarnya.

## Matkul pilihan dan plan fallback

`WarJob.courses` tetap menyimpan daftar kelas Plan A dalam format
`<classCode>-<sks>` untuk kompatibilitas. `WarJob.plans` menyimpan kombinasi
lengkap berurutan Plan A, B, C, dst. Setiap plan boleh memuat himpunan mata
kuliah berbeda, tetapi tetap hanya boleh berisi satu kelas per mata kuliah,
tidak boleh bentrok jadwal, dan tidak boleh sama persis dengan plan lain.
Validasi ini memblokir pembuatan job dengan 409
`INVALID_PLANS`; beda portal/kode tak dikenal tetap memakai
`PROVIDER_MISMATCH`/`UNKNOWN_COURSES`.

Pada SLCM, `fillIrs` membaca `offered-classes` lalu mencoba plan secara urut.
Kelas tersedia bila `selected === true` atau `nstudents < capacity`. Plan lengkap
pertama dipakai. Bila semua plan terhalang, kombinasi parsial terbaik tetap
dikirim: jumlah mata kuliah tersedia terbanyak, lalu total SKS terbesar, lalu
urutan plan. Efek rantai jadwal ditangani oleh kombinasi mandiri yang disusun
user, bukan dengan menukar satu kelas secara independen saat worker berjalan.

Kode `<class_code>-<sks>` dicocokkan secara exact terlebih dahulu. Hanya jika
`class_code` tersimpan tidak ada sama sekali di `offered-classes`, worker boleh
mencari satu pengganti unik berdasarkan `course_name_id + class_name` dari
snapshot jadwal akun. Payload memakai kode pengganti aktual dan meng-emit
`COURSE_REMAPPED`. Bila ada lebih dari satu kandidat, kelas dianggap ambigu dan
tidak ditebak. Fallback ini hanya untuk jalur normal; `BLIND_SUBMIT` tetap
mengirim kode Plan A tersimpan apa adanya tanpa pencocokan nama.

`PATCH /wars/:id/courses` tersedia selama status `SCHEDULED` dan menerima
`courses` + `plans?` dengan kontrak yang sama seperti pembuatan war. Jika
`plans` dikirim, seluruh Plan A/B/C diganti; request lama yang hanya mengirim
`courses` tetap didukung dan menjadi satu Plan A. Penandaan `isChoosed`
(`PUT`/`PATCH .../selection`) tetap terpisah dari job war.

## Penjadwalan (WIB) — jangan salah

- User memilih `scheduledAt` dalam **WIB (Asia/Jakarta, UTC+7 tetap)**. Parsing
  di `shared/time.ts` (`parseWibToUtc`): input naif → WIB; input ber-offset →
  apa adanya. Simpan sebagai UTC. **Jangan** pakai `new Date(naif)` langsung —
  itu memakai zona server, salah.
- Kebijakan di `war/scheduling.ts` menetapkan `dispatchAt === scheduledAt`
  untuk kedua provider. **Tidak boleh ada proses akun sebelum waktu war**:
  tanpa login, CAPTCHA/Turnstile, prefetch, warm-up, atau request portal.
  Autotuner boleh menyiapkan kapasitas lane karena itu tidak memuat akun atau
  mengakses portal. `millisecondsUntilWarStart()` adalah gate pertahanan untuk
  delayed job lama/clock skew: sebelum T worker hanya membaca metadata waktu,
  tanpa memuat kredensial, menulis event, atau mengubah status. Setelah T,
  lifecycle normal dimulai.
- **Gate normal "window terbuka" SLCM: `success === true` DAN
  `data.in_submit_period === true`.** Selama tutup, SLCM membalas
  `{ success:false, data:null, errors.id[0].message[...] }` — itu respons
  **VALID**, bukan error; jangan diperlakukan sebagai kegagalan. Karena itu
  polling memakai `getSoft()` yang tidak melempar pada status non-2xx.
- Reschedule = `removeQueuedWar` + `enqueueWar` dengan delay baru (hanya saat
  status `SCHEDULED`). Cancel: hapus delayed job bila belum jalan, publish
  `war-cancel` bila `RUNNING`.
- **Operasional:** minimal satu `ROLE=worker` harus hidup menjelang dispatch.
  Konkurensi dinamis (§ atas), bukan angka tetap.

## Ketahanan jaringan (internet lemot / stuck)

- **Semua I/O SLCM WAJIB lewat `shared/http.ts` `httpFetch`** — bukan `fetch`
  telanjang. Native `fetch` tidak pernah timeout, jadi koneksi menggantung =
  war stuck selamanya. `httpFetch` memberi timeout per-percobaan, menggabungkan
  `ctx.signal` (cancel/maxDuration benar-benar menghentikan request), dan retry
  transien (timeout/jaringan/5xx/429).
- Sitekey Turnstile SLCM **jangan di-hardcode**. Sebelum `offered-classes` dan
  `course-plan`, `turnstile-site-key.ts` membaca HTML Akademik + route chunk
  `/pengisian-irs`, lalu mencari `TURNSTILE_SITE_KEY` dari dependency build
  terbaru. Lookup memakai single-flight cache 30 menit agar polling/job paralel
  tidak memindai bundle berulang. Action yang dipasangkan adalah
  `load_fill_irs` untuk GET dan `submit_irs` untuk POST. Resolver ini hanya
  mengambil konfigurasi publik; tidak menghasilkan token Turnstile.
- Tepat sebelum request IRS, worker membuat task
  `AntiTurnstileTaskProxyLess` ke service operator manusia, lalu polling hasil
  tanpa batas percobaan sampai token siap atau job dibatalkan. Payload publik
  tetap dicetak untuk diagnosis, tetapi `clientKey` dan token **tidak boleh
  masuk log**. GET memakai action `load_fill_irs`; POST memakai `submit_irs`.
  Token dikirim sebagai `X-Captcha-Token`, dan `userAgent` hasil verifikasi
  dipakai hanya pada request IRS terkait. Setiap request mendapat token baru.
  Selama API key belum diisi, feature gate mempertahankan perilaku lama tanpa
  header CAPTCHA dan mengeluarkan satu `WARN` per sesi; service tetap boot.
- **Tiga gerbang membuka window IRS SLCM** — semuanya diputuskan `evaluateGate()`:
  1. `FLAG` — `success:true` **dan** `in_submit_period:true`.
  2. `SCHEDULED_TIME` — `success:true` **dan** `now >= ctx.scheduledAt`.
     `in_submit_period` diabaikan karena flag bisa telat berubah.
  3. `BLIND_SUBMIT` — `now >= scheduledAt + 1 menit` ketika `offered-classes`
     tetap `success:false` atau request-nya gagal. Worker mencoba
     `POST /course-plan` dengan kelas Plan A apa adanya. Jalur ini sengaja
     mengorbankan validasi kelas dan carry-over demi tidak kehilangan window.
     Setelah POST darurat berhasil, worker tetap memeriksa `offered-classes`
     dengan interval acak 1–2 detik selama maksimal 5 menit. Jika endpoint
     kembali `success:true`, IRS dikirim ulang lewat jalur normal agar kelas
     tervalidasi dan kelas lama yang `selected:true` ikut dipertahankan. Jika
     endpoint tidak pulih, hasil POST darurat tetap dianggap terkirim.
     `me/summary` hanya untuk MELIHAT isi IRS dan bukan syarat pengisian.
- **Submit IRS SLCM di-retry sampai berhasil**, bukan sekali tembak. Aman
  karena `POST /course-plan` bersifat **replace** — payload sama dikirim dua
  kali menghasilkan IRS yang sama, tidak ada penambahan ganda. Loop berhenti
  hanya karena sukses, `ctx.signal` abort, atau `CourseNotFoundError` (semua
  target tidak tersedia → mengulang percuma).
  - ⚠️ `slcm.post()` hanya melempar pada non-2xx, sedangkan SLCM lazim membalas
    **200 dengan `success:false`** untuk kegagalan bisnis. Karena itu
    `submitOnce` memeriksa `success === false` secara eksplisit. `undefined`
    **bukan** kegagalan (summary sukses pun tanpa field itu).
  - Sebelum `scheduledAt + 1 menit`, `submitOnce` tidak menembak buta:
    `success:false` diulang. Setelah batas itu, mode `BLIND_SUBMIT` langsung
    mengirim daftar war dan mengulang POST sampai pertama kali berhasil.
    Sesudahnya yang diulang adalah GET `offered-classes`; POST berikutnya hanya
    dilakukan ketika endpoint pulih, atau retry submit darurat sebelumnya gagal.
- ⚠️ **`POST /course-plan` MENGGANTI seluruh isi IRS, bukan menambah.** Karena
  itu `fillIrs` SLCM menyertakan kelas yang sudah `selected: true` di
  `offered-classes` ke dalam payload (di-dedup terhadap daftar war, event
  `COURSE_CARRIED_OVER`). Tanpa itu, kelas yang sudah didapat sebelumnya
  **terhapus** oleh war. Pengecualian hanya mode darurat `BLIND_SUBMIT`, karena
  offered-classes tidak menyediakan data untuk mengetahui kelas lama.
  - Kelebihan SKS **tidak** dipangkas otomatis — memangkas = membuang kelas,
    persis yang mau dihindari. Hanya diperingatkan lewat event `WARN` bila
    total melewati `max_sks`. Keputusan produk: "kebanyakan gapapa asal ga
    hilang".
  - SIAK tidak punya masalah ini: `checkRadio` tidak pernah meng-uncheck, dan
    submit form HTML mengirim semua radio yang tercentang.
- **Pemilihan plan SLCM:** plan lengkap pertama yang seluruh kelasnya tersedia
  dipakai. Jika tidak ada, plan parsial dengan kelas terbanyak → SKS terbesar →
  urutan plan dipakai. Event `PLAN_SELECTED` merekam plan, kelas tersedia, dan
  kelas penuh/tidak ditemukan. Kelas `selected:true` dianggap tersedia meski
  `nstudents >= capacity`, karena kursinya sudah berada di IRS user.
- **GET boleh retry** (`SLCM_GET_RETRIES`); **POST mutasi (submit IRS) JANGAN
  retry** (`SLCM_MUTATION_RETRIES=0`) — risiko dobel-submit. Auth/refresh retry
  error jaringan saja.
- `pollUntilOpen` (SLCM) **membungkus `get()` dengan try/catch** → error transien
  di momen genting → log + lanjut polling, bukan mematikan war.
- **CAPTCHA solver sengaja TIDAK dibatasi** — mencoba terus sampai CAPTCHA
  terpecahkan (untuk war, menyerah = kalah). Panggilan ke service prediksi tetap
  punya timeout sendiri (`AbortSignal.timeout` 15s) jadi tidak menggantung
  per-percobaan; hanya loopnya yang tak berbatas. Ini keputusan produk — jangan
  tambahkan max-attempts/deadline tanpa diminta.
- SIAK: operasi Playwright lain punya timeout eksplisit; abort saat polling
  ketahuan paling lambat ~30s (batas `goto`). (Loop CAPTCHA di atas dikecualikan
  dari abort — sesuai keputusan tak-berbatas.)
- `checkResult` yang gagal **tidak** menggagalkan war: `war-runner.ts` menangkap
  errornya, mengisi `checksUnavailableReason`, dan job tetap `SUBMITTED` — IRS
  yang sudah terkirim tak boleh jadi `FAILED` karena cek hasil flaky.

## Hasil war: fakta, bukan putusan (JANGAN dibalik)

- `WarStatus` **tidak punya WON/LOST**, dan `IrsResult` **tidak punya**
  `outcome`; `CapacityCheck` **tidak punya** `won`. Selesai = `SUBMITTED`.
- Backend hanya melaporkan `{ courseId, courseName, capacity, position }` per
  kelas. **Frontend** yang menyimpulkan dapat/tidaknya. Ini keputusan produk:
  aturan "dapat" bisa berubah (kuota tambahan, kelas dibuka, mahasiswa mundur),
  jadi membekukannya jadi status DB berarti menulis putusan yang bisa basi dan
  tak bisa dihitung ulang. **Jangan** menambahkan kembali WON/LOST/`won`.
- Bentuk `checks[]` identik lintas provider. Satu-satunya beda **data** (bukan
  bentuk): `courseId` selalu `null` di SIAK — halaman `CoursePlanViewCheck`
  hanya memuat nama kelas, tanpa kode. Jangan menebak kodenya dengan pencocokan
  nama; kalau butuh, jadikan itu keputusan eksplisit di frontend.
- `checksUnavailableReason` (`null` = kapasitas terbaca) membedakan "tidak dapat
  kelas" dari "belum bisa diverifikasi". Keduanya jangan dicampur.
- **Cek hasil susulan = WarJob `CHECK_RESULT` tersendiri**, bukan pemanggilan
  ulang di memori. Dibuat otomatis oleh `scheduleRecheck` di `war-worker.ts`
  setelah FILL_IRS berhasil submit, dengan jeda `RESULT_RECHECK_DELAY_MS`
  (0 = matikan). Punya status/event/result sendiri, terhubung ke war asalnya
  lewat `parentJobId` (`GET /wars/:id` mengembalikan `rechecks[]`).
  - `WarRunner.checkResultOnly()` **tidak** menyentuh IRS (tanpa poll, tanpa
    submit), jadi aman dijalankan berkali-kali.
  - Job `CHECK_RESULT` **tidak** memicu recheck lagi — jangan bikin rantai.
  - Gagal menjadwalkan recheck **tidak boleh** menjatuhkan war: `finish()`
    sudah menulis SUBMITTED sebelum `scheduleRecheck` dipanggil, dan errornya
    ditelan jadi event `WARN`.
- **`checkResult` SIAK harus login-aware & terverifikasi.** `guardPage()`
  **tidak** menangani `state === "login"` (sengaja — saat `login()` halaman
  memang form login), jadi sesi yang hilang di tengah jalan akan lolos diam-diam
  dan `readChecks()` mem-parse halaman login → 0 baris → salah lapor "tidak ada
  kapasitas". Pola wajibnya sama seperti buka Schedule: `navigate()` longgar →
  `auth.loginIfNeeded()` → `guard()` → **`checkPage.isOpen()`** baru
  `readChecks()`, diulang `RESULT_OPEN_ATTEMPTS` kali dengan retry
  `isTransientBrowserError`. **Jangan** panggil `readChecks()` tanpa `isOpen()`.
- Dua alasan gagal cek dibedakan tegas di `checksUnavailableReason`: _"tidak
  terbuka setelah N percobaan"_ (sesi/portal bermasalah) vs _"terbuka tapi tidak
  memuat baris kapasitas"_ (halaman benar, datanya memang belum ada). Jangan
  disatukan — keduanya menuntut tindakan berbeda.
- **Jangan** menambah `fetch` baru tanpa timeout+signal. Kalau perlu I/O jaringan
  di jalur SIAK, bungkus juga dengan timeout & hormati `ctx.signal`.

## Konsistensi data

- **Postgres = sumber kebenaran status/hasil/jadwal.** Worker meng-update
  `WarJob` (`RUNNING` di awal, status akhir di `finally`/`catch`). Jangan taruh
  status hanya di memori. Status: `SCHEDULED → RUNNING → SUBMITTED|FAILED|
CANCELLED` (CHECK_SCHEDULE mulai dari `PENDING`).
- Idempotensi: `idempotencyKey` di request → unik di DB **dan** dipakai sebagai
  `jobId` BullMQ, jadi klien boleh retry tanpa dobel war.
- Pembatalan lintas proses: `POST /wars/:id/cancel` mem-`publish` ke channel
  Redis `war-cancel`; worker yang memegang job meng-abort `AbortController`-nya.
  `ctx.signal` harus diperiksa di loop panjang (sudah di kedua `pollUntilOpen`).

## Yang sudah ditangani dari kedua portal (jangan "dirapikan" balik)

Semua kuirk di `../siak-war/AGENTS.md` dan `../slcm/AGENTS.md` masih berlaku dan
sudah di-port:

- **SIAK**: page guard menyelesaikan CAPTCHA/ChangeRole/reject; guard **bisa
  memindahkan halaman** (jangan asumsikan URL tetap setelah `guard()`). Mojibake
  cp1252, `__name` di `page.evaluate` (tulis inline / hindari `const fn = () =>`
  bernama di dalam evaluate), tabel terdalam, dropdown `#period` (bukan `select`
  pertama = dropdown zoom). Path baru harus masuk `EXPECTED_PATHS`
  (`providers/siak/constants.ts`) atau guard menganggapnya `unexpected`.
- **SLCM**: butuh **dua** header (`Bearer` + `x-app-token`); tanpa x-app-token → 401. `type=all`/`special` → 500 (gabung `internal`+`group`+`external`).
  Submit body `{ comment, classes: ["810203-3"] }`, `classes` = `<class_code>-<sks>`.
- **Token SLCM bisa tiba-tiba invalid di tengah war** (access 6 mnt, refresh
  31 mnt, war bisa lebih lama). `slcm-client.ts` menangani berlapis:
  (1) refresh proaktif menjelang kedaluwarsa, (2) refresh gagal → **login ulang
  penuh**, (3) request tetap dibalas **401/403 → login ulang lalu request
  diulang sekali** (`SlcmSession.send`). Aman untuk POST karena 401/403 berarti
  ditolak sebelum diproses (tidak ada efek samping ganda).
  ⚠️ `httpFetch` sengaja **tidak** me-retry 401/403 (hanya 5xx/429/jaringan),
  supaya status itu sampai ke handler re-login. Jangan diubah.
- Format `id` kelas **identik** lintas provider: `<classCode>-<sks>` — sengaja,
  supaya hasil cek jadwal langsung bisa jadi `courses` war.

## Menguji tanpa portal sungguhan

- SLCM: unit-test provider dengan mem-`mock` `fetch` global (semua I/O lewat
  `fetch`). **Jangan** kirim mutasi (`POST /course-plan`) ke server sungguhan.
- SIAK: buka file HTML lokal (dump dari `../siak-war/html/`) di Playwright lalu
  panggil method page object langsung — sama seperti resep di
  `../siak-war/AGENTS.md`. Halaman gagal-parse otomatis disimpan ke
  `tmpdir/war-service-html/`.

## Gaya kode

- ESM + `NodeNext`: **import antar file wajib ekstensi `.js`** (`./logger.js`)
  meski sumbernya `.ts`.
- `strict: true`, `noUncheckedIndexedAccess`, tanpa `any`; `unknown` di catch.
- `lib` sengaja memuat `DOM` + `DOM.Iterable` untuk kode `page.evaluate` SIAK —
  jangan dihapus.
- Class page object per halaman (SIAK); helper murni jadi function modul.
- Semua output lewat `emit`/pino, **bukan** `console.log`.
- Pesan log/komentar Bahasa Indonesia informal, konsisten dengan yang ada.
- Komentar hanya untuk menjelaskan **kenapa** (kuirk portal), bukan apa.

## Alur request (referensi cepat)

```
POST /accounts {label,username,password}     → simpan SSO_UI (password plain) → 201 {id}
PATCH /accounts/:id/password {password}      → validasi login dulu, lalu ganti password
POST /api/auth/sign-up/email {email,password,name,phoneNumber}  → better-auth
POST /api/auth/sign-in/email {email,password}                   → cookie sesi
GET  /me/entitlement                          → boleh pakai fitur berbayar atau belum
GET  /periods | /periods/active               → daftar periode + harga berlaku
POST /periods, PATCH /periods/:id             → ADMIN: kelola periode & harga
POST /payments                                → tagihan QRIS dinamis (nominal + kode unik)
GET  /payments/me                             → riwayat tagihan sendiri
GET  /admin/payments?status=PENDING           → ADMIN: antrean verifikasi
POST /admin/payments/:id/review {decision}    → ADMIN: setujui/tolak (manual)

GET  /slcm/status                             → portal SLCM hidup/mati (cache 60s) — FE mematikan
                                                tombol "Perbarui jadwal" saat pemeliharaan
POST /schedules {accountId, provider}         → CHECK_SCHEDULE segera → simpan ke tabel Schedule
GET  /accounts/:id/schedules                  → baca jadwal tersimpan (+ faculty), tanpa scrape

GET  /catalog/periods                         → bucket periode aktif + lastSyncedAt
GET  /catalog/faculties                       → 22 fakultas + jumlah prodi & kelas periode aktif
GET  /catalog/programs?faculty=&q=            → prodi (org_code) + jumlah kelasnya
GET  /catalog/classes?org=&faculty=&q=&page=  → cari kelas (kode/matkul/dosen), berhalaman
POST /accounts/:id/schedules/from-catalog {orgCodes}
                                              → salin katalog jadi Schedule akun (source SLCM)
POST /admin/catalog/sync {accountId}          → ADMIN: tarik periode aktif → 202 {id}
GET  /admin/catalog/syncs[/:id]               → ADMIN: riwayat & progres sinkronisasi

PUT   /accounts/:id/schedules/selection {classIds}         → ganti seluruh pilihan (isChoosed)
PATCH /accounts/:id/schedules/selection {select,deselect}  → ubah sebagian pilihan
POST /wars {accountId,provider,courses,plans?,scheduledAt}
                                              → WarJob(SCHEDULED) + delayed job → 202 {id}
   dispatch: SIAK dan SLCM tepat T — tidak ada proses akun sebelum scheduledAt
   worker: WarJob(RUNNING) → WarRunner.fillIrs() → SUBMITTED|FAILED
           lalu otomatis: WarJob(CHECK_RESULT, parentJobId) delayed → cek kapasitas
GET   /wars/:id                               → status + result (checks[]) + rechecks[]
GET   /wars/:id/events?after=<iso>            → jejak audit per-langkah
PATCH /wars/:id/schedule {scheduledAt}        → reschedule (saat SCHEDULED)
PATCH /wars/:id/courses {courses,plans?}       → ubah seluruh plan (saat SCHEDULED)
POST  /wars/:id/cancel                        → hapus delayed job / publish war-cancel
```
