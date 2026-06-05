from pathlib import Path
import json
import re
import sys
from pypdf import PdfReader

sys.stdout.reconfigure(encoding="utf-8")

F2_PAIRS = [
    ("", "Anglo African Finance"),
    ("", "PO Box 433"),
    ("", "Stellenbosch"),
    ("", "7559"),
    ("", "VAT # 4760233819"),
    ("", "Quote No:"),
    ("", "Minimalist Wine (Pty) Ltd"),
    ("", "Contact Detail:"),
    ("", "Name:  Sam Lambson"),
    ("", "Print Date:"),
    ("", "Invoice Number:"),
    ("", "Invoice Date"),
    ("", "Due Date:"),
    ("", "Order/Invoice Amount:"),
    ("", "Discount Amount"),
    ("", "Exchange Rate:"),
    ("", "R Amount:"),
    ("", "Discount Term (days):"),
    ("", "Interest Rate: (prime + margin)"),
    ("", "Interest Amount:"),
    ("", "Discount Amount nett of interest:"),
    ("", "Admin Fee (0.00%):"),
    ("", "Admin Fee (fixed):"),
    ("", "Finance Charge (1.70%):"),
    ("", "Finance Charge (fixed):"),
    ("", "Total Fees:"),
    ("", "VAT @ R  0.00 15%"),
    ("", "Drawing Proceeds"),
]

EXTRA_MAP = {
    "": "_",
    "": "-",
    "": "J",
    "": "G",
    "": ",",
    "": "Z",
}


def build_map():
    mapping = dict(EXTRA_MAP)
    for encoded, decoded in F2_PAIRS:
        for source, target in zip(encoded, decoded):
            mapping[source] = target
    return mapping


def decode_symbols(text):
    mapping = build_map()
    return "".join(mapping.get(char, char) for char in text)


def money(value):
    if value is None:
        return None
    return round(float(str(value).replace(",", "").replace("R", "").strip()), 2)


def number(value):
    if value is None:
        return None
    return float(str(value).replace(",", "").strip())


def first_match(pattern, text, flags=re.I):
    match = re.search(pattern, text, flags)
    return match.group(1).strip() if match else None


def parse_fields(text, file_name):
    clean = re.sub(r"\s+", " ", text).strip()
    invoice_area = first_match(r"((?:INV[-\s]?\d+\s*,?\s*)+)Invoice Number", clean) or ""
    invoice_numbers = re.findall(r"INV[-\s]?\d+", invoice_area, re.I)
    if not invoice_numbers:
        invoice_numbers = re.findall(r"INV[-\s]?\d+", file_name, re.I)
    invoice_numbers = [value.upper().replace(" ", "-") for value in invoice_numbers]

    amount_match = re.search(
        r"Order/Invoice Amount:\s*(?:(?P<currency1>[A-Z]{3})\s*)?(?P<amount>\d[\d,]*\.\d{2})(?:\s*(?P<currency2>[A-Z]{3}))?",
        clean,
        re.I,
    )
    currency = "ZAR"
    invoice_amount = None
    if amount_match:
        currency = (amount_match.group("currency1") or amount_match.group("currency2") or "ZAR").upper()
        invoice_amount = money(amount_match.group("amount"))

    exchange_rate = number(first_match(r"Exchange Rate:\s*(\d+(?:\.\d+)?)", clean))
    discount_amount = money(first_match(r"Discount Amount\s*(\d[\d,]*\.\d{2})", clean))
    zar_amount = money(first_match(r"Exchange Rate:\s*\d+(?:\.\d+)?\s*R\s*(\d[\d,]*\.\d{2})\s*ZAR Amount", clean))
    finance_percent = money(first_match(r"Finance Charge \(1\.70%\):\s*R\s*(\d[\d,]*\.\d{2})", clean))
    finance_fixed = money(first_match(r"Finance Charge \(fixed\):\s*R\s*(\d[\d,]*\.\d{2})", clean)) or 0
    drawing_proceeds = money(first_match(r"Drawing Proceeds\s*(\d[\d,]*\.\d{2})", clean))
    finance_charge_zar = round((finance_percent or 0) + finance_fixed, 2)
    finance_charge_invoice_currency = None
    if currency != "ZAR" and exchange_rate:
        finance_charge_invoice_currency = round(finance_charge_zar / exchange_rate, 2)
    elif currency == "ZAR":
        finance_charge_invoice_currency = finance_charge_zar

    fields = {
        "remittanceType": "aaf_trade_finance",
        "sourceFile": file_name,
        "quoteNo": first_match(r"Quote No:\s*([A-Z]+\d+(?:[_-]\d+)?)", clean),
        "invoiceNumbers": invoice_numbers,
        "invoiceDate": first_match(r"Invoice Date\s*(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})", clean),
        "dueDate": first_match(r"Due Date:?\s*(\d{1,2}\s+[A-Z][a-z]{2}\s+\d{4})", clean),
        "currency": currency,
        "invoiceAmount": invoice_amount,
        "paymentAmount": discount_amount,
        "exchangeRate": exchange_rate,
        "zarAmount": zar_amount,
        "financeChargeZar": finance_charge_zar,
        "financeChargeInvoiceCurrency": finance_charge_invoice_currency,
        "drawingProceedsZar": drawing_proceeds,
    }
    warnings = []
    for key in ["invoiceNumbers", "invoiceAmount", "paymentAmount", "exchangeRate", "financeChargeZar", "drawingProceedsZar"]:
        value = fields[key]
        if value in (None, [], ""):
            warnings.append(f"Could not detect {key}.")
    return fields, warnings, clean


def main():
    pdf_path = Path(sys.argv[1])
    reader = PdfReader(str(pdf_path))
    raw_text = "\n".join(page.extract_text() or "" for page in reader.pages)
    decoded_text = decode_symbols(raw_text)
    fields, warnings, clean = parse_fields(decoded_text, pdf_path.name)
    row = {
        "rowNumber": 1,
        "kind": "aaf_trade_finance",
        "invoiceNumber": ", ".join(fields["invoiceNumbers"]),
        "invoiceNumbers": fields["invoiceNumbers"],
        "paidAmount": fields["paymentAmount"],
        "outstandingAmount": fields["invoiceAmount"],
        "currency": fields["currency"],
        "exchangeRate": fields["exchangeRate"],
        "financeChargeZar": fields["financeChargeZar"],
        "financeChargeInvoiceCurrency": fields["financeChargeInvoiceCurrency"],
        "drawingProceedsZar": fields["drawingProceedsZar"],
        "raw": clean,
        "source": fields,
    }
    print(json.dumps({"fields": fields, "rows": [row], "warnings": warnings}, ensure_ascii=False))


if __name__ == "__main__":
    main()
