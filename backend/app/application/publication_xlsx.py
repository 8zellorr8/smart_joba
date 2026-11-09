"""XLSX for one authorized, immutable publication view."""
from io import BytesIO

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter


def build_workbook(view, start, end, resource_kind, resource_id):
    book = Workbook()
    sheet = book.active
    sheet.title = "Сабақ кестесі"

    def row(values):
        sheet.append(values)
        for cell in sheet[sheet.max_row]:
            if isinstance(cell.value, str):
                # openpyxl otherwise turns strings beginning with '=' into executable formulas.
                cell.data_type = "s"
                cell.number_format = "@"

    row(["Smart Joba · жарияланған сабақ кестесі"])
    row(["Нұсқа", view["version_number"], "Мазмұн редакциясы", view["revision"]])
    row(["Жарияланым ID", view["publication_id"], "Жарияланған уақыты", view["published_at"]])
    row(["Жұмыс аймағы", view["scope_name"], "Оқу жылы", view["academic_year"]])
    row(["Семестр", view["semester"], "Уақыт белдеуі", view["timezone"]])
    row(["Күндер аралығы", f"{start} — {end}" if start else "Барлық күндер"])
    resource = next((item["name"] for item in view["resources"][resource_kind]
                     if item["id"] == resource_id), "Барлығы")
    row(["Көрініс", {"group": "Топ", "teacher": "Оқытушы", "room": "Кабинет"}[resource_kind],
         "Көрсетілетін ресурс", resource])
    if view["data_kind"] == "synthetic":
        row(["Демонстрациялық деректер · колледж деректері емес"])
    row([])
    heading_row = sheet.max_row + 1
    row(["Күні", "Басталуы", "Аяқталуы", "Топ", "Пән", "Оқытушы", "Кабинет"])
    for event in view["events"]:
        row([event["date"], event["start"], event["end"], event["group"], event["subject"], event["teacher"], event["room"]])

    sheet.freeze_panes = f"A{heading_row + 1}"
    sheet.auto_filter.ref = f"A{heading_row}:G{sheet.max_row}"
    for column, width in enumerate((17, 14, 14, 24, 38, 30, 20), 1):
        sheet.column_dimensions[get_column_letter(column)].width = width
    for cell in sheet[heading_row]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="155B48")
        cell.alignment = Alignment(wrap_text=True)
    sheet.row_dimensions[heading_row].height = 28
    for row_cells in sheet.iter_rows(min_row=heading_row + 1):
        for cell in row_cells:
            cell.alignment = Alignment(vertical="top", wrap_text=True)

    output = BytesIO()
    book.save(output)
    return output.getvalue()
