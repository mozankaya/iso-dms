# Uçtan uca duman testi (Playwright)

Gerçek tarayıcıyla, gerçek yığına karşı (taklit yok) bir dokümanın bütün hayatını dener: yeni yönetici parola seçer, kişiler oluşturulur, editör doküman yaratıp onaya gönderir, birim onaylayıcısı ve kalite yöneticisi onaylar, doküman yürürlüğe girer; aranır, açılır, indirilir; denetim izinde görünür.

Test, **üretim yığınına** (`docker-compose.prod.yml`) vekil üzerinden (`https://localhost`) bağlanır; yani Dockerfile'lar, ters vekil, `migrate`/seed, üretim denetimleri (güvenli çerez, zorunlu parola değişimi) de denenmiş olur. CI'da (`.github/workflows/ci.yml`, `e2e` işi) her push'ta çalışır.

## Yerelde çalıştırma

```bash
ops/generate-secrets.sh
sed -i -e 's/^APP_HOST=.*/APP_HOST=localhost/' -e 's/^DOCS_HOST=.*/DOCS_HOST=docs.localhost/' \
       -e 's/^CADDYFILE=.*/CADDYFILE=Caddyfile.internal/' -e 's/^LOGIN_RATE_LIMIT=.*/LOGIN_RATE_LIMIT=1000/' .env.production

# Editör sunucusu yerine küçük bir taklit (gerçeğini çekmek dakikalar ve gigabaytlar alır; test editörde bir şey düzenlemez)
docker compose --env-file .env.production -f docker-compose.prod.yml -f e2e/docker-compose.e2e.yml up -d --build caddy onlyoffice

pnpm --filter @iso-dms/e2e exec playwright install chromium     # bir kez
E2E_ADMIN_PASSWORD="$(grep '^SEED_ADMIN_PASSWORD=' .env.production | cut -d= -f2)" pnpm --filter @iso-dms/e2e e2e
```

İş bitince `docker compose --env-file .env.production -f docker-compose.prod.yml -f e2e/docker-compose.e2e.yml down -v` ve `.env.production`'ı silin (geliştirme yığınına dokunmaz: proje adı `iso-dms-prod`).

## Ayarlar

| Değişken | Anlamı |
|---|---|
| `E2E_BASE_URL` | Uygulamanın adresi (varsayılan `https://localhost`) |
| `E2E_ADMIN_EMAIL` | İlk yönetici (`SEED_ADMIN_EMAIL`, varsayılan `admin@example.com`) |
| `E2E_ADMIN_PASSWORD` | İlk parolası (`SEED_ADMIN_PASSWORD`) |
| `E2E_ADMIN_NEW_PASSWORD` | Testin ilk girişte seçeceği (sonra kullanacağı) parola |

- **Giriş hız sınırı:** test kısa sürede çok oturum açar; yığın `LOGIN_RATE_LIMIT=1000` ile kalkmalıdır (yukarıdaki `sed`).
- **Tekrar çalıştırma güvenlidir:** ilk giriş adımı, parola daha önce değiştirildiyse kendini atlar; her çalıştırma kendi kişilerini (`...@e2e.test`) yaratır ve sonunda kullanımdan kaldırır.
- **Taklit editör (`stub-editor/server.js`)** yalnızca belge sunucusunun sağlık ve komut uçlarını yanıtlar. Onaya gönderme açık editör oturumu olup olmadığını belge sunucusuna sorduğu için bir yanıt vericisi gerekir. Test, dokümanı açınca tarayıcıyı editöre götüren `editor/config` isteğini kasten düşürür (oturum açılıp dosya kilitlenmesin diye). **Gerçek editörün** açma, düzenleme ve kaydetme akışı CI'da değil, elle doğrulanır (`docs/PROJECT.md` 7.4).
- Başarısızlıkta `e2e/test-results` (ekran görüntüsü, iz) ve `e2e/playwright-report` oluşur; `pnpm exec playwright show-trace <iz.zip>` ile bakılır.
