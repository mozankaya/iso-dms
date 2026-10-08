# Canlıya alma (üretim)

Bu klasör, uygulamayı tek bir sunucuda Docker ile çalıştırmak için gerekenleri içerir. Geliştirme ortamı değildir
(onun için kökteki `docker-compose.yml` ve `pnpm dev`).

| Dosya | Ne işe yarar |
|---|---|
| `../docker-compose.prod.yml` | Tüm yığın: Caddy (ters vekil, tek açık kapı), web, API, PostgreSQL, RustFS, Redis, ONLYOFFICE |
| `../.env.production.example` | Ayar şablonu; `.env.production` olarak kopyalanır (repoya girmez) |
| `generate-secrets.sh` | `.env.production`'ı rastgele sırlarla üretir |
| `dc` | `docker compose` kısayolu: `ops/dc up -d --build`, `ops/dc ps`, `ops/dc logs -f api` |
| `caddy/Caddyfile` | Genel alan adı: Let's Encrypt sertifikası |
| `caddy/Caddyfile.internal` | İç ağ: Caddy'nin kendi sertifika otoritesi |

## Gerekenler

- Linux sunucu, Docker Engine ve Compose v2. ONLYOFFICE için **en az 8 GB bellek** önerilir (tek başına ~4 GB).
- **İki ad** aynı sunucuya çıkmalı: uygulama (`kalite.firma.com`) ve belge sunucusu/editör (`docs.kalite.firma.com`).
  Genel adlarda 80 ve 443 numaralı kapılar internetten açık olmalı (Let's Encrypt için); iç ağda iç DNS ya da
  istemcilerin `hosts` dosyası yeterlidir.
- Dışarıya **yalnızca 80 ve 443** açılır. Veritabanı, dosya deposu, Redis ve ONLYOFFICE başka kapı açmaz.

## İlk kurulum

```bash
git clone <depo> iso-dms && cd iso-dms
ops/generate-secrets.sh          # .env.production oluşur (yalnızca sizin okuyabileceğiniz izinle)
nano .env.production             # APP_HOST, DOCS_HOST, CADDYFILE, SEED_* ve istenirse SMTP_* değerlerini girin
ops/dc up -d --build             # imajlar derlenir (birkaç dakika); ONLYOFFICE'in ilk açılışı ~5 dk sürer
ops/dc ps                        # hepsi "healthy"/"running" olmalı
curl https://kalite.firma.com/api/health
```

- İlk yönetici: `SEED_ADMIN_EMAIL` ve `SEED_ADMIN_PASSWORD`. İlk girişte yeni bir parola seçmek **zorunludur**.
  Sonra `.env.production` içindeki `SEED_ADMIN_PASSWORD` satırını silebilirsiniz (yalnızca ilk kurulumda kullanılır).
- **İç ağ (`CADDYFILE=Caddyfile.internal`):** tarayıcılar Caddy'nin kök sertifikasına bir kez güvenmelidir:
  `ops/dc cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt` ile alıp istemcilere yükleyin
  (Windows: "Güvenilen Kök Sertifika Yetkilileri"). Aksi halde tarayıcı sertifika uyarısı verir ve editör açılmaz.
- Sunucu açılışında her şey kendiliğinden başlar (`restart: unless-stopped`).

## Güncelleme

```bash
git pull
# .env.production içinde APP_VERSION'ı değiştirin (ör. 2026-10-09): eski sürüme dönebilmek için
ops/dc up -d --build
```

Veritabanı değişiklikleri (`migrate` servisi) her başlatmada kendiliğinden uygulanır; hiçbir mevcut veriyi silmez.
Güncellemeden **önce yedek alın**.

## Günlük işler

```bash
ops/dc ps                        # durum
ops/dc logs -f api               # API günlüğü (web, caddy, onlyoffice ... aynı şekilde)
ops/dc restart api               # bir servisi yeniden başlat
ops/dc down                      # durdur (veriler kalır)
```

> **Dikkat:** `ops/dc down -v` tüm verileri (veritabanı, dosyalar) **siler**. Yalnızca yeni baştan kurmak için kullanın.

## Sağlık

`GET /api/health` (herkese açık) her parçanın durumunu verir: `database`, `storage`, `redis`, `editor`.
Veritabanı ya da dosya deposu erişilemezse 503, yalnızca kuyruk ya da editör yoksa 200 ve `degraded` döner.
Bir izleme aracından (ör. Uptime Kuma) bu adresi yoklatabilirsiniz.

## Güvenlik notları

- `.env.production` tüm sırları içerir: yedeğini **güvenli bir yerde** (parola yöneticisi) tutun, repoya koymayın. Dosya kaybolursa
  yeniden üretilen veritabanı ve dosya deposu parolaları mevcut verilerle uyuşmaz, sunucu açılmaz; JWT sırları
  değişirse yalnızca herkesin oturumu kapanır.
- Uygulama, sırlar `change-me` ya da 24 karakterden kısa ise, adresler `https://` değilse **başlamaz** (neden günlükte yazar).
