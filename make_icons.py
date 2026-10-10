
import os
from PIL import Image, ImageDraw

# 输入是仓库里的图标原图，输出到 icon_out/（那个目录不进版本库）
_HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(_HERE, "assets", "icon-source.png")
OUT = os.path.join(_HERE, "icon_out")

img = Image.open(SRC).convert("RGBA")
W, H = img.size
print("source:", W, "x", H)

# 采样四角 + 四边中点，取平均作为背景兜底色
pts = [(6,6),(W-7,6),(6,H-7),(W-7,H-7),(W//2,4),(W//2,H-5),(4,H//2),(W-5,H//2)]
cols = [img.getpixel(p)[:3] for p in pts]
avg = tuple(sum(c[i] for c in cols)//len(cols) for i in range(3))
print("corner/edge colors:", ["#%02X%02X%02X" % c for c in cols])
print("average background:", "#%02X%02X%02X" % avg)

def resize(src, size):
    """分级降采样，避免小尺寸出现振铃和锯齿"""
    cur = src
    w, h = src.size
    while w // 2 >= size and w // 2 > 0:
        cur = cur.resize((w//2, h//2), Image.Resampling.BOX)
        w, h = cur.size
    if cur.size != (size, size):
        cur = cur.resize((size, size), Image.Resampling.LANCZOS)
    return cur

def rounded(im, radius_ratio=0.5):
    """在图上叠加圆角/圆形蒙版"""
    size = im.size[0]
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    r = int(size * radius_ratio)
    d.rounded_rectangle([0,0,size-1,size-1], radius=r, fill=255)
    out = Image.new("RGBA", (size, size), (0,0,0,0))
    out.paste(im, (0,0), mask)
    return out

def save(im, path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    im.save(path, "PNG", optimize=True)
    return os.path.getsize(path)

manifest = []

# ---- 1. 传统自适应图标（Android 5.0-7.1 传统 mipmap）----
legacy = [(48,"mdpi"),(72,"hdpi"),(96,"xhdpi"),(144,"xxhdpi"),(192,"xxxhdpi")]
base = os.path.join(OUT, "android", "res")
for px, dpi in legacy:
    im = resize(img, px)
    p = os.path.join(base, "mipmap-" + dpi, "ic_launcher.png")
    sz = save(im, p)
    manifest.append((p.replace(OUT+"\\",""), f"{px}x{px}", sz, f"传统图标 {dpi}"))
    p2 = os.path.join(base, "mipmap-" + dpi, "ic_launcher_round.png")
    rounded(im, 0.5).save(p2, "PNG", optimize=True)
    manifest.append((p2.replace(OUT+"\\",""), f"{px}x{px}", os.path.getsize(p2), f"圆形图标 {dpi}"))

# ---- 2. 自适应图标（Android 8.0+，432x432 = 108dp @ xxxhdpi）----
fg = resize(img, 432)
p = os.path.join(base, "mipmap-xxxhdpi", "ic_launcher_foreground.png")
sz = save(fg, p)
manifest.append((p.replace(OUT+"\\",""), "432x432", sz, "自适应前景层（整图，含渐变背景）"))

bg = Image.new("RGBA", (432, 432), avg + (255,))
p = os.path.join(base, "mipmap-xxxhdpi", "ic_launcher_background.png")
sz = save(bg, p)
manifest.append((p.replace(OUT+"\\",""), "432x432", sz, "自适应背景层（纯色 #%02X%02X%02X，兜底用）" % avg))

# ---- 3. 商店 / README 用 ----
for px in (512,):
    p = os.path.join(OUT, "store", f"icon-{px}.png")
    sz = save(resize(img, px), p)
    manifest.append((p.replace(OUT+"\\",""), f"{px}x{px}", sz, "商店 / README 大图"))

# ---- 4. Web / PWA ----
web = os.path.join(OUT, "web")
for name, px in [("favicon-32.png",32),("icon-192.png",192),("icon-512.png",512)]:
    p = os.path.join(web, name)
    sz = save(resize(img, px), p)
    manifest.append((p.replace(OUT+"\\",""), f"{px}x{px}", sz, "Web / PWA"))
p = os.path.join(web, "icon-maskable-512.png")
sz = save(resize(img, 512), p)
manifest.append((p.replace(OUT+"\\",""), "512x512", sz, "PWA maskable（四角留白版请自行裁）"))

# ---- 5. 预览图 ----
prev = os.path.join(OUT, "preview")
p48 = resize(img, 48)
big = p48.resize((384,384), Image.Resampling.NEAREST)
p = os.path.join(prev, "48px-pixelated.png")
sz = save(big, p)
manifest.append((p.replace(OUT+"\\",""), "384x384", sz, "48px 放大预览（验辨识度）"))

# 白底 + 深色底并排，检查边缘是否消失
sheet = Image.new("RGB", (1254, 640), (255,255,255))
sheet.paste(img.resize((620,620), Image.Resampling.LANCZOS), (10,10))
dark = Image.new("RGB", (620,620), (18,19,26))
dark.paste(img.resize((620,620), Image.Resampling.LANCZOS), (0,0))
sheet.paste(dark, (645,10))
p = os.path.join(prev, "light-vs-dark.png")
save(sheet, p)
manifest.append((p.replace(OUT+"\\",""), "1254x640", os.path.getsize(p), "浅色底 vs 深色底 对比"))

print()
print("%-52s %-10s %8s  %s" % ("文件", "尺寸", "字节", "用途"))
print("-"*120)
for m in manifest:
    print("%-52s %-10s %8d  %s" % m)
print()
print("输出根目录:", OUT)

