#!/usr/bin/env python3
"""Единая вёрстка фотографий каталога.

Берёт любые исходники — снятые в колледже или скачанные с сайта
производителя — и приводит к одному виду: квадрат 800×800, белый фон,
предмет по центру с одинаковым полем, JPEG без лишнего веса.

    python3 site/photos.py source/                 # обработать папку
    python3 site/photos.py source/CAM-01.png       # один файл

Имя исходника — это ключ позиции: CAM-01.png -> photos/CAM-01.jpg. Ключи
видны в карточке позиции на сайте и в site/catalog.json.
"""

import sys
from pathlib import Path

from PIL import Image

SIZE = 800
PAD = 48                    # поле вокруг предмета
# Белый, а не фон карточки: владелец решил показывать снимки как в оригинале,
# а почти все исходники — на белом. Тёмное поле вокруг белого кадра выглядело
# вырезкой, вставленной в карточку.
BG = (255, 255, 255)
OUT = Path(__file__).parent / "photos"


def trim(img):
    """Убрать однотонные поля исходника, чтобы предмет занимал кадр целиком.

    Без этого фотографии с разным запасом по краям выглядят на витрине
    разномасштабными, хотя сами предметы сопоставимы.
    """
    rgb = img.convert("RGB")
    corners = [rgb.getpixel(p) for p in
               ((0, 0), (rgb.width - 1, 0), (0, rgb.height - 1),
                (rgb.width - 1, rgb.height - 1))]
    # Углы разного цвета — значит поля нет, и обрезать нечего.
    if max(max(c) - min(c) for c in zip(*corners)) > 12:
        return img
    bg = corners[0]
    mask = Image.new("L", rgb.size, 0)
    px, mp = rgb.load(), mask.load()
    for y in range(rgb.height):
        for x in range(rgb.width):
            r, g, b = px[x, y]
            if abs(r - bg[0]) + abs(g - bg[1]) + abs(b - bg[2]) > 30:
                mp[x, y] = 255
    box = mask.getbbox()
    return img.crop(box) if box else img


def convert(src: Path) -> Path:
    img = Image.open(src)
    # Прозрачность кладём на фон карточки, иначе JPEG сделает её чёрной.
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        plate = Image.new("RGBA", img.size, BG + (255,))
        img = Image.alpha_composite(plate, img)
    img = trim(img.convert("RGB"))

    box = SIZE - PAD * 2
    img.thumbnail((box, box), Image.LANCZOS)

    canvas = Image.new("RGB", (SIZE, SIZE), BG)
    canvas.paste(img, ((SIZE - img.width) // 2, (SIZE - img.height) // 2))

    OUT.mkdir(exist_ok=True)
    dst = OUT / (src.stem + ".jpg")
    canvas.save(dst, "JPEG", quality=82, optimize=True, progressive=True)
    return dst


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    target = Path(sys.argv[1])
    files = sorted(p for p in (target.iterdir() if target.is_dir() else [target])
                   if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))
    if not files:
        print("нечего обрабатывать:", target)
        return 1
    total = 0
    for src in files:
        dst = convert(src)
        size = dst.stat().st_size
        total += size
        print(f"  {src.name:28} -> {dst.name:20} {size // 1024} КБ")
    print(f"готово: {len(files)} шт., {total // 1024} КБ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
