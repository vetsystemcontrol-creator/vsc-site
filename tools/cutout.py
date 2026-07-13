"""
cutout.py — recorta os mascotes gerados por IA e gera PNG com transparência REAL.

POR QUE NÃO É UM SCRIPT DE REGRA (foi a primeira tentativa, e falhou):
o gerador de imagem, ao receber "fundo transparente", DESENHOU um xadrez — os
arquivos vêm com 0% de canal alfa. Tentei remover esse xadrez por regra (cor +
fase do tabuleiro + inundação a partir da borda). O resultado, olhado de perto,
era inaceitável: sobravam manchas de xadrez e o algoritmo COMIA pedaços do jaleco
branco, que tem a mesma cor do fundo. Recorte por regra não distingue "branco do
jaleco" de "branco do fundo".

O QUE RESOLVE: um modelo de segmentação (U²-Net, via `rembg`) — a mesma classe de
ferramenta que os serviços profissionais de remoção de fundo usam. Ele entende o
SUJEITO, não a cor.

O QUE ESTE SCRIPT FAZ:
  1. rembg remove o fundo da imagem inteira (com alfa suavizado nas bordas);
  2. recorta cada personagem (as artes em grupo trazem vários);
  3. apara as margens vazias, redimensiona e grava em assets/mascotes/.

Reexecutável: se as artes forem regeradas, basta rodar de novo.
    python tools/cutout.py
"""

from io import BytesIO
from pathlib import Path

from PIL import Image
from rembg import new_session, remove

SOURCE_DIR = Path("C:/Users/User/Downloads")
OUT_DIR = Path("assets/mascotes")

# `crop`: região do personagem na imagem ORIGINAL (as artes em grupo trazem
# vários). O recorte é feito DEPOIS de remover o fundo — recortar antes tira do
# modelo o contexto de que ele precisa para separar o sujeito.
JOBS = [
    {"name": "cavalo", "file": "Mascote equino OFICIAL.png", "height": 1000},
    {"name": "cavalo-baio", "file": "Mascote equino baio.png", "height": 1000},
    {
        "name": "bovino",
        "file": "bovinoGemini_Generated_Image_sg7pcbsg7pcbsg7p.png",
        "height": 900,
    },
    # Cão e gato NÃO saem da arte em trio: lá eles se encostam, e o recorte vem
    # sempre com a manga do vizinho grudada (nem "maior corpo conectado" separa,
    # porque os corpos se tocam). Vêm da folha de variações, onde aparecem
    # ISOLADOS nos cantos — menores, mas nos cartões de espécie são exibidos
    # pequenos, então a resolução basta.
    {
        "name": "cao",
        "file": "Gemini_Generated_Image_wb4gp0wb4gp0wb4g.png",
        "crop": (838, 45, 1005, 352),
        "height": 500,
    },
    # O gato da folha de variações é pequeno demais — o modelo devolveu um
    # fantasma (alfa fraco). Este vem da arte em trio, onde ele é grande, cortando
    # DEPOIS do cão; o que sobrar de vizinho cai no filtro de maior corpo.
    {
        "name": "gato",
        "file": "Gemini_Generated_Image_vkk0g9vkk0g9vkk0.png",
        "crop": (672, 395, 950, 990),
        "height": 700,
    },
]


def cutout(session, path: Path) -> Image.Image:
    """Remove o fundo da imagem inteira e devolve RGBA com alfa real."""
    raw = path.read_bytes()
    return Image.open(BytesIO(remove(raw, session=session))).convert("RGBA")


def keep_largest_subject(image: Image.Image) -> Image.Image:
    """
    Mantém só o MAIOR corpo conectado e apaga os fragmentos soltos.

    Nas artes em grupo os personagens estão ombro a ombro: qualquer recorte
    retangular traz um pedaço do vizinho (a manga da vaca ao lado do cão, o jaleco
    do cão ao lado do gato). Apertar o enquadramento no olho é tentativa e erro;
    descartar o que não está ligado ao sujeito resolve por construção.
    """
    width, height = image.size
    alpha = image.getchannel("A").load()
    labels = [[0] * width for _ in range(height)]
    best_id, best_size, current = 0, 0, 0

    for start_y in range(height):
        for start_x in range(width):
            if labels[start_y][start_x] or alpha[start_x, start_y] <= 8:
                continue
            current += 1
            size = 0
            stack = [(start_x, start_y)]
            labels[start_y][start_x] = current
            while stack:
                x, y = stack.pop()
                size += 1
                for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                    if 0 <= nx < width and 0 <= ny < height:
                        if not labels[ny][nx] and alpha[nx, ny] > 8:
                            labels[ny][nx] = current
                            stack.append((nx, ny))
            if size > best_size:
                best_size, best_id = size, current

    if not best_id:
        return image

    cleaned = image.copy()
    pixels = cleaned.load()
    for y in range(height):
        row = labels[y]
        for x in range(width):
            if row[x] != best_id:
                r, g, b, _ = pixels[x, y]
                pixels[x, y] = (r, g, b, 0)
    return cleaned


def trim(image: Image.Image) -> Image.Image:
    """Apara as margens transparentes (alfa <= 8 é considerado vazio)."""
    alpha = image.getchannel("A").point(lambda value: 255 if value > 8 else 0)
    box = alpha.getbbox()
    return image.crop(box) if box else image


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    session = new_session("isnet-general-use")  # melhor recorte p/ pelo e cauda

    cache: dict[str, Image.Image] = {}

    for job in JOBS:
        source = job["file"]
        if source not in cache:
            cache[source] = cutout(session, SOURCE_DIR / source)

        image = cache[source]
        if job.get("crop"):
            image = image.crop(job["crop"])
            image = keep_largest_subject(image)

        image = trim(image)

        height = job["height"]
        width = max(1, round(image.width * height / image.height))
        image = image.resize((width, height), Image.LANCZOS)

        out = OUT_DIR / f"{job['name']}.png"
        image.save(out, "PNG", optimize=True)

        # WebP também: os PNGs somam ~1,3 MB e imagem pesada derruba conversão
        # (o visitante desiste antes de a página pintar). O WebP com alfa entrega
        # o mesmo resultado por ~1/4 do peso e é suportado por >97% dos
        # navegadores — é o arquivo que o site usa; o PNG fica como mestre.
        webp = OUT_DIR / f"{job['name']}.webp"
        image.save(webp, "WEBP", quality=86, method=6)

        print(
            f"OK {job['name']} - {width}x{height} - "
            f"PNG {out.stat().st_size // 1024} KB / WebP {webp.stat().st_size // 1024} KB"
        )


if __name__ == "__main__":
    main()
