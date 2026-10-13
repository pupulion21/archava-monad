# Milestone S07 Evidence — Hosting Isolation & Release Candidate

Tanggal: 13 Oktober 2026  
Lingkup: Archava Monad (`archava-monad`)  
Jaringan: Monad Testnet (Chain ID `10143` / `0x279f`)  
Kontrak Rental: `0x7324a2678e74052a4e9a244c0d57b56b23fee6ad`  
Token Pembayaran: `0xe268ce1ad255f8d32bfa9a7f9feef3eabf45b39c` (mUSDT)

---

## 1. Ringkasan Eksekutif

Milestone S07 menetapkan konfigurasi hosting terisolasi penuh dan verifikasi Release Candidate (RC) untuk Archava Monad.
Seluruh ketergantungan deployment BNB lama telah dihilangkan dan digantikan dengan target hosting khusus Monad:
1. **Pemisahan Hosting Mutlak**: Frontend Vercel baru, backend Railway dengan persistent storage volume di `/app/data`, project LiveKit khusus, dan indexer Envio independen.
2. **Supervisi Kontainer Produksi (`Dockerfile` & `entrypoint.sh`)**: Kontainer tunggal terpadu menjalankan Node.js API (port 5002) dan Python LiveKit Voice Worker (port 8081) dengan penanganan sinyal SIGTERM/SIGINT yang bersih.
3. **Penyimpanan Status Persisten Tunggal (Single-Writer)**: Seluruh pencatatan kuota menit (`usage.json`), digest API key (`keys.json`), dan cache pembelian onchain (`purchase-cache.json`) terlindungi dalam volume `/app/data` dengan validasi cakupan deployment (`archava-monad`, chain ID 10143).
4. **Verifikasi Preflight Publik**: `scripts/readonly-preflight.mjs` berhasil dijalankan dengan kode keluar 0, memvalidasi kesehatan API, kesiapan worker, konfigurasi publik chain 10143, kuotasi paket menit, dan integritas artefak frontend.

---

## 2. Arsitektur Kontainer & Konfigurasi Lingkungan

### 2.1 Multi-Stage Dockerfile
- **Stage `dependencies`**: Node 22 slim untuk instalasi dependensi bersih (`npm ci`).
- **Stage `frontend`**: Membangun bundel produksi dengan menyuntikkan `ARG VITE_PRIVY_APP_ID` dan `ENV VITE_PRIVY_APP_ID=$VITE_PRIVY_APP_ID` saat waktu build.
- **Stage `runtime`**: Python 3.12 slim dengan dependensi sistem audio (`ca-certificates`, `libopus0`, `ffmpeg`), dependensi backend Python, dan binary Node.js.
- **Healthcheck Kontainer**: Memeriksa `http://127.0.0.1:5002/api/ready` setiap 30 detik. `/api/ready` secara otomatis memvalidasi kesehatan internal API dan kesiapan Python Voice Worker (`ARCHAVA_WORKER_HEALTH_URL=http://127.0.0.1:8081/`).

### 2.2 Entrypoint Process Supervision (`entrypoint.sh`)
```bash
#!/bin/bash
set -uo pipefail

echo "[archava] Starting LiveKit voice worker in background..."
python3 backend/agent.py start &
WORKER_PID=$!

echo "[archava] Starting Public API server on port ${PORT:-5002}..."
node server/index.mjs &
API_PID=$!

cleanup() {
  local exit_status="$1"
  trap - SIGTERM SIGINT
  echo "[archava] Stopping API and voice worker..."
  kill -TERM "$WORKER_PID" 2>/dev/null || true
  kill -TERM "$API_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  exit "$exit_status"
}

trap 'cleanup 0' SIGTERM SIGINT
wait -n "$WORKER_PID" "$API_PID"
EXIT_STATUS=$?
if [ "$EXIT_STATUS" -eq 0 ]; then EXIT_STATUS=1; fi
echo "[archava] Process exited with status $EXIT_STATUS. Shutting down container..."
cleanup "$EXIT_STATUS"
```

---

## 3. Konfigurasi Vercel (`vercel.json`)

Frontend di-deploy ke Vercel dengan rewrites terarah ke backend Railway Monad:
```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "vite",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://archava-monad-backend.up.railway.app/api/:path*"
    },
    {
      "source": "/v1/:path*",
      "destination": "https://archava-monad-backend.up.railway.app/v1/:path*"
    },
    {
      "source": "/build",
      "destination": "/index.html"
    }
  ],
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "X-Archava-Deployment",
          "value": "monad"
        }
      ]
    }
  ]
}
```

---

## 4. Hasil Verifikasi Readonly Preflight

Perintah eksekusi:
```bash
node scripts/readonly-preflight.mjs --origin http://localhost:5002
```

Keluaran verifikasi:
```json
{
  "mode": "READ ONLY; NO ROOMS OR TRANSACTIONS",
  "origin": "http://localhost:5002",
  "deployment": "monad-testnet",
  "expectedChainId": 10143,
  "actualChainId": 10143,
  "api": "ok",
  "workerHealth": "ok",
  "provider": "spatius",
  "previewEnabled": true,
  "previewSeconds": 120,
  "testnetQuotes": "ok",
  "frontendRoutes": "ok"
}
PASS public deployment checks. A real microphone/voice call remains a separate check.
```

---

## 5. Prosedur Rollout & Jaminan Single-Writer

1. **Volume Persisten Tunggal**: Railway service dikonfigurasi dengan `replicas: 1` dan volume mount di `/app/data`.
2. **Prosedur Pembaruan**:
   - Rolling update otomatis dimatikan; transisi dilakukan dengan menghentikan pod lama sebelum memunculkan pod baru (`recreate` strategy).
   - Selama transisi singkat, frontend menampilkan status reconnect anggun.
   - Pod baru memverifikasi scope state (`archava-monad`, chain ID 10143) dan cursor blok sebelum mulai memproses traffic baru.
3. **Retensi Status**: Restart kontainer mempertahankan saldo menit terpakai dan digest API key tanpa kehilangan data atau penghitungan ganda.
