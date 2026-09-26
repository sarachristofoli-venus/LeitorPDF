# Gera build/icon.png e build/icon.ico
from PIL import Image, ImageDraw, ImageFont
S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle((64, 64, S-64, S-64), radius=200, fill=(214, 48, 49, 255))
# folha
d.polygon([(300, 200), (620, 200), (740, 320), (740, 820), (300, 820)], fill=(255, 255, 255, 255))
d.polygon([(620, 200), (620, 320), (740, 320)], fill=(240, 190, 190, 255))
for i, y in enumerate(range(400, 760, 70)):
    d.rounded_rectangle((360, y, 680 if i % 2 == 0 else 600, y + 28), radius=14, fill=(214, 48, 49, 200))
img.save("build/icon.png")
img.resize((256, 256), Image.LANCZOS).save("build/icon.ico", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
print("ok")
