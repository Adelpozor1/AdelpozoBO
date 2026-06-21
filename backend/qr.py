#!/usr/bin/env python3
"""Generador de códigos QR en Python puro (stdlib), suficiente para mostrar la
URI otpauth:// del 2FA en el terminal — sin instalar nada (`qrencode` opcional).

Soporta modo byte, nivel de corrección de errores M y versiones 1-10 (hasta
~150 bytes, de sobra para una URI otpauth). Algoritmo portado fielmente del
generador de Nayuki (dominio público), recortado a lo que necesitamos.
"""
from __future__ import annotations

# --- parámetros por versión (nivel de corrección M) ------------------------ #
_DATA_CW_M = {1: 16, 2: 28, 3: 44, 4: 64, 5: 86,
              6: 108, 7: 124, 8: 154, 9: 182, 10: 216}
_ECC_PER_BLOCK_M = {1: 10, 2: 16, 3: 26, 4: 18, 5: 24,
                    6: 16, 7: 18, 8: 22, 9: 22, 10: 26}
_NUM_BLOCKS_M = {1: 1, 2: 1, 3: 1, 4: 2, 5: 2,
                 6: 4, 7: 4, 8: 4, 9: 5, 10: 5}
_ALIGN_POS = {1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
              6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
              10: [6, 28, 50]}

# --- aritmética en GF(256) -------------------------------------------------- #
_EXP = [0] * 512
_LOG = [0] * 256
_x = 1
for _i in range(255):
    _EXP[_i] = _x
    _LOG[_x] = _i
    _x <<= 1
    if _x & 0x100:
        _x ^= 0x11D
for _i in range(255, 512):
    _EXP[_i] = _EXP[_i - 255]


def _gf_mul(a: int, b: int) -> int:
    return 0 if a == 0 or b == 0 else _EXP[_LOG[a] + _LOG[b]]


def _rs_generator(n: int) -> list[int]:
    g = [1]
    for i in range(n):
        ng = [0] * (len(g) + 1)
        for j, c in enumerate(g):
            ng[j] ^= c
            ng[j + 1] ^= _gf_mul(c, _EXP[i])
        g = ng
    return g


def _rs_encode(data: list[int], nsym: int) -> list[int]:
    gen = _rs_generator(nsym)
    res = list(data) + [0] * nsym
    for i in range(len(data)):
        coef = res[i]
        if coef != 0:
            for j in range(1, len(gen)):
                res[i + j] ^= _gf_mul(gen[j], coef)
    return res[len(data):]


# --- elección de versión y codificación de datos --------------------------- #
def _capacity_chars(ver: int) -> int:
    count_bits = 8 if ver < 10 else 16
    return (_DATA_CW_M[ver] * 8 - 4 - count_bits) // 8


def _pick_version(n: int) -> int:
    for ver in range(1, 11):
        if _capacity_chars(ver) >= n:
            return ver
    raise ValueError("texto demasiado largo para QR v1-10")


def _encode_data(msg: bytes, ver: int) -> list[int]:
    bits: list[int] = []

    def push(val: int, n: int) -> None:
        for i in range(n - 1, -1, -1):
            bits.append((val >> i) & 1)

    push(0b0100, 4)                       # indicador de modo byte
    push(len(msg), 8 if ver < 10 else 16)  # contador
    for b in msg:
        push(b, 8)

    cap_bits = _DATA_CW_M[ver] * 8
    push(0, min(4, cap_bits - len(bits)))  # terminador
    while len(bits) % 8 != 0:               # relleno hasta byte
        bits.append(0)
    pad = [0xEC, 0x11]
    k = 0
    while len(bits) < cap_bits:
        push(pad[k % 2], 8)
        k += 1

    data = []
    for j in range(0, len(bits), 8):
        byte = 0
        for t in range(8):
            byte = (byte << 1) | bits[j + t]
        data.append(byte)
    return data


def _add_ecc_interleave(data: list[int], ver: int) -> list[int]:
    num_blocks = _NUM_BLOCKS_M[ver]
    ecc_len = _ECC_PER_BLOCK_M[ver]
    raw = _DATA_CW_M[ver] + ecc_len * num_blocks
    num_short = num_blocks - raw % num_blocks
    short_data = raw // num_blocks - ecc_len

    blocks = []
    k = 0
    for i in range(num_blocks):
        dlen = short_data + (0 if i < num_short else 1)
        dat = data[k:k + dlen]
        k += dlen
        blocks.append((dat, _rs_encode(dat, ecc_len)))

    result = []
    for i in range(short_data + 1):
        for dat, _ in blocks:
            if i < len(dat):
                result.append(dat[i])
    for i in range(ecc_len):
        for _, ecc in blocks:
            result.append(ecc[i])
    return result


