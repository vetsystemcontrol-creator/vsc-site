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
    # A CENA da equipe discutindo o tratamento — o argumento visual de que o sistema
    # atende a clínica inteira. O recorte exclui o título escrito na arte e as
    # miniaturas das laterais; só a mesa e os quatro personagens.
    {
        "name": "equipe",
        "file": "Gemini_Generated_Image_kdjaw9kdjaw9kdja.png",
        "crop": (232, 478, 848, 1024),
        "height": 780,
        "keep_all": True,  # a cena tem mesa, monitor e tablet: não filtrar por corpo
    },
    # Gato ISOLADO (arte regerada). As versões anteriores saíam da arte em GRUPO,
    # onde o cão encosta nele: qualquer retângulo ou cortava o casaco em linha reta
    # ou trazia a manga do vizinho — e como os corpos se tocam, nem o filtro de
    # maior corpo separava.
    {
        "name": "gato",
        "file": "Gemini_Generated_Image_g8x4x6g8x4x6g8x4.png",
        "height": 900,
    },
]


def cutout(session, path: Path) -> Image.Image:
    """Remove o fundo da imagem inteira e devolve RGBA com alfa real."""
    raw = path.read_bytes()
    return Image.open(BytesIO(remove(raw, session=session))).convert("RGBA")


def detect_board(image: Image.Image) -> tuple[int, int, float] | None:
    """
    Descobre o tabuleiro desenhado pela IA: cor clara, cor escura e o tamanho da
    célula — lendo o canto da imagem ORIGINAL (que é fundo puro).
    """
    probe = image.convert("RGB").crop((0, 0, 240, 240))
    pixels = probe.load()

    tones: dict[int, int] = {}
    for y in range(240):
        for x in range(240):
            r, g, b = pixels[x, y]
            if max(r, g, b) - min(r, g, b) <= 8:  # acromático = fundo
                tone = (r + g + b) // 3
                tones[tone] = tones.get(tone, 0) + 1

    if len(tones) < 2:
        return None

    ranked = sorted(tones.items(), key=lambda item: -item[1])
    first = ranked[0][0]
    second = next((tone for tone, _ in ranked if abs(tone - first) > 20), None)
    if second is None:
        return None

    light, dark = max(first, second), min(first, second)
    middle = (light + dark) / 2

    runs, start = [], 0
    was_light = sum(pixels[0, 3]) / 3 >= middle
    for x in range(1, 240):
        is_light = sum(pixels[x, 3]) / 3 >= middle
        if is_light != was_light:
            runs.append(x - start)
            start, was_light = x, is_light

    cell = sum(runs) / len(runs) if len(runs) >= 4 else 21.0
    return light, dark, max(6.0, cell)


def erase_checker_inside(
    image: Image.Image, board: tuple[int, int, float], offset: tuple[int, int]
) -> Image.Image:
    """
    Apaga o xadrez que sobrou DENTRO do recorte.

    O modelo (rembg) tira o fundo de FORA, mas o xadrez desenhado entre os
    personagens e sobre a mesa ele entende como parte do sujeito — e mantém.

    O teste é de DUAS CÉLULAS, e é isso que protege o jaleco: um pixel só é fundo
    se ele bate com a cor esperada da SUA célula E o pixel a uma célula de
    distância bate com a cor esperada da célula VIZINHA (que é a oposta). O
    tabuleiro alterna claro/escuro; o jaleco branco é uniforme — ele passa no
    primeiro teste, mas nunca no segundo. Foi assim que o recorte por cor deixou de
    comer o jaleco.
    """
    light, dark, cell = board
    ox, oy = offset
    tolerance = min(16, (light - dark) // 3)
    step = int(round(cell))

    rgba = image.convert("RGBA")
    pixels = rgba.load()
    width, height = rgba.size

    def expected(x: int, y: int) -> int:
        cx = int((x + ox) // cell)
        cy = int((y + oy) // cell)
        return light if (cx + cy) % 2 == 0 else dark

    def matches(x: int, y: int) -> bool:
        if not (0 <= x < width and 0 <= y < height):
            return False
        r, g, b, a = pixels[x, y]
        if a == 0:
            return True
        if max(r, g, b) - min(r, g, b) > 10:  # tem cor → é o personagem
            return False
        return abs((r + g + b) // 3 - expected(x, y)) <= tolerance

    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            if matches(x, y) and (matches(x + step, y) or matches(x - step, y)):
                pixels[x, y] = (r, g, b, 0)

    return rgba


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


def find_phase(original: Image.Image, board: tuple[int, int, float]) -> tuple[int, int]:
    """Acha o deslocamento do tabuleiro testando os offsets contra a moldura."""
    light, dark, cell = board
    tolerance = min(16, (light - dark) // 3)
    rgb = original.convert("RGB")
    pixels = rgb.load()
    width, height = rgb.size

    border = [(x, y) for x in range(0, width, 5) for y in (2, 6, height - 3)]
    border += [(x, y) for y in range(0, height, 5) for x in (2, 6, width - 3)]

    best, best_hits = (0, 0), -1
    for oy in range(0, int(cell)):
        for ox in range(0, int(cell)):
            hits = 0
            for x, y in border:
                r, g, b = pixels[x, y]
                if max(r, g, b) - min(r, g, b) > 8:
                    continue
                cx = int((x + ox) // cell)
                cy = int((y + oy) // cell)
                want = light if (cx + cy) % 2 == 0 else dark
                if abs((r + g + b) // 3 - want) <= tolerance:
                    hits += 1
            if hits > best_hits:
                best, best_hits = (ox, oy), hits

    return best


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    session = new_session("isnet-general-use")  # melhor recorte p/ pelo e cauda

    cache: dict[str, Image.Image] = {}

    for job in JOBS:
        source = job["file"]
        if source not in cache:
            cut = cutout(session, SOURCE_DIR / source)

            # 2ª passada: apaga o xadrez que o modelo manteve DENTRO da cena.
            original = Image.open(SOURCE_DIR / source)
            board = detect_board(original)
            if board:
                cut = erase_checker_inside(cut, board, find_phase(original, board))

            cache[source] = cut

        image = cache[source]
        if job.get("crop"):
            image = image.crop(job["crop"])
            # `keep_all`: numa CENA, mesa, tablet e xícara são corpos separados —
            # ficar só com o maior apagaria metade da ilustração.
            if not job.get("keep_all"):
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
