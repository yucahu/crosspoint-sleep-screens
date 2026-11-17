"""Independent check of the generated BMPs: parses the headers the way
CrossPoint's lib/GfxRenderer/Bitmap.cpp does, then tries PIL as a second
opinion (PIL only speaks standard depths, so 2bpp is expected to fail there)."""
import struct, sys, glob

def parse(path):
    d = open(path, 'rb').read()
    bfType, bfSize, _, _, bfOffBits = struct.unpack_from('<HIHHI', d, 0)
    (biSize, biWidth, biHeight, biPlanes, biBitCount, biCompression,
     biSizeImage, _, _, biClrUsed, biClrImportant) = struct.unpack_from('<IiiHHIIiiII', d, 14)
    topDown = biHeight < 0
    height = -biHeight if topDown else biHeight
    stride = ((biWidth * biBitCount + 31) >> 5) << 2
    pal = []
    for i in range(biClrUsed):
        o = 14 + biSize + i * 4
        pal.append(tuple(d[o:o+4]))
    checks = {
        'magic BM': bfType == 0x4D42,
        'bfSize == file length': bfSize == len(d),
        'DIB is BITMAPINFOHEADER(40)': biSize == 40,
        'planes == 1': biPlanes == 1,
        'bpp in {1,2,4,8,24,32}': biBitCount in (1, 2, 4, 8, 24, 32),
        'BI_RGB (uncompressed)': biCompression == 0,
        'top-down (negative height)': topDown,
        'biSizeImage == stride*height': biSizeImage == stride * height,
        'bfOffBits == 14+40+palette': bfOffBits == 14 + 40 + biClrUsed * 4,
        'pixel data length exact': len(d) - bfOffBits == stride * height,
        'palette is greyscale (B==G==R)': all(p[0] == p[1] == p[2] for p in pal),
    }
    print(f'\n{path.split("/")[-1]}: {biWidth}x{height} {biBitCount}bpp '
          f'stride={stride} palette={[p[0] for p in pal]}')
    ok = True
    for name, passed in checks.items():
        print(f'   {"PASS" if passed else "FAIL"}  {name}')
        ok &= passed

    # Decode a few pixels to confirm MSB-first packing and the ramp direction.
    bpp = biBitCount
    per = 8 // bpp
    mask = (1 << bpp) - 1
    def px(x, y):
        byte = d[bfOffBits + y * stride + x // per]
        shift = 8 - bpp - (x % per) * bpp
        return (byte >> shift) & mask
    tl = [px(x, 5) for x in range(8)]
    tr = [px(biWidth - 1 - x, 5) for x in range(8)]
    print(f'   top-left 8px (black box)  = {tl}')
    print(f'   top-right 8px (white box) = {tr}')
    ok &= all(v == 0 for v in tl)
    ok &= all(v == mask for v in tr)
    print(f'   {"PASS" if all(v == 0 for v in tl) else "FAIL"}  black box reads as level 0')
    print(f'   {"PASS" if all(v == mask for v in tr) else "FAIL"}  white box reads as max level')

    try:
        from PIL import Image
        im = Image.open(path); im.load()
        print(f'   PIL: opened as {im.mode} {im.size}')
    except Exception as e:
        print(f'   PIL: cannot read ({type(e).__name__}: {e})')
    return ok

allok = True
for p in sorted(glob.glob(sys.argv[1])):
    allok &= parse(p)
print('\nOVERALL:', 'all structural checks passed' if allok else 'FAILURES PRESENT')