# --- construcción de la matriz --------------------------------------------- #
def _build(msg: bytes) -> list[list[bool]]:
    ver = _pick_version(len(msg))
    size = 17 + 4 * ver
    mod = [[False] * size for _ in range(size)]
    func = [[False] * size for _ in range(size)]

    def setf(x: int, y: int, dark: bool) -> None:
        if 0 <= x < size and 0 <= y < size:
            mod[y][x] = dark
            func[y][x] = True

    # temporización (primero: los localizadores la pisarán en sus esquinas)
    for i in range(size):
        setf(6, i, i % 2 == 0)
        setf(i, 6, i % 2 == 0)

    # patrones localizadores + separadores
    def finder(cx: int, cy: int) -> None:
        for dy in range(-4, 5):
            for dx in range(-4, 5):
                dist = max(abs(dx), abs(dy))
                setf(cx + dx, cy + dy, dist not in (2, 4))
    finder(3, 3)
    finder(size - 4, 3)
    finder(3, size - 4)

    # patrones de alineación
    pos = _ALIGN_POS[ver]
    n = len(pos)
    for i in range(n):
        for j in range(n):
            if (i, j) in ((0, 0), (0, n - 1), (n - 1, 0)):
                continue
            cx, cy = pos[i], pos[j]
            for dy in range(-2, 3):
                for dx in range(-2, 3):
                    setf(cx + dx, cy + dy, max(abs(dx), abs(dy)) != 1)

    # info de versión (v>=7)
    if ver >= 7:
        rem = ver
        for _ in range(12):
            rem = (rem << 1) ^ ((rem >> 11) * 0x1F25)
        bits = (ver << 12) | rem
        for i in range(18):
            bit = (bits >> i) & 1
            a, b = size - 11 + i % 3, i // 3
            setf(a, b, bit == 1)
            setf(b, a, bit == 1)

    def draw_format(mask: int) -> None:
        data = (0 << 3) | mask  # nivel M = 0b00
        rem = data
        for _ in range(10):
            rem = (rem << 1) ^ ((rem >> 9) * 0x537)
        bits = ((data << 10) | rem) ^ 0x5412
        for i in range(6):
            setf(8, i, (bits >> i) & 1)
        setf(8, 7, (bits >> 6) & 1)
        setf(8, 8, (bits >> 7) & 1)
        setf(7, 8, (bits >> 8) & 1)
        for i in range(9, 15):
            setf(14 - i, 8, (bits >> i) & 1)
        for i in range(8):
            setf(size - 1 - i, 8, (bits >> i) & 1)
        for i in range(8, 15):
            setf(8, size - 15 + i, (bits >> i) & 1)
        setf(8, size - 8, True)  # módulo oscuro fijo

    draw_format(0)  # reserva las celdas de formato

    # colocación de los datos en zigzag
    codewords = _add_ecc_interleave(_encode_data(msg, ver), ver)
    i = 0
    total = len(codewords) * 8
    for right in range(size - 1, 0, -2):
        if right == 6:
            right = 5
        for vert in range(size):
            for j in range(2):
                x = right - j
                upward = ((right + 1) & 2) == 0
                y = (size - 1 - vert) if upward else vert
                if not func[y][x] and i < total:
                    mod[y][x] = (codewords[i >> 3] >> (7 - (i & 7))) & 1 == 1
                    i += 1

    # elige la máscara con menor penalización
    best = None
    best_mask = 0
    for mask in range(8):
        trial = [row[:] for row in mod]
        for y in range(size):
            for x in range(size):
                if func[y][x]:
                    continue
                if _mask_bit(mask, x, y):
                    trial[y][x] = not trial[y][x]
        # dibuja el formato correspondiente sobre la copia
        _apply_format(trial, size, mask)
        p = _penalty(trial)
        if best is None or p < best:
            best, best_mask = p, mask

    for y in range(size):
        for x in range(size):
            if not func[y][x] and _mask_bit(best_mask, x, y):
                mod[y][x] = not mod[y][x]
    draw_format(best_mask)
    return mod


