#!/usr/bin/env python3
"""Рисует иконки приложения без сторонних библиотек.

Запуск из папки приложения:  python tools/make_icons.py
Получаются icons/icon-180.png (экран «Домой» на iPhone), icon-192.png и icon-512.png (манифест).
Рисунок: тёплый фон, светлая карточка, зелёная галочка — те же цвета, что в style.css.
"""
import struct
import zlib
from pathlib import Path

BG = (201, 138, 75)       # --accent
CARD = (255, 253, 249)    # --card
CHECK = (63, 143, 90)     # --done

HALF, RADIUS = 0.29, 0.10                          # карточка: полуразмер и скругление (в долях стороны)
STROKE = 0.042                                     # полутолщина галочки
POINTS = ((0.365, 0.515), (0.462, 0.612), (0.648, 0.398))


def in_card(x, y):
    dx = max(abs(x - 0.5) - (HALF - RADIUS), 0.0)
    dy = max(abs(y - 0.5) - (HALF - RADIUS), 0.0)
    return dx * dx + dy * dy <= RADIUS * RADIUS


def near_segment(x, y, a, b):
    ax, ay = a
    bx, by = b
    vx, vy = bx - ax, by - ay
    t = ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)
    t = min(1.0, max(0.0, t))
    dx, dy = x - (ax + t * vx), y - (ay + t * vy)
    return dx * dx + dy * dy <= STROKE * STROKE


def in_check(x, y):
    return near_segment(x, y, POINTS[0], POINTS[1]) or near_segment(x, y, POINTS[1], POINTS[2])


def render(size, samples=3):
    """Строки пикселей RGB; края сглажены: на пиксель берётся samples × samples точек."""
    rows = []
    n = samples * samples
    for py in range(size):
        row = bytearray()
        for px in range(size):
            card = check = 0
            for sy in range(samples):
                y = (py + (sy + 0.5) / samples) / size
                for sx in range(samples):
                    x = (px + (sx + 0.5) / samples) / size
                    if in_check(x, y):
                        check += 1
                    elif in_card(x, y):
                        card += 1
            bg = n - card - check
            row.extend((BG[i] * bg + CARD[i] * card + CHECK[i] * check + n // 2) // n for i in range(3))
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(b"\x00" + row for row in rows)   # в начале каждой строки — тип фильтра 0
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))   # 8 бит, RGB, без прозрачности
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


def main():
    out = Path(__file__).resolve().parent.parent / "icons"
    out.mkdir(exist_ok=True)
    for size in (180, 192, 512):
        write_png(out / f"icon-{size}.png", size, render(size))
        print(f"icons/icon-{size}.png")


if __name__ == "__main__":
    main()
