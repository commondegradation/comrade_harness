#!/usr/bin/env python3
"""Собирает иконки приложения из логотипа.

Имена исходников означают ФОН, для которого нарисован логотип:
  assets/logo-black.png — светлый логотип (для тёмной темы/иконки)
  assets/logo-white.png — тёмный логотип (для светлой темы)

Результат: assets/icon.png (1024), assets/icon.ico, assets/icon.icns
"""

import os
import shutil
import subprocess
import tempfile

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS = os.path.join(ROOT, "assets")
SIZE = 1024


def build_master() -> Image.Image:
    # Для тёмной плашки нужен светлый логотип.
    logo = Image.open(os.path.join(ASSETS, "logo-black.png")).convert("RGBA")
    bbox = logo.getbbox()
    if bbox:
        logo = logo.crop(bbox)

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    plate = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(plate)
    draw.rounded_rectangle(
        [0, 0, SIZE - 1, SIZE - 1], radius=int(SIZE * 0.22), fill=(16, 16, 20, 255)
    )

    # Мягкий градиент сверху вниз для объёма.
    gradient = Image.new("L", (1, SIZE))
    for y in range(SIZE):
        gradient.putpixel((0, y), int(38 * (1 - y / SIZE)))
    gradient = gradient.resize((SIZE, SIZE))
    plate = Image.composite(
        Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 26)), plate, gradient
    )
    canvas.alpha_composite(plate)

    target = int(SIZE * 0.58)
    ratio = min(target / logo.width, target / logo.height)
    logo = logo.resize(
        (max(1, int(logo.width * ratio)), max(1, int(logo.height * ratio))), Image.LANCZOS
    )
    canvas.alpha_composite(logo, ((SIZE - logo.width) // 2, (SIZE - logo.height) // 2))
    return canvas


def main() -> None:
    master = build_master()

    png_path = os.path.join(ASSETS, "icon.png")
    master.save(png_path)
    print("icon.png", master.size)

    master.save(
        os.path.join(ASSETS, "icon.ico"),
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("icon.ico ok")

    # iconutil требует суффикс .iconset
    iconset = os.path.join(tempfile.mkdtemp(prefix="comrade-iconset-"), "Comrade.iconset")
    os.makedirs(iconset, exist_ok=True)
    specs = [
        (16, "16x16"),
        (32, "16x16@2x"),
        (32, "32x32"),
        (64, "32x32@2x"),
        (128, "128x128"),
        (256, "128x128@2x"),
        (256, "256x256"),
        (512, "256x256@2x"),
        (512, "512x512"),
        (1024, "512x512@2x"),
    ]
    for size, name in specs:
        master.resize((size, size), Image.LANCZOS).save(
            os.path.join(iconset, f"icon_{name}.png")
        )
    subprocess.run(
        ["iconutil", "-c", "icns", iconset, "-o", os.path.join(ASSETS, "icon.icns")],
        check=True,
    )
    shutil.rmtree(os.path.dirname(iconset), ignore_errors=True)
    print("icon.icns ok")

    # Проверка: логотип должен быть светлым на тёмной плашке.
    check = Image.open(png_path).convert("RGBA")
    center = check.getpixel((SIZE // 2, SIZE // 2))
    print("центр иконки:", center, "(ожидается светлый)")


if __name__ == "__main__":
    main()