def _mask_bit(mask: int, x: int, y: int) -> bool:
    if mask == 0:
        return (x + y) % 2 == 0
    if mask == 1:
        return y % 2 == 0
    if mask == 2:
        return x % 3 == 0
    if mask == 3:
        return (x + y) % 3 == 0
    if mask == 4:
        return (x // 3 + y // 2) % 2 == 0
    if mask == 5:
        return (x * y) % 2 + (x * y) % 3 == 0
    if mask == 6:
        return ((x * y) % 2 + (x * y) % 3) % 2 == 0
    return (((x + y) % 2) + (x * y) % 3) % 2 == 0


def _apply_format(mod, size, mask):
    data = (0 << 3) | mask
    rem = data
    for _ in range(10):
        rem = (rem << 1) ^ ((rem >> 9) * 0x537)
    bits = ((data << 10) | rem) ^ 0x5412

    def s(x, y, v):
        mod[y][x] = (v == 1)
    for i in range(6):
        s(8, i, (bits >> i) & 1)
    s(8, 7, (bits >> 6) & 1)
    s(8, 8, (bits >> 7) & 1)
    s(7, 8, (bits >> 8) & 1)
    for i in range(9, 15):
        s(14 - i, 8, (bits >> i) & 1)
    for i in range(8):
        s(size - 1 - i, 8, (bits >> i) & 1)
    for i in range(8, 15):
        s(8, size - 15 + i, (bits >> i) & 1)
    s(8, size - 8, 1)


def _penalty(mod) -> int:
    size = len(mod)
    res = 0
    # regla 1: rachas en filas y columnas
    for line in (mod, [[mod[y][x] for y in range(size)] for x in range(size)]):
        for row in line:
            run_c, run = row[0], 1
            for v in row[1:]:
                if v == run_c:
                    run += 1
                    if run == 5:
                        res += 3
                    elif run > 5:
                        res += 1
                else:
                    run_c, run = v, 1
    # regla 2: bloques 2x2
    for y in range(size - 1):
        for x in range(size - 1):
            c = mod[y][x]
            if c == mod[y][x + 1] == mod[y + 1][x] == mod[y + 1][x + 1]:
                res += 3
    # regla 3: patrones tipo localizador
    for y in range(size):
        bits = 0
        for x in range(size):
            bits = ((bits << 1) & 0x7FF) | (1 if mod[y][x] else 0)
            if x >= 10 and bits in (0x05D, 0x5D0):
                res += 40
    for x in range(size):
        bits = 0
        for y in range(size):
            bits = ((bits << 1) & 0x7FF) | (1 if mod[y][x] else 0)
            if y >= 10 and bits in (0x05D, 0x5D0):
                res += 40
    # regla 4: proporción de oscuros
    dark = sum(1 for row in mod for c in row if c)
    total = size * size
    k = (abs(dark * 20 - total * 10) + total - 1) // total - 1
    res += k * 10
    return res


# --- render ----------------------------------------------------------------- #
def render(text: str, quiet: int = 4) -> str:
    """Devuelve el QR como texto (medios bloques unicode, fondo claro forzado
    con códigos ANSI para que sea escaneable en cualquier tema de terminal)."""
    mod = _build(text.encode())
    size = len(mod)
    n = size + 2 * quiet

    def dark(x, y):
        gx, gy = x - quiet, y - quiet
        return 0 <= gx < size and 0 <= gy < size and mod[gy][gx]

    WB, BB = "\x1b[47m", "\x1b[40m"   # fondo blanco / negro
    WF, BF = "\x1b[37m", "\x1b[30m"   # texto blanco / negro
    RESET = "\x1b[0m"
    out = []
    for y in range(0, n, 2):
        line = []
        for x in range(n):
            top = dark(x, y)
            bot = dark(x, y + 1) if y + 1 < n else False
            fg = BF if top else WF
            bg = BB if bot else WB
            line.append(fg + bg + "▀")  # ▀ (mitad superior)
        out.append("".join(line) + RESET)
    return "\n".join(out)


if __name__ == "__main__":
    import sys
    print(render(sys.argv[1] if len(sys.argv) > 1 else "https://anthropic.com"))
