# Kullanıcı Kılavuzu — Kalite Doküman Yönetim Sistemi

Bu kılavuz, sistemi kullanan herkes içindir. Teknik kurulum için `ops/README.md`'ye bakın.

## 1. Giriş ve roller

Adres çubuğuna sistemin adresini yazın, e-posta ve şifrenizle girin. Yöneticiniz size **geçici bir şifre** verdiyse, ilk girişte kendi şifrenizi seçmeniz istenir (en az 10 karakter); bundan sonra sistemi kullanabilirsiniz. Şifrenizi istediğiniz zaman üst çubuktaki **Şifremi değiştir** bağlantısından değiştirebilirsiniz. Yanlış şifreyi art arda denerseniz bir süre beklemeniz gerekir.

Ne yapabileceğiniz **rolünüze** bağlıdır:

| Rol | Ne yapar |
|---|---|
| **Okuyucu** | Yürürlükteki (yayındaki) dokümanları görür, arar, indirir; geri bildirim gönderir. |
| **Editör** | Okuyucunun yaptıklarına ek olarak **kendi biriminde** doküman oluşturur, düzenler, onaya gönderir, revizyon başlatır. |
| **Birim onaylayıcısı** | Editörün yaptıkları + kendi biriminin dokümanlarını onaylar (1. adım). |
| **Kalite yöneticisi** | Her birimde çalışır; son onayı verir (2. adım), geri bildirimleri ve denetim izini görür. |
| **Yönetici** | Her şey + kullanıcı, birim, kategori ve şablon yönetimi. |

Üst çubuktaki **zil** size gelen işleri gösterir (onayınızı bekleyen doküman, sonuçlanan talebiniz, gözden geçirme zamanı). SMTP ayarlıysa aynı mesajlar e-postayla da gelir.

## 2. Doküman bulmak

- **Kategoriler** (sol menü): her kategori bir klasördür (Prosedürler, Talimatlar, Formlar ...). İçinde arama, birim süzgeci, sıralama ve sayfalama vardır.
- **Listeler:** *Yeni Yayınlananlar*, *Revize Edilenler* (son 7/30/90 gün ya da tümü), *Yayından Kaldırılanlar* (okuyucuya gösterilmez), *Gözden Geçirme* (sizin sorumluluğunuzdaki, zamanı gelen dokümanlar).
- **Arama (üst çubuktaki kutu):** dokümanların **içeriğinde**, kodunda ve adında arar; yalnızca yürürlükteki sürümler aranır.
  - Yazdığınız kelimelerin **hepsi** geçmelidir: `saklama süresi`.
  - Birebir ifade için tırnak kullanın: `"saklama süresi"` (kelimeler yan yana ve bu sırayla).
  - Türkçe karakter ve büyük/küçük harf önemli değildir: `SIKAYET` yazarsanız "Şikâyet"i de bulur.
  - Kelimenin başını yazmanız yeter: `prosedur` → "prosedürler". (Kelime sonlarındaki değişiklikler, örneğin `kaydı`, `kayıt` aramasında çıkmaz.)
  - Sonuçta eşleşen yerler işaretli gösterilir; birim ve kategoriyle daraltabilirsiniz.
- **Doküman sayfası:** kod, birim, sorumlu, yürürlükteki revizyon, tarihler ve **revizyon geçmişi**. **İndir** düğmesi Word/Excel dosyasını, **PDF** düğmesi okuma amaçlı PDF kopyasını verir (PDF yayından sonra birkaç dakika içinde hazırlanır).

Durum etiketleri: **Taslak** (hazırlanıyor), **Onayda**, **Yayında**, **GEÇERSİZ** (yayından kaldırılmış ya da yerine yenisi yayınlanmış). Geçersiz bir dokümanı yalnızca yetkililer görür ve kullanmamak gerekir.

## 3. Yeni doküman hazırlamak (editör)

1. Sol menüden kategoriyi açın, **Yeni Doküman**'a basın.
2. Doküman adını yazın; dosya türünü (Word/Excel) ve şablonu seçin ya da **mevcut bir dosyayı yükleyin** (`.docx`/`.xlsx`, en çok 25 MB). Birim sizin biriminize kilitlidir.
3. **Doküman Oluştur**'a basınca doküman **otomatik bir kodla** (örn. `PR-KK-001`) açılır ve doğrudan **editörde** karşınıza gelir.
4. Editör Word/Excel gibi çalışır. Çalışmanız kendiliğinden kaydedilir; **Ctrl+S** ile hemen kaydedebilirsiniz. Başlık tablosundaki kod, ad, birim, revizyon no ve hazırlayan alanları **sistem tarafından** doldurulur; bunları elle değiştirmeyin (onaya gönderilirken düzeltilir).
5. İşiniz bitince editörü kapatın ve **Onaya Gönder**'e basın.

