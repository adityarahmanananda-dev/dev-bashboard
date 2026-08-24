# DevBashboard

```
$_  DevBashboard
```

Dashboard lokal untuk developer: scan folder project, deteksi **stack** dan **database**, atur **port anti-tabrakan**, lalu **start/stop aplikasi** — native maupun Docker Compose — langsung dari browser.

Semua berjalan di `127.0.0.1` (tidak terekspos ke jaringan), tanpa akun, tanpa cloud.

---

## Fitur

### 📁 Scan folder bebas
Klik path di kiri atas dashboard untuk memilih folder mana pun yang mau discan (browse atau ketik path manual). Bisa juga lewat CLI:

```bash
dev-bashboard --root ~/Projects
```

### 🔍 Deteksi stack otomatis
Setiap project terdeteksi framework-nya, branch git, dan deskripsi dari README:

| Bahasa/Framework | Cara deteksi |
|---|---|
| Python (Flask, FastAPI, Django) | `app.py`, `manage.py`, import di source, `requirements.txt` |
| Go | `go.mod` di root maupun nested (`backend/`, `server/`, dll.) |
| Node.js (Express, Electron, Next.js, Vite, React…) | `package.json` + dependencies |
| Docker Compose | `docker-compose.yml` / `compose.yaml` → tombol **Start (Docker)** |
| HTML/CSS/JS statis | `index.html` tanpa kode backend |

Project yang punya compose file mendapat tombol **▶ Start (Docker)** (`docker compose up -d --build`) plus tombol sekunder **⚡ Native** untuk jalan tanpa docker.

### 🗄 Deteksi database
Badge per project menampilkan engine **dan** hosting-nya:

| Badge | Arti |
|---|---|
| `PostgreSQL · ☁️ Supabase` | DB online/cloud (host dikenali: Supabase, Neon, Atlas, RDS, Railway, dll.) |
| `MySQL · 🐳 docker lokal` | Service DB didefinisikan di compose |
| `PostgreSQL · 🖥️ lokal` | Koneksi ke localhost / host non-cloud |
| `SQLite · 📄 file lokal` | File `*.db`/`*.sqlite` atau driver SQLite |

Sumber deteksi: dependencies, `.env`, connection string di source code, `prisma/schema.prisma`, image service di compose.

### 🔌 Manajemen port anti-tabrakan
- Tombol **🎲 cari** mencarikan port kosong acak di rentang **20000–65535**
- Port bawaan layanan/dev server (postgres `5432`, mysql `3306`, redis `6379`, node dev `3000`, vite `5173`, dll.) **ditolak keras** saat start
- Port yang sudah dipakai proses lain ditolak dengan pesan siapa pemakainya:
  > `Port 56002 sudah dipakai oleh python3 (pid 8805)`
- Pilihan port per project diingat antar-restart (`data/state.json`)
- Sidebar menampilkan semua port yang sedang listening beserta prosesnya

### ⚙️ Start/stop yang rapi
- Proses dikelola per **process group** → stop ikut mematikan reloader Flask, child binary `go run`, dan wrapper npm script
- Status project tetap terlacak walau dashboard dimatikan lalu dijalankan lagi (proses native diadopsi via pgid, container docker dicek via `compose ps`)
- Log realtime tiap project via WebSocket

### 🐳 Dukungan Docker Compose
- Start = `docker compose up -d -‑build` dengan nama project unik (`-p`)
- **Override port host otomatis**: ganti port di dashboard → DevBashboard membuat override file dengan tag `!override` di `data/compose-overrides/` (butuh Docker Compose v2.24+), sehingga file asli project tidak disentuh
- Stop = `docker compose down`
- File `.env` project dimuat otomatis saat start native — `DATABASE_URL` Supabase dsb. ikut terbawa

### 🐍 Venv manager + tombol Setup
- Tiap project Python dapat venv sendiri dengan format **`<nama-app>.venv`** di dalam folder project
- Kartu project menampilkan status: file dependencies (requirements.txt / pyproject.toml), ada/tidaknya venv, dan kelengkapan deps (dicek via `pip install --dry-run`)
- Tombol **🛠 Setup** membuat venv lalu menjalankan `pip install` bertahap, lengkap dengan log realtime; bisa dibatalkan via **■ Stop Setup**
- Start akan ditolak dengan pesan jelas bila manifest dependencies ada tetapi venv belum dibuat — tidak ada lagi kegagalan senyap karena modul hilang

---

## Instalasi

Prasyarat:
- **Node.js ≥ 18**
- **Docker + Docker Compose v2.24+** *(opsional, hanya untuk fitur compose)*

```bash
git clone git@github.com:adityarahmanananda-dev/dev-bashboard.git
cd dev-bashboard
npm install
npm link          # daftarkan perintah global "dev-bashboard"
```

> Tanpa `npm link` juga bisa: `npm start` lalu buka `http://127.0.0.1:7333`.

## Cara pakai

```bash
dev-bashboard                     # start + buka browser otomatis
dev-bashboard -p 8080             # port khusus untuk dashboard
dev-bashboard -r ~/kode           # set folder awal yang discan
dev-bashboard --no-open           # tanpa auto-buka browser
dev-bashboard --help              # bantuan
dev-bashboard --version
```

Browser akan terbuka otomatis ke `http://127.0.0.1:<port>` (via `xdg-open`). Tekan `Ctrl+C` untuk menghentikan dashboard; project yang sedang berjalan **tidak** ikut mati dan akan diadopsi kembali saat dashboard dijalankan lagi.

## Cara kerja override port

| Stack | Mekanisme override |
|---|---|
| Docker Compose | Override file compose (`ports: !override`) |
| Flask yang baca env | env `PORT` |
| Flask port hardcoded | `flask --app <entry> run --port <N>` |
| Go (env `ADDR`/`PORT`) | env `ADDR=:<port>` |
| Node (npm dev/start) | env `PORT` |
| Static HTML | `python3 -m http.server <port> --bind 127.0.0.1` |

Kalau mekanisme tidak dikenali (mis. port hardcoded tanpa flask CLI), kartu project menampilkan peringatan bahwa port mengikuti kode.

## Arsitektur

```
dev-bashboard/
├── bin/dev-bashboard.js   CLI launcher (arg parsing, xdg-open)
├── server/
│   ├── index.js           HTTP server + REST API + WebSocket
│   ├── scanner.js         Deteksi stack, database, start recipe
│   ├── runner.js          Lifecycle proses (spawn/pgid/adopsi/persist)
│   ├── docker.js          Helper compose: up/status/down/log/override
│   ├── ports.js           Cek listening, reserved list, sugesti port
│   └── state.js           Persistensi state (folder scan, pilihan port)
├── public/                Frontend vanilla JS (tanpa build step)
└── data/                  Runtime only (di-gitignore): log, state, overrides
```

API ringkas:

| Endpoint | Fungsi |
|---|---|
| `GET /api/projects` | Scan + status semua project |
| `POST /api/projects/:name/start` | Start `{ port, native? }` |
| `POST /api/projects/:name/stop` | Stop / compose down |
| `GET /api/projects/:name/logs` | Ambil log |
| `GET /api/ports/used` · `POST /api/ports/suggest` | Info & sugesti port |
| `GET /api/browse` · `POST /api/scan-root` | Folder picker |

## Catatan

- Server bind di `127.0.0.1` saja dan **tanpa autentikasi** — memang untuk pemakaian lokal.
- `data/` tidak ikut repo; PC baru mulai dengan state bersih.
- Project tanpa cara start yang dikenali (catatan, library) tetap muncul sebagai referensi, hanya tanpa tombol start.
