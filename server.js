const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const childProcess = require("child_process");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const TOKEN_FILE = path.join(DATA_DIR, "xero-tokens.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const CONFIG_FILE = path.join(ROOT, ".xero-config.json");
const ENV_FILE = path.join(ROOT, ".env");
const PDF_PARSER_FILE = path.join(ROOT, "tools", "parse_aaf_pdf.py");

loadDotEnv(ENV_FILE);
loadJsonConfig(CONFIG_FILE);

const PORT = Number(process.env.PORT || 3030);
const SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "email",
  "accounting.invoices",
  "accounting.payments",
  "accounting.banktransactions",
  "accounting.contacts",
  "accounting.settings"
].join(" ");

let pendingState = null;
let lastXeroRequestAt = 0;

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadJsonConfig(filePath) {
  if (!fs.existsSync(filePath)) return;
  const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(config)) {
    if (!process.env[key] && value) process.env[key] = String(value);
  }
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function getXeroConfig() {
  return {
    clientId: process.env.XERO_CLIENT_ID || "",
    clientSecret: process.env.XERO_CLIENT_SECRET || "",
    redirectUri: process.env.XERO_REDIRECT_URI || `http://localhost:${PORT}/auth/callback`
  };
}

function configured() {
  const config = getXeroConfig();
  return Boolean(config.clientId && config.clientSecret);
}

function send(res, status, body, contentType = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload, null, 2));
}

function sendText(res, status, payload, contentType = "text/plain; charset=utf-8") {
  send(res, status, payload, contentType);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function savedConnection() {
  if (!fs.existsSync(TOKEN_FILE)) return null;
  return readJson(TOKEN_FILE, null);
}

function activeTenant(saved) {
  const settings = readJson(SETTINGS_FILE, {});
  const tenants = saved && Array.isArray(saved.tenants) ? saved.tenants : [];
  return tenants.find((tenant) => tenant.tenantId === settings.activeTenantId) || tenants[0] || null;
}

async function refreshTokensIfNeeded(saved) {
  if (!saved) throw new Error("Xero is not connected yet.");
  if (new Date(saved.expires_at).getTime() > Date.now() + 120000) return saved;

  const config = getXeroConfig();
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: saved.refresh_token
  });

  const response = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Xero token refresh failed: ${JSON.stringify(payload)}`);

  const refreshed = {
    ...saved,
    refreshed_at: new Date().toISOString(),
    scope: payload.scope,
    expires_at: new Date(Date.now() + payload.expires_in * 1000).toISOString(),
    access_token: payload.access_token,
    refresh_token: payload.refresh_token
  };
  writeJson(TOKEN_FILE, refreshed);
  return refreshed;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function xeroGet(saved, endpoint, params = {}) {
  const tenant = activeTenant(saved);
  if (!tenant) throw new Error("No Xero tenant is selected.");

  const elapsed = Date.now() - lastXeroRequestAt;
  if (elapsed < 400) await delay(400 - elapsed);

  const url = new URL(`https://api.xero.com/api.xro/2.0/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${saved.access_token}`,
      "Xero-tenant-id": tenant.tenantId,
      Accept: "application/json"
    }
  });
  lastXeroRequestAt = Date.now();

  if (response.status === 429) {
    const retryAfter = Number(response.headers.get("Retry-After") || 2);
    await delay(Math.max(1, retryAfter) * 1000);
    return xeroGet(saved, endpoint, params);
  }

  const payload = await response.json();
  if (!response.ok) throw new Error(`Xero API error ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function exchangeCodeForTokens(code) {
  const config = getXeroConfig();
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri
  });
  const response = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Xero auth failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function getTenants(accessToken) {
  const response = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Xero tenant lookup failed: ${JSON.stringify(payload)}`);
  return payload;
}

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];
    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      index += 1;
    } else if (char === "\"") {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function parseAmount(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value)
    .replace(/\s/g, "")
    .replace(/[R$,]/g, "")
    .replace(/^\((.*)\)$/, "-$1");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100) / 100;
}