Taslakta yaptığınız kayıtlar yeni revizyon numarası almaz; numara, onaylanıp yayınlanan her sürümle artar.

## 4. Onaya gönderme ve onay

- **Onaya Gönder:** doküman sayfasındaki düğme (ya da editördeki bağlantı). Editörü kapatmadan gönderemezsiniz; sistem son değişikliklerin kaydedilmesini bekler. Onaydayken dosya **kilitlenir**, düzenlenemez.
- **Onay iki adımdır:** önce **dokümanın biriminin onaylayıcısı**, sonra **kalite yöneticisi**. Sırası gelen kişiye bildirim gider.
- **Onaylayan:** sol menüdeki **Onaylarım** sayfasında bekleyenleri görür. **İncele** ile dokümanı açar, **Onayla** ya da **Reddet** der. **Reddederken gerekçe zorunludur**; red olunca doküman taslağa döner, hazırlayan gerekçeyi okuyup düzeltir ve yeniden gönderir.
- **Kendi hazırladığınız dokümanı siz onaylayamazsınız** (rolünüz ne olursa olsun). Başkası onaylamalıdır.
- **Geri çekme:** kimse karar vermeden önce gönderen kişi talebi geri çekebilir; doküman yeniden düzenlenebilir olur.
- Son onayla doküman **yürürlüğe girer**: herkes görür, PDF kopyası hazırlanır, önceki sürüm GEÇERSİZ olur.

## 5. Yürürlükteki dokümanı güncellemek (revizyon)

1. Doküman sayfasında **Revizyon Başlat**'a basın ve **değişikliğin açıklamasını** yazın (zorunludur; onaylayanlar bunu görür).
2. Yürürlükteki dosyanın kopyası yeni bir taslak olarak editörde açılır. Okuyucular bu sırada eski sürümü görmeye devam eder.
3. Düzenleyin ve yine **Onaya Gönder**. Onaylanınca yeni sürüm yürürlüğe girer, eskisi GEÇERSİZ olur.
- **Vazgeçmek:** başlattığınız revizyondan vazgeçebilirsiniz (gerekçe yazılır); taslak silinmez, kayıtta kalır.
- **Ne değişti?** Revizyon geçmişindeki **Öncekiyle karşılaştır** iki sürümün metin farkını gösterir (eklenen yeşil, silinen üstü çizili kırmızı). Biçim ve görsel farkları gösterilmez.

## 6. Yayından kaldırma

Artık kullanılmayacak bir doküman için doküman sayfasından **Yayından Kaldırma Talebi** açın ve gerekçe yazın. Aynı iki adımlı onaydan geçer; onay beklerken doküman yayında kalır. Onaylanınca doküman **GEÇERSİZ** olur ve okuyuculara gösterilmez. **Hiçbir şey silinmez:** dosya ve revizyonlar kayıt olarak saklanır ve yetkililer görebilir.

## 7. Periyodik gözden geçirme

Dokümanların belirli aralıkla (örn. 12 ayda bir) gözden geçirilmesi gerekebilir. Sorumlu kişi (doküman sorumlusu, birimin onaylayıcısı, kalite yöneticisi) **Periyodu Ayarla** ile süreyi belirler. Zamanı yaklaşınca ve geçince **bildirim** gelir; doküman yayında kalır ama uyarı gösterilir.
Gözden geçirdiyseniz ve değişiklik gerekmiyorsa **Gözden Geçirildi**'ye basın (isteğe bağlı not yazılır); süre baştan başlar. Değişiklik gerekiyorsa revizyon başlatın. Her iki işlem de denetim izine yazılır.

## 8. Geri bildirim

Yürürlükteki bir dokümanda hata, eksik ya da öneri görürseniz doküman sayfasının altındaki **Geri Bildirim** kutusuna yazın (en az 3 karakter). Mesaj kalite yönetimine gider; kalite yöneticisi **Yönetim → Geri Bildirimler** sayfasında görür, ele alınca kapatır (isteğe bağlı notla). Gönderdiğiniz mesaj kayıttır, sonradan değiştirilemez.

## 9. Yönetici ve kalite yöneticisi için

