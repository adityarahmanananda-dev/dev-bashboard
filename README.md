# DevBashboard

`$_` Dashboard lokal untuk developer: scan folder project, deteksi stack & database, atur port anti-tabrakan, lalu start/stop aplikasi (native maupun Docker Compose) langsung dari browser.

## Menjalankan

```bash
npm install
npm start          # buka http://127.0.0.1:7333
```

## Fitur

- **Deteksi database** — engine (PostgreSQL, MySQL, MongoDB, Redis, SQLite, dll.) dan hostingnya: ☁️ online/cloud (Supabase, Neon, Atlas, …), 🐳 docker lokal (dari compose), 🖥️ lokal, atau 📄 file lokal (SQLite). Sumber deteksi: dependencies, `.env`, connection string di source code, `prisma/schema.prisma`, service image di compose, dan file `*.db`/`*.sqlite`.
- **Folder scan bebas** — klik path di kiri atas untuk memilih folder mana pun (browse atau ketik path manual).
- **Deteksi stack otomatis** — Python/Flask/FastAPI/Django, Node/Electron/Next/Vite, Go, HTML statis, Docker Compose; lengkap dengan branch git dan deskripsi dari README.
- **Start/stop dari dashboard** — proses dikelola dalam process group, jadi stop ikut mematikan child process (reloader Flask, `go run`, npm script).
- **Dukungan Docker Compose** — project dengan `docker-compose.yml` langsung punya tombol **Start (Docker)** yang menjalankan `docker compose up -d --build`:
  - Port host dari compose bisa dioverride; dashboard membuat override file otomatis (tag `!override`, butuh Docker Compose v2.24+) di `data/compose-overrides/`.
  - Stop = `docker compose down`; status container dipantau via `compose ps`, dan tetap terlacak walau dashboard di-restart.
  - Project dockerized tetap bisa jalan tanpa docker lewat tombol sekunder **⚡ Native** (mis. `go run ./cmd/server`).
- **File `.env` project dimuat otomatis** untuk start native, jadi mis. `DATABASE_URL` Supabase ikut terbawa.
- **Manajemen port**:
  - Tombol 🎲 mencarikan port kosong acak di rentang 20000–65535.
  - Port bawaan layanan/dev server (postgres 5432, redis 6379, mysql 3306, vite 5173, dst.) **ditolak** saat start.
  - Port yang sudah dipakai proses lain atau project lain yang sedang jalan ditolak dengan pesan siapa pemakainya.
  - Pilihan port per project disimpan (`data/state.json`).
- **Log realtime** per project via WebSocket.

## Cara override port

| Stack | Mekanisme |
|---|---|
| Docker Compose | `docker compose up -d --build` + override file untuk port host |
| Flask yang baca `PORT` env | env `PORT` |
| Flask port hardcoded | `flask --app <entry> run --port <N>` |
| Go (env `ADDR`/`PORT`) | env `ADDR=:<port>` |
| Node (npm dev/start) | env `PORT` |
| Static HTML | `python3 -m http.server <port>` |

Catatan: server dashboard bind di `127.0.0.1` saja (tidak terekspos ke jaringan) dan tidak ada autentikasi — aman untuk pemakaian lokal.
