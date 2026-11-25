# İlaç Sipariş Takip – Masaüstü Uygulaması

Mevcut `siparis_takip_duzenlendi.html` sayfasının masaüstü programı (Electron) hâlidir.
Sipariş / bütçe / fiili takibi, raporlar ve Excel çıktıları aynen çalışır.

## Özellikler
- **Otomatik kayıt:** Her değişiklik ~0,4 sn içinde diske yazılır. Program kapanırken bekleyen değişiklik de kaydedilir.
- **Son kayıt zamanı:** Ekranın üst çubuğunda `💾 Son kayıt: gg.aa.yyyy ss:dd:ss` olarak görünür (ortak alan durumu da yanında).
- **Kayıtlar program içinde tutulur:** Veri, bilgisayardaki uygulama klasöründe saklanır (tarayıcı belleğine bağlı değildir, tarayıcı temizlenince silinmez).
  - Dosya: `siparis_verileri.json` — program içinde **Dosya → Veri klasörünü aç** ile açılır.
  - Windows'ta genelde: `%APPDATA%\İlaç Sipariş Takip\veri\`
- **Otomatik yedek:** En sık 10 dakikada bir önceki sürüm `yedekler` klasörüne alınır (son 40 adet) + her güne ait bir günlük yedek (son 90 gün). **Dosya → Yedekler klasörünü aç.**
- **Çevrimdışı çalışır:** Excel kütüphaneleri programın içindedir; internet gerekmez.
- **Ortak alanda çok kullanıcılı çalışma (şirket ağı):** *Yedek / Rapor* sekmesi → **Ortak klasör seç…** ile ağdaki paylaşım klasörünü seçin (ör. `\\sunucu\paylasim\IlacSiparis`). Her kullanıcı kendi bilgisayarında aynı klasörü seçer.
  - **Asıl kayıt ortak klasördedir.** Bilgisayardaki dosya yalnızca son görülen verinin önbelleğidir.
  - **Aynı anda tek kişi düzenler.** Programı ilk açan düzenleme hakkını alır; diğerleri **salt okunur** açılır. Üstteki sarı şerit kimin düzenlediğini gösterir; yapılan değişiklikler birkaç saniye içinde ekranlarına kendiliğinden gelir.
  - Salt okunur modda veri değiştirilemez; Excel / PDF çıktısı, yazdırma, yedek indirme ve kopyalama da kapalıdır (yalnızca ekranda görüntüleme).
  - **Düzenleme hakkını iste:** Düzenleyen kişiye soru çıkar. Kabul ederse ya da 2 dakika cevap vermezse düzenleme kaydedilip bırakılır ve isteyene geçer. Reddederse isteyene bildirilir.
  - **Düzenlemeyi bırak** düğmesi ya da programı kapatmak hakkı serbest bırakır. Serbest kalınca şeritte **Düzenlemeye başla** görünür.
  - Düzenleyenin bilgisayarı kapanır / ağdan koparsa kilit ~1,5 dakika sonra "bağlantı yok" görünür ve **Düzenlemeyi devral** ile alınabilir. Aynı kişi aynı bilgisayarda programı yeniden açarsa kendi eski kilidini hemen geri alır.
  - **Veri kaybı olmaz:** Bağlantı koparsa düzenleyenin değişiklikleri bilgisayarında saklanır, bağlantı gelince gönderilir. Bu arada hak başkasına geçtiyse hiçbir veri ezilmez; gönderilemeyen değişiklikler ortak `yedekler` klasörüne `cakisma_<kullanıcı>_<tarih>.json` olarak alınır ve kullanıcıya bildirilir.
  - **Sağlıklı kayıt:** Her kayıt geçici dosyaya yazılıp diske zorlanır, tek adımda yerine konur, sonra geri okunup SHA-256 sağlamasıyla doğrulanır. Her kayıtta sürüm numarası artar. Yarım/bozuk dosya algılanır; görüntüleyenler son sağlam veriyi görmeye devam eder, düzenleyen kaydedince bozuk dosya `bozuk_…` olarak yedeklenip düzeltilir.
  - **Ortak yedekler:** ortak klasörde `yedekler/` altında en sık 10 dakikada bir sürüm yedeği (son 200) ve günlük yedek (son 180 gün).
  - **Kayıt defteri:** `kayit_defteri.txt` — kim, ne zaman kaydetti, düzenlemeyi aldı/bıraktı/devraldı.
  - Bilgisayar saatleri farklı olsa da kilit süresi sunucunun saatine göre hesaplanır.
  - ⚠ OneDrive / Google Drive / Dropbox klasörü **kullanmayın**: eşitleme gecikmesi yüzünden kilit güvenilir çalışmaz. Gerçek bir ağ paylaşımı (SMB) kullanın. Kullanıcıların klasöre **okuma + yazma** izni olmalıdır (salt okunur kullanıcılar da kilit ve istek dosyası yazar).

  Ortak klasör içeriği:
  | Dosya | Görevi |
  |---|---|
  | `siparis_verileri_ortak.json` | Asıl veri (sürüm + sağlama) |
  | `siparis_kilit.json` | Düzenleme kilidi (kim düzenliyor) — elle silmeyin |
  | `siparis_istek.json` | Bekleyen düzenleme isteği |
  | `kayit_defteri.txt` | Kayıt geçmişi |
  | `yedekler/` | `surum_`, `gunluk_`, `cakisma_`, `ortak_onceki_`, `bozuk_` yedekleri |

  **1.0.x'ten geçiş:** Ortak klasör zaten seçiliyse ayar korunur, eski ortak dosya okunur ve ilk kayıtta yeni biçime geçer. Tüm kullanıcıların **aynı anda 1.1.0'a geçmesi** gerekir; eski sürüm kilide uymaz.