Sol menüdeki **Yönetim** bölümü (yetkinize göre):
- **Kullanıcılar:** ekleme, rol/birim değiştirme, **kullanımdan kaldırma** (kullanıcı silinmez), şifre sıfırlama. Geçici şifre **yalnızca bir kez** gösterilir; kullanıcıya iletin, ilk girişte değiştirecektir. Editör ve onaylayıcı bir birime bağlı olmalıdır. Son yönetici kaldırılamaz.
- **Birimler ve Kategoriler:** ekleme ve ad değiştirme. **Birim kodu ve kategori öneki sonradan değişmez** (doküman kodlarına girer). Kullanımdan kaldırılan birim/kategori seçicilerde görünmez, mevcut dokümanlar etkilenmez. Kategoride varsayılan gözden geçirme periyodu verilebilir.
- **Şablonlar:** Word/Excel şablonları. Bir dosya türünün son şablonu silinemez. Başlık alanlarının (doküman kodu, ad, birim, revizyon no, hazırlayan) sistem tarafından otomatik doldurulması için şablonda her alan işaretlenir; tabloda "Dosya Alanları" sütunu hangilerinin bulunduğunu gösterir. Hazır "Standart Antetli" Word ve Excel şablonları bunları zaten içerir. Kendi şablonunuzda:
  - **Word:** alanın yeri için *içerik denetimi* eklenir (Geliştirici sekmesi) ve **etiketi** `DOC_CODE`, `DOC_TITLE`, `DOC_DEPARTMENT`, `DOC_REVISION_NO` ya da `DOC_PREPARED_BY` yapılır.
  - **Excel:** alanın yeri olacak **tek bir hücre** seçilir ve **adı** aynı değerlerden biri yapılır: *Formüller → Ad Yöneticisi → Yeni* (ya da hücre seçiliyken formül çubuğunun solundaki ad kutusuna adı yazıp Enter). Birden çok hücreyi kapsayan bir ad alan sayılmaz; formül içeren hücreye yazılmaz. Bu hücreleri elle değiştirmeyin: sistem onaya gönderirken doğru değerle yeniden yazar.
  Dosya, doküman oluşturulurken, revizyon başlatılırken ve onaya gönderilirken doldurulur; onaya gönderildikten sonra değişmez (onaylanan dosya yayınlanan dosyadır).
- **Denetim İzi** (kalite yöneticisi ve yönetici): kim, ne zaman, hangi dokümanda ne yaptı; arama, işlem ve tarih süzgeçli. Kayıtlar **değiştirilemez ve silinemez**. Doküman sayfasındaki **Doküman Geçmişi** o dokümanın kayıtlarını gösterir.
- **Geri Bildirimler:** açık mesajlar, kapatma ve yeniden açma.

## 10. Sorun giderme

| Belirti | Ne yapmalı |
|---|---|
| **"Yükleme başarısız oldu"** (editör) | Editör sunucusu kapalı ya da dosya depoda yok. Birkaç dakika sonra yeniden deneyin; sürerse yöneticiye bildirin. |
| **Onaya göndermede "açık düzenleme oturumu"** | Birisi dokümanı editörde açık tutuyor ya da son kayıt henüz gelmedi. Editörü kapatıp birkaç saniye bekleyin, yeniden deneyin. |
| **Onaya göndermede "editör sunucusuna ulaşılamadı"** | Editör sunucusu çalışmıyor; kayıp olmasın diye gönderim durduruldu. Yöneticiye bildirin. |
| **Doküman listede yok / açılmıyor** | Taslak ve onaydaki dokümanları yalnızca kendi biriminizin editörleri ve onaylayıcılar görür. Yetkiniz yoksa doküman "bulunamadı" der. |
| **Kendi dokümanımı onaylayamıyorum** | Kural böyle: hazırlayan onaylayamaz. Başka bir onaylayıcı/kalite yöneticisi gerekir. |
| **"Bu işlem için yetkiniz yok"** | Rolünüz bu işleme izin vermiyor; yöneticiye danışın. |
| **PDF düğmesi yok / "hazırlanıyor"** | PDF yayından sonra arka planda hazırlanır; birkaç dakika bekleyin. Hazırlanamadıysa kalite yöneticisi **PDF Oluştur** ile yeniden ister. |
| **Şifremi unuttum** | Yöneticiden **Şifreyi Sıfırla** isteyin; geçici şifre verecek, ilk girişte değiştireceksiniz. |
