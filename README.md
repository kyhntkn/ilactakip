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
- **Ortak alana kayıt:** *Yedek / Rapor* sekmesi → **Ortak klasör seç…** (ağ sürücüsü, paylaşım klasörü, OneDrive/Drive klasörü olabilir).
  - Kayıtlar hem yerele hem ortak klasördeki `siparis_verileri_ortak.json` dosyasına yazılır.
  - Ortak klasöre ulaşılamazsa program çalışmaya devam eder, veri yerelde saklanır; bağlantı gelince **otomatik gönderilir**.
  - Başkası ortak dosyayı değiştirdiyse üst çubukta *"Ortak alanda yeni sürüm var → Güncelle"* görünür.
  - İki kişi aynı anda değişiklik yaparsa program **çakışmayı fark eder** ve hangi sürümün korunacağını sorar; diğeri yedeklere alınır (kaybolmaz). Veriler **birleştirilmez** — mümkünse aynı anda tek kişi düzenlesin.
- **Taşınabilir sürüm:** `IlacSiparisTakip-Tasinabilir-*.exe` kurulum gerektirmez; ortak bir klasöre/USB'ye konup oradan çalıştırılabilir.

## GitHub'da derleme (kurulum dosyalarını üretme)
1. GitHub'da yeni bir **özel (private)** depo oluşturun.
2. Bu klasörün **tüm içeriğini** (gizli `.github` klasörü dahil) depoya yükleyin.
   - Web arayüzünden: *Add file → Upload files* ile klasörleri sürükleyin; `.github` görünmüyorsa gizli dosyaları göstermeyi açın.
   - Ya da komut satırı: `git init && git add . && git commit -m "ilk" && git branch -M main && git remote add origin <depo-adresi> && git push -u origin main`
3. Depoda **Actions → "Uygulamayı derle" → Run workflow** deyin. (Yaklaşık 5–10 dk.)
4. İş bitince çalıştırma sayfasının altındaki **Artifacts** bölümünden indirin:
   - `uygulama-windows-latest` → `IlacSiparisTakip-Kurulum-1.0.0.exe` (kurulum) ve `IlacSiparisTakip-Tasinabilir-1.0.0.exe`
   - `uygulama-macos-latest` → `.dmg`, `uygulama-ubuntu-latest` → `.AppImage`  (yalnızca Windows lazımsa diğerlerini yok sayın)
5. Alternatif: `git tag v1.0.0 && git push --tags` → derleme bitince dosyalar **Releases** sayfasına da eklenir.

> Windows'ta ilk çalıştırmada "SmartScreen" uyarısı çıkabilir (program imzasız): *Ek bilgi → Yine de çalıştır*.
> `GITHUB_TOKEN` ayrıca tanımlamanız gerekmez, otomatik gelir.

## Kendi bilgisayarında denemek (isteğe bağlı)
```
npm install      # Electron'u indirir ve Excel kütüphanelerini app/vendor içine kopyalar
npm start        # programı açar
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
| `app/index.html` | Arayüz (mevcut sayfanız + son kayıt göstergesi + kayıt/ortak alan paneli) |
| `main.js`, `preload.js` | Pencere, menü, kapanışta kaydetme, güvenli köprü |
| `store.js` | Kayıt, yedek, ortak klasör eşitleme ve çakışma mantığı |
| `scripts/copy-vendor.js` | Excel kütüphanelerini uygulamaya gömer (çevrimdışı için) |
| `build/` | Uygulama ikonları |
| `.github/workflows/build.yml` | GitHub'da otomatik derleme |
