# Minimalist Wine Xero Remittance Processor

Local Node app for parsing AAF trade-finance remittance PDFs and matching them to Xero invoices.

## Render

Use the included `render.yaml` blueprint, or configure the service manually:

- Runtime: Node
- Build command: `npm install && python3 -m pip install --user -r requirements.txt`
- Start command: `npm start`

Add the Xero app credentials in the web UI or as environment variables:

- `XERO_CLIENT_ID`
- `XERO_CLIENT_SECRET`
- `XERO_REDIRECT_URI`