- **Taşınabilir sürüm:** `IlacSiparisTakip-Tasinabilir-*.exe` kurulum gerektirmez; ortak bir klasöre/USB'ye konup oradan çalıştırılabilir.

## GitHub'da derleme (kurulum dosyalarını üretme)
1. GitHub'da yeni bir **özel (private)** depo oluşturun.
2. Bu klasörün **tüm içeriğini** (gizli `.github` klasörü dahil) depoya yükleyin.
   - Web arayüzünden: *Add file → Upload files* ile klasörleri sürükleyin; `.github` görünmüyorsa gizli dosyaları göstermeyi açın.
   - Ya da komut satırı: `git init && git add . && git commit -m "ilk" && git branch -M main && git remote add origin <depo-adresi> && git push -u origin main`
3. Depoda **Actions → "Uygulamayı derle" → Run workflow** deyin. (Yaklaşık 5–10 dk.)
4. İş bitince çalıştırma sayfasının altındaki **Artifacts** bölümünden indirin:
   - `uygulama-windows-latest` → `IlacSiparisTakip-Kurulum-1.1.0.exe` (kurulum) ve `IlacSiparisTakip-Tasinabilir-1.1.0.exe`
   - `uygulama-macos-latest` → `.dmg`, `uygulama-ubuntu-latest` → `.AppImage`  (yalnızca Windows lazımsa diğerlerini yok sayın)
5. Alternatif: `git tag v1.1.0 && git push --tags` → derleme bitince dosyalar **Releases** sayfasına da eklenir.

> Windows'ta ilk çalıştırmada "SmartScreen" uyarısı çıkabilir (program imzasız): *Ek bilgi → Yine de çalıştır*.
> `GITHUB_TOKEN` ayrıca tanımlamanız gerekmez, otomatik gelir.

## Kendi bilgisayarında denemek (isteğe bağlı)
```
npm install      # Electron'u indirir ve Excel kütüphanelerini app/vendor içine kopyalar
npm start        # programı açar
npm test         # çok kullanıcılı kayıt/kilit senaryolarını dener (Electron gerekmez)
npm run dist:win # Windows kurulum dosyasını dist/ klasörüne üretir
```

## Eski verileri taşımak
Tarayıcıda kullandığınız sürümde **Yedek / Rapor → Yedek al (JSON)** ile dosyayı indirin.
Masaüstü programında aynı yerde **Yedekten geri yükle** ile seçin. Bundan sonrası otomatik kaydedilir.

## İkonu değiştirmek
`python scripts/make-icon.py` (Pillow gerekir: `pip install pillow`) `build/` içindeki `icon.png`, `icon.ico`, `icon.icns` dosyalarını yeniden üretir.
Kendi ikonunuzu kullanacaksanız bu üç dosyayı aynı adlarla değiştirin (PNG en az 512×512).

## Dosya yapısı
| Dosya | Görevi |
|---|---|
| `app/index.html` | Arayüz (mevcut sayfanız + son kayıt göstergesi + düzenleme/salt okunur şeridi + kayıt/ortak alan paneli) |
| `main.js`, `preload.js` | Pencere, menü, kapanışta kaydetme, güvenli köprü |
| `store.js` | Kayıt, yedek, ortak klasör, düzenleme kilidi ve devir mantığı |
| `scripts/copy-vendor.js` | Excel kütüphanelerini uygulamaya gömer (çevrimdışı için) |
| `build/` | Uygulama ikonları |
| `.github/workflows/build.yml` | GitHub'da otomatik derleme |
