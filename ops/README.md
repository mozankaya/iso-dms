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
- **İlk açılıştan sonra ~10 dakika bekleyin:** belge sunucusu (ONLYOFFICE) ilk açılıştan 3-4 dakika sonra kendi süreçlerini bir kez yeniden başlatır. O sırada editörde bir doküman açıksa "Bağlantı kesildi" görünür ve yazılanlar kaybolabilir. Kullanıcılara duyurmadan önce kurulumu bir kez kendiniz deneyin; belge sunucusunu yeniden oluşturduktan sonra (güncelleme) de aynısı geçerlidir.


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

## Yedekleme ve geri yükleme

ISO 9001'de kayıtlar (revizyonlar, onaylar, denetim izi) korunmak zorundadır; bu yüzden yedek bir tercih değil, işletmenin parçasıdır.

| Betik | Ne yapar |
|---|---|
| `ops/backup.sh` | Veritabanını (`pg_dump`) ve dosya deposundaki **her dosyayı** tek bir klasöre yedekler: `backups/2026-10-09_020000/` (`db.dump`, `files.tar.gz`, `MANIFEST.json`, `SHA256SUMS`). Uygulama çalışırken alınabilir. Yarım kalan yedek klasörü **görünmez** (`.partial-...`), tam bitmeden adı konmaz. |
| `ops/restore-drill.sh` | **Geri yükleme tatbikatı:** yedeği üretime dokunmadan geçici bir veritabanı ve depoya açar; satır sayılarını yedeğin kayıt anındaki sayılarla, her dosyanın SHA-256'sını veritabanındaki `checksum` ile karşılaştırır, denetim izi koruma tetikleyicilerinin geri geldiğini denetler. Sonunda `DRILL PASSED` ya da `DRILL FAILED`. |
| `ops/restore.sh <klasör>` | Yedeği **üretime geri yükler** (veritabanını değiştirir, dosyaları ekler, hiç dosya silmez). `RESTORE` yazmanızı ister. |
| `ops/dc exec api pnpm exec tsx prisma/verify-storage.ts` | Canlı sistemde her revizyon dosyasını ve PDF kopyasını kayıtlı SHA-256 ile karşılaştırır (salt okunur). |

**Ayarlar** (ortam değişkeni ya da `.env.production`): `BACKUP_DIR` (varsayılan `./backups`), `BACKUP_KEEP_DAYS` (30: bundan eski yedekler silinir), `BACKUP_KEEP_MIN` (3: ne olursa olsun en az bu kadar yedek kalır), `BACKUP_COPY_TO` (ikinci bir yer: bağlanmış ağ paylaşımı, harici disk; bitmiş yedek oraya da kopyalanır ve doğrulanır).

**Günlük otomatik yedek (Linux, `crontab -e`)** — gece 02:00, ayda bir tatbikat:

```cron
0 2 * * *  cd /opt/iso-dms && ops/backup.sh >> /var/log/iso-dms-backup.log 2>&1
30 3 1 * * cd /opt/iso-dms && ops/restore-drill.sh >> /var/log/iso-dms-drill.log 2>&1
```

Kurallar:
- **Aynı diskteki yedek yedek sayılmaz.** Disk ya da sunucu giderse ikisi birlikte gider: `BACKUP_COPY_TO` ile (ya da `rsync`/`rclone` ile) sunucudan **ayrı bir yere** da kopyalayın.
- **Yedekte sırlar yoktur.** `.env.production`'ı ayrıca, güvenli bir yerde saklayın (yedek tek başına ayağa kalkmaz). Yedekte parola özetleri ve tüm dokümanlar vardır: yedeklere erişimi sınırlayın (betik klasörü yalnızca sahibine açık yapar).
- **Tatbikat yapılmamış yedek umuttur.** İlk kurulumdan sonra ve her büyük güncellemeden önce `ops/restore-drill.sh` çalıştırın. Bir yedek `DRILL FAILED` verirse **o yedeğe güvenmeyin**; nedeni çıktıda yazar (bozuk dosya, eksik dosya, sayı farkı).
- Yedek alınırken **taslakta kaydedilen** bir dosya, yedekteki sağlama toplamından farklı çıkabilir (taslak ara kayıtları değişir); yayınlanmış revizyonlar asla değişmez. Gece alın.
- Yedekten sonra yapılanlar geri yüklemede **veritabanından silinir**; yalnızca o güne kadarki durum döner. Geri yükleme öncesi bunu `ops/restore.sh` açıkça yazar.
- Redis, arama dizini ve PDF kuyruğu yedeklenmez: veritabanından ve dosyalardan kendiliğinden yeniden kurulur.

