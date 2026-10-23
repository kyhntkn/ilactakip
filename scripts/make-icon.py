# Uygulama ikonunu üretir (build/icon.png, icon.ico, icon.icns). Gerekli: pip install pillow
from PIL import Image, ImageDraw, ImageFilter
import math, os
S = 2048            # çalışma boyutu (2x), sonra 1024'e küçültülür
u = S / 1024.0
def R(v): return int(round(v * u))

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# 1) Arka plan: yuvarlatılmış kare, koyu laciverttten maviye çapraz geçiş
bg = Image.new('RGBA', (S, S), (0, 0, 0, 0))
grad = Image.new('RGBA', (S, S))
gp = grad.load()
c1, c2 = (14, 42, 79), (31, 118, 186)
for y in range(S):
    for x in range(S):
        gp[x, y] = lerp(c1, c2, (x + y) / (2.0 * S)) + (255,)
mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([R(40), R(40), R(984), R(984)], radius=R(210), fill=255)
bg.paste(grad, (0, 0), mask)

# 2) Grafik çubukları (sipariş / bütçe / fiili artışı)
bars = Image.new('RGBA', (S, S), (0, 0, 0, 0))
bd = ImageDraw.Draw(bars)
base = 830
for i, h in enumerate([150, 255, 360]):
    x0 = 150 + i * 143
    bd.rounded_rectangle([R(x0), R(base - h), R(x0 + 105), R(base)], radius=R(26), fill=(255, 255, 255, 235))
bg = Image.alpha_composite(bg, bars)

# 3) Kapsül (hap), 45° eğik, iki renkli
cap = Image.new('RGBA', (S, S), (0, 0, 0, 0))
cd = ImageDraw.Draw(cap)
cw, ch = 600, 250
cx, cy = 512, 512
box = [R(cx - cw / 2), R(cy - ch / 2), R(cx + cw / 2), R(cy + ch / 2)]
cd.rounded_rectangle(box, radius=R(ch / 2), fill=(255, 255, 255, 255))
half = Image.new('L', (S, S), 0)
ImageDraw.Draw(half).rectangle([R(cx), 0, S, S], fill=255)
cm = Image.new('L', (S, S), 0)
ImageDraw.Draw(cm).rounded_rectangle(box, radius=R(ch / 2), fill=255)
right = Image.new('RGBA', (S, S), (70, 207, 170, 255))
from PIL import ImageChops
rm = ImageChops.multiply(half, cm)
cap.paste(right, (0, 0), rm)
# ayırıcı çizgi ve parlama: ayrı katmanda çizilip kapsüle karıştırılır (yarı saydamlık korunur)
fx = Image.new('RGBA', (S, S), (0, 0, 0, 0))
fd = ImageDraw.Draw(fx)
fd.line([R(cx), R(cy - ch / 2), R(cx), R(cy + ch / 2)], fill=(20, 60, 100, 70), width=R(5))
fd.rounded_rectangle([R(cx - cw / 2 + 50), R(cy - ch / 2 + 24), R(cx + cw / 2 - 50), R(cy - ch / 2 + 58)], radius=R(17), fill=(255, 255, 255, 90))
fa = ImageChops.multiply(fx.split()[3], cm)
fx.putalpha(fa)
cap = Image.alpha_composite(cap, fx)
cap = cap.rotate(45, resample=Image.BICUBIC, center=(R(cx), R(cy)))
shift = (R(190), R(-150))
cap2 = Image.new('RGBA', (S, S), (0, 0, 0, 0)); cap2.paste(cap, shift)
shadow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
sa = cap2.split()[3].point(lambda a: int(a * 0.35))
shadow.paste((0, 20, 50, 255), (R(10), R(22)), sa)
shadow = shadow.filter(ImageFilter.GaussianBlur(R(18)))
bg = Image.alpha_composite(bg, shadow)
bg = Image.alpha_composite(bg, cap2)

icon = bg.resize((1024, 1024), Image.LANCZOS)
out = os.path.join(os.path.dirname(__file__), '..', 'build'); os.makedirs(out, exist_ok=True)
icon.save(os.path.join(out, 'icon.png'))
icon.save(os.path.join(out, 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
icon.save(os.path.join(out, 'icon.icns'))
print('ikonlar üretildi:', os.listdir(out))