function findInvoiceNumber(text, patterns) {
  const haystack = String(text || "");
  for (const pattern of patterns) {
    const match = haystack.match(new RegExp(pattern, "i"));
    if (match) return match[1] || match[0];
  }
  return "";
}

function parseRemittance(content, options = {}) {
  const patterns = Array.isArray(options.invoicePatterns) && options.invoicePatterns.length
    ? options.invoicePatterns
    : ["\\b(INV[-\\s]?[A-Z0-9-]+)\\b", "\\b([A-Z]{2,5}\\d{4,})\\b", "\\b(\\d{5,})\\b"];

  const lines = content.replace(/\r\n/g, "\n").split("\n").filter((line) => line.trim());
  if (!lines.length) return { rows: [], warnings: ["The remittance file was empty."] };

  const firstLine = parseCsvLine(lines[0]);
  const hasHeader = firstLine.some((cell) => /invoice|document|reference|amount|paid|payment|deduction|reason/i.test(cell));
  const headers = hasHeader ? firstLine.map((cell, index) => cell || `Column ${index + 1}`) : [];
  const dataLines = hasHeader ? lines.slice(1) : lines;

  const rows = dataLines.map((line, index) => {
    const cells = parseCsvLine(line);
    const source = {};
    cells.forEach((cell, cellIndex) => {
      source[headers[cellIndex] || `Column ${cellIndex + 1}`] = cell;
    });

    const combined = cells.join(" ");
    const invoiceNumber = findInvoiceNumber(combined, patterns);
    const amountCandidates = cells.map(parseAmount).filter((amount) => amount !== null);
    const paidAmount = amountCandidates.length ? amountCandidates[amountCandidates.length - 1] : null;
    const deductionAmount = amountCandidates.length > 1 ? amountCandidates.slice(0, -1).find((amount) => amount < 0) : null;

    return {
      rowNumber: hasHeader ? index + 2 : index + 1,
      invoiceNumber,
      paidAmount,
      deductionAmount,
      raw: line,
      source
    };
  }).filter((row) => row.invoiceNumber || row.paidAmount !== null);

  const warnings = [];
  if (!rows.length) warnings.push("No invoice numbers or amounts were detected. We may need a parser for this remittance format.");
  return { rows, warnings };
}

function pythonExecutable() {
  const bundled = "C:\\Users\\marti\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
  if (process.env.PDF_PYTHON_PATH) return process.env.PDF_PYTHON_PATH;
  if (fs.existsSync(bundled)) return bundled;
  return "python";
}