## Sağlık

`GET /api/health` (herkese açık) her parçanın durumunu verir: `database`, `storage`, `redis`, `editor`.
Veritabanı ya da dosya deposu erişilemezse 503, yalnızca kuyruk ya da editör yoksa 200 ve `degraded` döner.
Bir izleme aracından (ör. Uptime Kuma) bu adresi yoklatabilirsiniz.

## Sorun giderme

Önce `ops/dc ps` ve `curl https://kalite.firma.com/api/health` bakın; sonra ilgili servisin günlüğüne (`ops/dc logs --tail 100 <servis>`).

| Belirti | Neden / çözüm |
|---|---|
| `api` hiç kalkmıyor, günlükte "Unsafe production configuration" | `.env.production`'da kısa/`change-me` sır ya da `https://` olmayan adres. Mesaj hangisi olduğunu yazar. `ops/generate-secrets.sh` ile (yeni dosya) sırları yeniden üretmeyin: mevcut veritabanı parolasıyla uyuşmaz; yalnızca ilgili satırı düzeltin. |
| `migrate` hata verip çıkıyor | `ops/dc logs migrate`. Genellikle veritabanı henüz hazır değildir (kendiliğinden yeniden dener: `ops/dc up -d`) ya da `SEED_ADMIN_PASSWORD` örnek değer/12 karakterden kısa. |
| Giriş yapılamıyor, sayfa yenilenince oturum düşüyor | Adres `https://` değil ya da `APP_HOST` ile tarayıcıdaki ad farklı (çerez `Secure`'dır). |
| Tarayıcı sertifika uyarısı veriyor, editör açılmıyor | İç ağ sertifikası: kök sertifikayı istemcilere yükleyin (yukarıda). Genel adda Let's Encrypt alınamıyorsa `ops/dc logs caddy`: ad genel DNS'e ve sunucuya yönlenmeli, 80/443 açık olmalı. |
| Editörde "Yükleme başarısız oldu" | `curl .../api/health` içinde `editor: down` ise `ops/dc logs onlyoffice` (ilk açılış ~5 dk sürer, bellek yetmeyebilir: `docker stats`). Sağlıklıysa `DOCS_HOST` adı istemciden çözülmüyordur. |
| Onaya gönderme "editör sunucusuna ulaşılamadı" | Belge sunucusu (`onlyoffice`) çalışmıyor; kayıp olmasın diye gönderim bilerek durdurulur. |
| E-posta bildirimleri gitmiyor | `SMTP_HOST` boşsa hiç gönderilmez (bildirimler uygulamada kalır). Doluysa `ops/dc logs api | grep -i mail`. |
| Arama yeni yayınlanan dokümanın içeriğini bulmuyor | Dizinleme birkaç saniye sürer; olmadıysa 10 dakikada bir kendiliğinden tamamlanır ya da `ops/dc exec api pnpm exec tsx prisma/backfill-search.ts`. |
| Yayınlanmış doküman için "PDF hazırlanıyor" bitmiyor | Editör sunucusu yoksa PDF yapılamaz; ayağa kalkınca kendiliğinden denenir. Başarısızsa kalite yöneticisi arayüzden **PDF Oluştur**. |
| Disk doluyor | `docker system df`; `backups/` klasörü (saklama süresini `BACKUP_KEEP_DAYS` ile kısaltın, ikinci kopyayı başka yere alın); eski imajlar için `docker image prune`. |
| Her şey bozuldu | Sakin olun: `ops/dc down` (veriler kalır) ve `ops/dc up -d --build`. Veri bozulduysa `ops/restore-drill.sh` ile son yedeği deneyin, sonra `ops/restore.sh`. |

## Güvenlik notları

- `.env.production` tüm sırları içerir: yedeğini **güvenli bir yerde** (parola yöneticisi) tutun, repoya koymayın. Dosya kaybolursa
  yeniden üretilen veritabanı ve dosya deposu parolaları mevcut verilerle uyuşmaz, sunucu açılmaz; JWT sırları
  değişirse yalnızca herkesin oturumu kapanır.
- Uygulama, sırlar `change-me` ya da 24 karakterden kısa ise, adresler `https://` değilse **başlamaz** (neden günlükte yazar).
