#!/usr/bin/env python3
"""生成扩展图标：圆角渐变底 + 手绘「文」字笔画（无字体依赖）"""
from PIL import Image, ImageDraw

OUT = "/var/minis/shared/browser-translate/icons/"


def rounded_line(d, p1, p2, w, fill):
    """带圆头的粗线"""
    d.line([p1, p2], fill=fill, width=w)
    r = w / 2
    for (x, y) in (p1, p2):
        d.ellipse([x - r, y - r, x + r, y + r], fill=fill)


def make(size, ss=8):
    S = size * ss
    # 渐变底：左上 #5B6CFF → 右下 #8F5BFF
    grad = Image.new("RGB", (S, S))
    gd = ImageDraw.Draw(grad)
    c1 = (0x5B, 0x6C, 0xFF)
    c2 = (0x8F, 0x5B, 0xFF)
    for y in range(S):
        for_t = y / max(1, S - 1)
        # 沿对角线做渐变，再叠加水平偏移
        row = tuple(int(c1[i] + (c2[i] - c1[i]) * for_t) for i in range(3))
        gd.line([(0, y), (S, y)], fill=row)
    # 斜向渐变叠加，让左上更亮
    overlay = Image.new("L", (S, S), 0)
    od = ImageDraw.Draw(overlay)
    for i in range(S):
        od.line([(0, i), (i, 0)], fill=int(38 * (1 - i / S)))
    white = Image.new("RGB", (S, S), (255, 255, 255))
    grad = Image.composite(white, grad, overlay.point(lambda v: v))

    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    img.paste(grad, (0, 0))

    # 圆角遮罩（iOS 风格约 22.5% 圆角）
    mask = Image.new("L", (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
    img.putalpha(mask)

    d = ImageDraw.Draw(img)
    W = (255, 255, 255, 255)
    u = S / 100.0  # 1 单位 = 1% 画布

    def P(x, y):
        return (x * u, y * u)

    stroke = int(10.5 * u)
    # 「文」顶部点
    d.ellipse([P(44.2, 15.5), P(55.8, 25.0)], fill=W)
    # 横
    rounded_line(d, P(20, 34.5), P(80, 34.5), int(11 * u), W)
    # 左撇（从右上到左下）
    rounded_line(d, P(70.5, 45.0), P(28.5, 84.0), stroke, W)
    # 右捺（从左上到右下）
    rounded_line(d, P(29.5, 45.0), P(71.5, 84.0), stroke, W)

    return img.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    im = make(s)
    im.save(OUT + f"icon{s}.png")
    print("saved", OUT + f"icon{s}.png", im.size)

# 顺便出一张 512 预览
make(512, ss=4).save(OUT + "preview512.png")
print("preview ok")