function execFile(command, args) {
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, args, { cwd: ROOT, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr || ""}`.trim();
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

function safeUploadName(name) {
  return path.basename(String(name || "remittance.pdf")).replace(/[^\w .()_-]/g, "_");
}

async function parsePdfRemittance(body) {
  if (!body.contentBase64) throw new Error("PDF preview needs contentBase64.");
  ensureDataDir();
  const uploadDir = path.join(DATA_DIR, "uploads");
  fs.mkdirSync(uploadDir, { recursive: true });
  const fileName = safeUploadName(body.fileName);
  const uploadPath = path.join(uploadDir, `${Date.now()}-${fileName}`);
  fs.writeFileSync(uploadPath, Buffer.from(body.contentBase64, "base64"));
  const stdout = await execFile(pythonExecutable(), [PDF_PARSER_FILE, uploadPath]);
  const parsed = JSON.parse(stdout);
  if (parsed.fields) parsed.fields.sourceFile = fileName;
  if (Array.isArray(parsed.rows)) {
    parsed.rows = parsed.rows.map((row) => ({
      ...row,
      source: row.source ? { ...row.source, sourceFile: fileName } : row.source
    }));
  }
  return {
    ...parsed,
    parser: "aaf_trade_finance_pdf"
  };
}

async function parseIncomingRemittance(body) {
  const fileName = String(body.fileName || "");
  if (/\.pdf$/i.test(fileName) || body.contentBase64) {
    return parsePdfRemittance(body);
  }
  return parseRemittance(String(body.content || ""), body.options || {});
}

function normaliseInvoiceNumber(value) {
  return String(value || "").replace(/\s+/g, "").toUpperCase();
}

function xeroString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

async function findXeroInvoice(saved, invoiceNumber) {
  const value = xeroString(invoiceNumber);
  const payload = await xeroGet(saved, "Invoices", {
    where: `(InvoiceNumber=="${value}"||Reference=="${value}")&&Status!="DELETED"`,
    page: "1"
  });
  return (payload.Invoices || [])[0] || null;
}

function invoiceNumbersForRow(row) {
  if (Array.isArray(row.invoiceNumbers) && row.invoiceNumbers.length) return row.invoiceNumbers;
  return String(row.invoiceNumber || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function xeroInvoiceSummary(invoice) {
  if (!invoice) return null;
  return {
    invoiceId: invoice.InvoiceID,
    invoiceNumber: invoice.InvoiceNumber,
    reference: invoice.Reference,
    contact: invoice.Contact && invoice.Contact.Name,
    date: invoice.DateString,
    dueDate: invoice.DueDateString,
    status: invoice.Status,
    amountDue: typeof invoice.AmountDue === "number" ? invoice.AmountDue : null,
    total: typeof invoice.Total === "number" ? invoice.Total : null,
    currencyCode: invoice.CurrencyCode || null
  };
}

function actionProposal(row, xeroInvoices) {
  if (row.kind !== "aaf_trade_finance") return null;
  const paymentAmount = typeof row.paidAmount === "number" ? row.paidAmount : null;
  const financeCharge = typeof row.financeChargeInvoiceCurrency === "number" ? row.financeChargeInvoiceCurrency : null;
  return {
    mode: "review-only",
    payment: {
      type: "partial-payment",
      amount: paymentAmount,
      currency: row.currency || (xeroInvoices[0] && xeroInvoices[0].currencyCode) || null,
      note: "Apply as a partial payment against the settled invoice amount shown in the AAF costing block."
    },
    financeChargeCreditNote: {
      amount: financeCharge,
      currency: row.currency || null,
      sourceAmountZar: row.financeChargeZar || null,
      exchangeRate: row.exchangeRate || null,
      note: "Finance charge is shown in ZAR by AAF and converted back to invoice currency for non-ZAR Xero invoices."
    },
    drawingProceeds: {
      amountZar: row.drawingProceedsZar || null,
      note: "Net proceeds after AAF finance charges; kept for review and bank-receipt reconciliation."
    },
    allocation: xeroInvoices.length > 1
      ? "Multiple invoices found on one quote. Review allocation before posting."
      : "Single invoice; payment and credit-note proposal can be posted after review."
  };
}

async function reconcileRows(rows) {
  const saved = await refreshTokensIfNeeded(savedConnection());
  const cache = new Map();
  const results = [];

  for (const row of rows.slice(0, 200)) {
    const invoiceNumbers = invoiceNumbersForRow(row);
    const invoices = [];
    for (const invoiceNumber of invoiceNumbers) {
      const key = normaliseInvoiceNumber(invoiceNumber);
      if (!key) continue;
      if (!cache.has(key)) cache.set(key, await findXeroInvoice(saved, invoiceNumber));
      const invoice = cache.get(key);
      if (invoice) invoices.push(invoice);
    }

    const xeroInvoices = invoices.map(xeroInvoiceSummary);
    const amountDue = xeroInvoices.length ? Math.round(xeroInvoices.reduce((sum, invoice) => sum + (invoice.amountDue || 0), 0) * 100) / 100 : null;
    const total = xeroInvoices.length ? Math.round(xeroInvoices.reduce((sum, invoice) => sum + (invoice.total || 0), 0) * 100) / 100 : null;
    const paid = typeof row.paidAmount === "number" ? row.paidAmount : null;
    const expectedOutstanding = typeof row.outstandingAmount === "number" ? row.outstandingAmount : null;
    const variance = expectedOutstanding !== null && amountDue !== null
      ? Math.round((amountDue - expectedOutstanding) * 100) / 100
      : paid !== null && amountDue !== null
        ? Math.round((paid - amountDue) * 100) / 100
        : null;
    const matched = invoiceNumbers.length > 0 && invoices.length === invoiceNumbers.length;
    const status = !invoiceNumbers.length
      ? "missing-invoice-number"
      : !matched
        ? "not-found-in-xero"
        : row.kind === "aaf_trade_finance" && xeroInvoices.length > 1
          ? "matched-multiple-review"
          : row.kind === "aaf_trade_finance" && paid !== null && amountDue !== null && paid < amountDue
            ? "partial-payment"
        : variance === null
          ? "matched-no-amount"
        : Math.abs(variance) <= 0.01
          ? "matched"
          : variance < 0
            ? "short-paid"
            : "over-paid";

    results.push({
      ...row,
      status,
      variance,
      xero: xeroInvoices[0] || null,
      xeroInvoices,
      xeroAmountDueTotal: amountDue,
      xeroTotal: total,
      actionProposal: actionProposal(row, xeroInvoices)
    });
  }

  return {
    tenant: activeTenant(saved),
    processed: results.length,
    truncated: rows.length > 200,
    results,
    summary: results.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {})
  };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (!/[",\n]/.test(text)) return text;
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function reconciliationCsv(results) {
  const headers = [
    "rowNumber",
    "invoiceNumber",
    "paidAmount",
    "outstandingAmount",
    "currency",
    "exchangeRate",
    "financeChargeZar",
    "financeChargeInvoiceCurrency",
    "drawingProceedsZar",
    "status",
    "variance",
    "xeroInvoiceNumber",
    "xeroContact",
    "xeroAmountDue",
    "xeroTotal"
  ];
  const lines = [headers.join(",")];
  for (const row of results) {
    lines.push(headers.map((header) => {
      if (header === "xeroInvoiceNumber") return csvEscape(row.xero && row.xero.invoiceNumber);
      if (header === "xeroContact") return csvEscape(row.xero && row.xero.contact);
      if (header === "xeroAmountDue") return csvEscape(row.xero && row.xero.amountDue);
      if (header === "xeroTotal") return csvEscape(row.xero && row.xero.total);
      return csvEscape(row[header]);
    }).join(","));
  }
  return lines.join("\n");
}

function statusPayload() {
  const saved = savedConnection();
  const settings = readJson(SETTINGS_FILE, {});
  const tenants = saved && Array.isArray(saved.tenants) ? saved.tenants.map((tenant) => ({
    tenantId: tenant.tenantId,
    tenantName: tenant.tenantName,
    tenantType: tenant.tenantType,
    selected: tenant.tenantId === (settings.activeTenantId || (activeTenant(saved) && activeTenant(saved).tenantId))
  })) : [];

  return {
    configured: configured(),
    connected: Boolean(saved),
    redirectUri: getXeroConfig().redirectUri,
    expiresAt: saved && saved.expires_at,
    tenants,
    activeTenant: saved && activeTenant(saved),
    scope: saved && saved.scope
  };
}

function serveStatic(req, res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8"
  };
  sendText(res, 200, fs.readFileSync(filePath, "utf8"), contentTypes[ext] || "text/plain; charset=utf-8");
  return true;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/status") {
    sendJson(res, 200, statusPayload());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/config") {
    const body = JSON.parse(await readBody(req) || "{}");
    const config = {
      XERO_CLIENT_ID: String(body.clientId || "").trim(),
      XERO_CLIENT_SECRET: String(body.clientSecret || "").trim(),
      XERO_REDIRECT_URI: String(body.redirectUri || getXeroConfig().redirectUri).trim()
    };
    if (!config.XERO_CLIENT_ID || !config.XERO_CLIENT_SECRET) {
      sendJson(res, 400, { error: "Client ID and client secret are required." });
      return true;
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    Object.assign(process.env, config);
    sendJson(res, 200, { ok: true, redirectUri: getXeroConfig().redirectUri });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/tenant") {
    const body = JSON.parse(await readBody(req) || "{}");
    const saved = savedConnection();
    const tenants = saved && Array.isArray(saved.tenants) ? saved.tenants : [];
    if (!tenants.some((tenant) => tenant.tenantId === body.tenantId)) {
      sendJson(res, 400, { error: "That tenant is not available for the current Xero connection." });
      return true;
    }
    writeJson(SETTINGS_FILE, { ...readJson(SETTINGS_FILE, {}), activeTenantId: body.tenantId });
    sendJson(res, 200, statusPayload());
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/remittance/preview") {
    const body = JSON.parse(await readBody(req) || "{}");
    const parsed = await parseIncomingRemittance(body);
    sendJson(res, 200, parsed);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/reconcile") {
    const body = JSON.parse(await readBody(req) || "{}");
    if (!savedConnection()) {
      sendJson(res, 401, { error: "Connect Xero before reconciling." });
      return true;
    }
    const output = await reconcileRows(Array.isArray(body.rows) ? body.rows : []);
    sendJson(res, 200, output);
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/reconcile/export") {
    const body = JSON.parse(await readBody(req) || "{}");
    sendText(res, 200, reconciliationCsv(Array.isArray(body.results) ? body.results : []), "text/csv; charset=utf-8");
    return true;
  }

  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname === "/auth/login") {
      if (!configured()) {
        res.writeHead(302, { Location: "/?setup=required" });
        res.end();
        return;
      }
      pendingState = crypto.randomBytes(24).toString("hex");
      const authUrl = new URL("https://login.xero.com/identity/connect/authorize");
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("client_id", getXeroConfig().clientId);
      authUrl.searchParams.set("redirect_uri", getXeroConfig().redirectUri);
      authUrl.searchParams.set("scope", SCOPES);
      authUrl.searchParams.set("state", pendingState);
      res.writeHead(302, { Location: authUrl.toString() });
      res.end();
      return;
    }

    if (url.pathname === "/auth/callback") {
      if (!configured()) {
        sendText(res, 500, "Xero config is missing. Return to / and complete setup.");
        return;
      }
      const error = url.searchParams.get("error");
      if (error) {
        sendText(res, 400, `Xero auth error: ${error}`);
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state || state !== pendingState) {
        sendText(res, 400, "Invalid Xero callback. Missing code or state mismatch.");
        return;
      }
      const tokens = await exchangeCodeForTokens(code);
      const tenants = await getTenants(tokens.access_token);
      const saved = {
        connected_at: new Date().toISOString(),
        redirect_uri: getXeroConfig().redirectUri,
        scope: tokens.scope,
        expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        tenants
      };
      writeJson(TOKEN_FILE, saved);
      if (tenants[0]) writeJson(SETTINGS_FILE, { ...readJson(SETTINGS_FILE, {}), activeTenantId: tenants[0].tenantId });
      res.writeHead(302, { Location: "/?connected=1" });
      res.end();
      return;
    }

    if (url.pathname.startsWith("/api/") && await handleApi(req, res, url)) return;
    if (serveStatic(req, res, url.pathname)) return;

    sendText(res, 404, "Not found");
  } catch (error) {
    const isApi = req.url && req.url.startsWith("/api/");
    if (isApi) sendJson(res, 500, { error: String(error.message || error), stack: String(error.stack || "") });
    else sendText(res, 500, `<h1>Server error</h1><pre>${escapeHtml(error.stack || error)}</pre>`, "text/html; charset=utf-8");
  }
});

server.listen(PORT, () => {
  console.log(`Xero remittance processor running at http://localhost:${PORT}`);
});
