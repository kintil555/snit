# ⚡ SnapText — Kirim Teks Instan Antar Perangkat

Transfer teks antar HP, laptop, atau tablet — tanpa akun, tanpa install app. Real-time, terenkripsi AES-GCM.

---

## 🏗️ Arsitektur

```
[Perangkat A]          [Cloudflare Workers]         [Perangkat B]
  Browser    <--WS-->  Durable Object (Room)  <--WS-->  Browser
  (Sender)             WebSocket Relay              (Receiver)
```

- **Frontend**: HTML/JS statis → Cloudflare Pages
- **Backend**: Cloudflare Workers + Durable Objects (WebSocket relay, room management)
- **Enkripsi**: AES-GCM 256-bit, key diturunkan dari Room ID via SHA-256
- **Kode QR**: Berlaku 15 detik, expired otomatis
- **Zero storage**: Tidak ada teks yang disimpan di server

---

## 🚀 Deploy ke Cloudflare

### 1. Prasyarat

```bash
npm install -g wrangler
wrangler login
```

### 2. Deploy Worker (Backend)

```bash
cd snaptext
wrangler deploy
```

Setelah deploy, catat URL worker kamu, contoh:
`https://snaptext-relay.YOUR-SUBDOMAIN.workers.dev`

### 3. Set URL Worker di Frontend

Edit `frontend/index.html`, cari baris ini:

```javascript
return (window.SNAPTEXT_WS_URL || 'wss://snaptext-relay.workers.dev').replace(/\/$/, '');
```

Ganti `snaptext-relay.workers.dev` dengan URL worker kamu:

```javascript
return (window.SNAPTEXT_WS_URL || 'wss://snaptext-relay.YOUR-SUBDOMAIN.workers.dev').replace(/\/$/, '');
```

Begitu juga untuk `SNAPTEXT_API_URL`.

### 4. Deploy Frontend ke Cloudflare Pages

**Via GitHub:**

1. Push repo ini ke GitHub
2. Buka [Cloudflare Dashboard](https://dash.cloudflare.com) → Pages → Create application
3. Connect to Git → pilih repo
4. Build settings:
   - **Framework preset**: None
   - **Build command**: _(kosongkan)_
   - **Build output directory**: `frontend`
5. Deploy!

**Via CLI:**

```bash
cd frontend
wrangler pages deploy . --project-name snaptext
```

### 5. (Opsional) Custom Domain

Di Cloudflare Pages → Custom domains → tambah domain kamu.

---

## 🔐 Keamanan

| Fitur | Detail |
|-------|--------|
| Transport | WSS (TLS) — Cloudflare handles SSL |
| Payload | AES-GCM 256-bit end-to-end encryption |
| Key derivation | SHA-256 dari Room ID (unik per sesi) |
| Session | Kode expired dalam 15 detik |
| Storage | **Tidak ada** — pesan tidak disimpan di server |
| Durable Object | Memory-only, auto-cleanup saat WebSocket close |

---

## 📁 Struktur File

```
snaptext/
├── worker/
│   └── index.js          # Cloudflare Worker + Durable Object
├── frontend/
│   └── index.html        # Single-file frontend app
├── wrangler.toml         # Cloudflare config
└── README.md
```

---

## 🛠️ Development Lokal

Butuh Node.js dan wrangler:

```bash
# Install wrangler
npm install -g wrangler

# Jalankan worker lokal
wrangler dev

# Di terminal lain, serve frontend
npx serve frontend
# atau
python3 -m http.server 3000 --directory frontend
```

Akses di `http://localhost:3000`

---

## 📱 Cara Pakai

### Skenario: HP → Laptop

1. **Laptop**: Buka SnapText → klik **Saya Penerima** → pilih **Laptop/Desktop** → **Buat Kode** → QR muncul
2. **HP**: Buka SnapText → klik **Saya Pengirim** → tab **Scan QR** → arahkan kamera ke QR laptop
3. **HP**: Ketik teks → **Kirim** → teks muncul di laptop seketika ✓

### Skenario: Laptop → HP

1. **HP**: Buka SnapText → **Saya Penerima** → pilih **HP/Tablet** → **Buat Kode** → kode 6 digit muncul
2. **Laptop**: Buka SnapText → **Saya Pengirim** → tab **Kode Angka** → masukkan kode → **Hubungkan**
3. **Laptop**: Ketik/tempel teks → **Kirim** → teks muncul di HP ✓

---

## ⚙️ Konfigurasi Worker (wrangler.toml)

```toml
name = "snaptext-relay"
main = "worker/index.js"
compatibility_date = "2024-09-23"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]
```

---

## 📝 Notes

- Durable Objects tersedia di **Cloudflare Workers Paid plan** ($5/bulan) atau Workers Free dengan batas tertentu
- QR Code menggunakan library `qrcodejs` dan scanner menggunakan `jsQR` (keduanya via CDN)
- Untuk produksi, pertimbangkan menambah rate limiting di worker
