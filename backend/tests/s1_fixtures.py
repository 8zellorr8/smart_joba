"""Synthetic workbooks only. No college records are copied into test sources."""
from io import BytesIO
import zipfile
from openpyxl import Workbook

HEADER = ["Мұғалім", "Пән", "Индекс", "Группа", "Курс", "Кабинет", "Сағат/апта", "Топ",
          "мамандығы", "Біліктілік", "Семестрдегі жалпы сағат саны", "Семестр"]
ROW = ["Синтетикалық мұғалім", "Синтетикалық пән", "TEST-01", "TEST-A", 1, 0, 2, None,
       "Синтетикалық мамандық", "Синтетикалық біліктілік", 36, 1]


def workbook(rows=None, stray=False):
    book = Workbook()
    sheet = book.active
    sheet.title = "Жүктеме"
    sheet.append(HEADER)
    for row in rows if rows is not None else [ROW]:
        sheet.append(row)
    stream = BytesIO()
    book.save(stream)
    content = stream.getvalue()
    if stray:
        content = modify_zip(content, "xl/worksheets/sheet1.xml", lambda xml:
            xml.replace(b'<dimension ref="A1:L2"', b'<dimension ref="A1:N1048570"')
               .replace(b'</sheetData>', b'<row r="1048570"><c r="I1048570" t="inlineStr"><is><t>unused</t></is></c></row></sheetData>'))
    return content


def modify_zip(content, filename, transform):
    result = BytesIO()
    with zipfile.ZipFile(BytesIO(content)) as source, zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as target:
        for entry in source.infolist():
            data = source.read(entry)
            target.writestr(entry.filename, transform(data) if entry.filename == filename else data)
    return result.getvalue()
