# Генерирует тестовые FB2-файлы (utf-8, windows-1251, zip/deflate, zip/stored).
import base64, os, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

PARAS = [
    "Первое предложение абзаца. Второе предложение, подлиннее, чтобы текст выглядел естественно.",
    "Ещё один абзац с <emphasis>курсивом</emphasis> и <strong>полужирным</strong> внутри.",
    "Третий абзац проверяет переносы и выравнивание по ширине в читалке. " * 3,
    "Абзац со сноской<a l:href=\"#n1\" type=\"note\">1</a> и внешней ссылкой <a l:href=\"https://example.org\">пример</a>.",
    "Короткий абзац.",
]

def body():
    parts = []
    for sec in range(1, 6):
        parts.append(f'<section id="s{sec}">')
        parts.append(f'<title><p>Глава {sec}</p></title>')
        if sec == 1:
            parts.append('<p>Ссылка внутри книги: <a l:href="#s3">смотри главу 3</a>.</p>')
        if sec == 2:
            parts.append('<epigraph><p>Эпиграф к главе.</p><text-author>Кто-то</text-author></epigraph>')
            parts.append('<image l:href="#cover.png" title="Иллюстрация"/>')
        if sec == 3:
            parts.append('<poem><title><p>Стихи</p></title><stanza><v>Строка первая,</v><v>Строка вторая.</v></stanza><text-author>Автор</text-author></poem>')
        if sec == 4:
            parts.append('<subtitle>Подзаголовок внутри главы</subtitle>')
            parts.append('<cite><p>Цитата из чего-то важного.</p><text-author>Источник</text-author></cite>')
        for i in range(8):
            parts.append('<p>' + PARAS[i % len(PARAS)] + f' (гл.{sec}, п.{i})</p>')
            if i == 3:
                parts.append('<empty-line/>')
        if sec == 5:
            parts.append('<table><tr><th>Год</th><th>Событие</th></tr><tr><td>2024</td><td>Начало</td></tr><tr><td>2025</td><td>Продолжение</td></tr></table>')
        parts.append('</section>')
    return "\n".join(parts)

def fb2(pad=""):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
  <title-info>
    <genre>sf</genre>
    <author><first-name>Иван</first-name><last-name>Тестов</last-name></author>
    <book-title>Проверочная книга</book-title>
    <annotation><p>Аннотация для теста.{pad}</p></annotation>
    <date>2025</date>
    <coverpage><image l:href="#cover.png"/></coverpage>
    <lang>ru</lang>
    <sequence name="Серия тестов" number="3"/>
  </title-info>
  <document-info><author><nickname>tester</nickname></author><id>test-1</id><version>1.0</version></document-info>
</description>
<body>
  <title><p>Проверочная книга</p></title>
  {body()}
</body>
<body name="notes">
  <section id="n1"><title><p>1</p></title><p>Текст примечания номер один.</p></section>
</body>
<binary id="cover.png" content-type="image/png">{base64.b64encode(PNG).decode()}</binary>
</FictionBook>
'''

xml = fb2()

open(os.path.join(HERE, "sample.fb2"), "w", encoding="utf-8").write(xml)
open(os.path.join(HERE, "sample1251.fb2"), "wb").write(xml.replace('encoding="utf-8"', 'encoding="windows-1251"').encode("windows-1251"))

with zipfile.ZipFile(os.path.join(HERE, "sample.fb2.zip"), "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("Проверочная книга.fb2", xml.encode("utf-8"))

with zipfile.ZipFile(os.path.join(HERE, "sample-stored.zip"), "w", zipfile.ZIP_STORED) as z:
    z.writestr("book.fb2", xml.encode("utf-8"))

# --- кодировки ---

# 1. UTF-8, у которого 500-й байт попадает в середину многобайтового символа.
#    Именно на этом ломалось определение кодировки по обрезанному фрагменту.
cut = None
# Нужно, чтобы 500-й байт оказался ПЕРВЫМ байтом многобайтового символа:
# тогда срез [0:500] обрывается на середине и старый код видел «символ замены».
for pad_ascii in (0, 1):
    for n in range(0, 400):
        candidate = fb2(pad=" " * pad_ascii + "Ж" * n).encode("utf-8")
        if 0xC2 <= candidate[499] <= 0xDF:
            cut = candidate
            break
    if cut:
        break
if cut is None:
    raise SystemExit("не удалось подобрать смещение")
open(os.path.join(HERE, "cut-utf8.fb2"), "wb").write(cut)

# 2. Содержимое в UTF-8, но в декларации указана windows-1251 (частый брак конвертеров).
open(os.path.join(HERE, "wrong-decl.fb2"), "wb").write(
    fb2().replace('encoding="utf-8"', 'encoding="windows-1251"').encode("utf-8")
)

# 3. Windows-1251 без XML-декларации вообще.
no_decl = fb2()
no_decl = no_decl.split("\n", 1)[1]  # убираем строку <?xml ...?>
open(os.path.join(HERE, "nodecl-1251.fb2"), "wb").write(no_decl.encode("windows-1251"))

# 4. UTF-8 с BOM.
open(os.path.join(HERE, "bom-utf8.fb2"), "wb").write(b"\xef\xbb\xbf" + fb2().encode("utf-8"))

print("ok:", sorted(f for f in os.listdir(HERE) if f.endswith((".fb2", ".zip"))))
