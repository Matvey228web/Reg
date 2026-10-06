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

from PIL import Image, ImageChops, ImageFilter

SIZE = 800
PAD = 48                    # поле вокруг предмета
# Белый, а не фон карточки: владелец решил показывать снимки как в оригинале,
# а почти все исходники — на белом. Тёмное поле вокруг белого кадра выглядело
# вырезкой, вставленной в карточку.
BG = (255, 255, 255)
OUT = Path(__file__).parent / "photos"


def trim(img):
    """Убрать поля исходника, чтобы предмет занимал кадр целиком.

    Без этого фотографии с разным запасом по краям выглядят на витрине
    разномасштабными, хотя сами предметы сопоставимы. Фон — цвет углов, если
    они сходятся, иначе белый: у снимков магазинов фон бывает чуть неровным
    (тень, градиент, рамка), и строгое «все углы одного цвета» оставляло их
    мелкими (владелец заметил на витрине 6 октября 2026).
    """
    rgb = img.convert("RGB")
    corners = [rgb.getpixel(p) for p in
               ((0, 0), (rgb.width - 1, 0), (0, rgb.height - 1),
                (rgb.width - 1, rgb.height - 1))]
    even = max(max(c) - min(c) for c in zip(*corners)) <= 24
    bg = corners[0] if even else (255, 255, 255)
    diff = ImageChops.difference(rgb, Image.new("RGB", rgb.size, bg)).convert("L")
    # Пыль, шум JPEG и тонкие рамки не должны держать границу кадра: после
    # сужения маски остаются только крупные пятна — сам предмет.
    mask = diff.point(lambda v: 255 if v > 40 else 0).filter(ImageFilter.MinFilter(5))
    box = mask.getbbox()
    if not box:
        return img
    l, t, r, b = box
    pad = 3
    box = (max(l - pad, 0), max(t - pad, 0), min(r + pad, rgb.width), min(b + pad, rgb.height))
    # Почти весь кадр — значит, фон не однотонный (снимок в интерьере):
    # обрезать нечего.
    if (box[2] - box[0]) * (box[3] - box[1]) > 0.97 * rgb.width * rgb.height:
        return img
    return img.crop(box)


def convert(src: Path) -> Path:
    img = Image.open(src)
    # Прозрачность кладём на фон карточки, иначе JPEG сделает её чёрной.
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        plate = Image.new("RGBA", img.size, BG + (255,))
        img = Image.alpha_composite(plate, img)
    img = trim(img.convert("RGB"))

    box = SIZE - PAD * 2
    # Не thumbnail: тот только уменьшает, и исходник меньше кадра (с Tilda
    # приходили 225–500 точек) оставался мелким пятном посреди белого поля.
    scale = box / max(img.width, img.height)
    img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                     Image.LANCZOS)

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
