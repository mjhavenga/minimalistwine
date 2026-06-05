const state = {
  status: null,
  parsedRows: [],
  reconcileOutput: null
};

const els = {
  connectionSummary: document.querySelector("#connectionSummary"),
  setupPanel: document.querySelector("#setupPanel"),
  setupBadge: document.querySelector("#setupBadge"),
  setupStatusText: document.querySelector("#setupStatusText"),
  organisationStatusText: document.querySelector("#organisationStatusText"),
  remittanceStatusText: document.querySelector("#remittanceStatusText"),
  configForm: document.querySelector("#configForm"),
  redirectUri: document.querySelector("#redirectUri"),
  tenantBadge: document.querySelector("#tenantBadge"),
  tenantPicker: document.querySelector("#tenantPicker"),
  fileInput: document.querySelector("#fileInput"),
  fileNameText: document.querySelector("#fileNameText"),
  patternsInput: document.querySelector("#patternsInput"),
  previewButton: document.querySelector("#previewButton"),
  reconcileButton: document.querySelector("#reconcileButton"),
  exportButton: document.querySelector("#exportButton"),
  remittanceNote: document.querySelector("#remittanceNote"),
  resultBadge: document.querySelector("#resultBadge"),
  summary: document.querySelector("#summary"),
  resultsBody: document.querySelector("#resultsBody")
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload && payload.error ? payload.error : text);
  return payload;
}

function setBusy(message) {
  els.resultBadge.textContent = message;
}

function renderStatus() {
  const status = state.status;
  els.redirectUri.value = status.redirectUri;
  els.setupPanel.style.display = status.configured ? "none" : "block";
  els.setupBadge.textContent = status.configured ? "Saved" : "Required";
  els.setupBadge.className = status.configured ? "badge" : "badge warning";
  els.setupStatusText.textContent = status.configured ? "Ready" : "Setup required";
  els.organisationStatusText.textContent = status.connected && status.activeTenant
    ? status.activeTenant.tenantName
    : "Not connected";

  if (!status.configured) {
    els.connectionSummary.textContent = "Add Xero app credentials first, then connect the organisation.";
  } else if (!status.connected) {
    els.connectionSummary.textContent = "Xero setup is saved. Connect the organisation to continue.";
  } else {
    const tenant = status.activeTenant;
    els.connectionSummary.textContent = `Connected to ${tenant ? tenant.tenantName : "Xero"}; token expires ${status.expiresAt || "unknown"}.`;
  }

  els.tenantBadge.textContent = status.connected ? "Connected" : "Not connected";
  els.tenantBadge.className = status.connected ? "badge" : "badge warning";
  if (!status.tenants.length) {
    els.tenantPicker.innerHTML = "<p class=\"muted\">No Xero organisations connected yet.</p>";
    return;
  }

  els.tenantPicker.innerHTML = "";
  for (const tenant of status.tenants) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tenantButton${tenant.selected ? " selected" : ""}`;
    button.textContent = tenant.tenantName || tenant.tenantId;
    button.addEventListener("click", async () => {
      state.status = await api("/api/tenant", {
        method: "POST",
        body: JSON.stringify({ tenantId: tenant.tenantId })
      });
      renderStatus();
    });
    els.tenantPicker.appendChild(button);
  }
}

els.fileInput.addEventListener("change", () => {
  const file = els.fileInput.files[0];
  els.fileNameText.textContent = file ? file.name : "Choose an AAF PDF or CSV";
  els.remittanceStatusText.textContent = file ? "File selected" : "Waiting for file";
});

function renderRows(rows, reconcile = false) {
  if (!rows.length) {
    els.resultsBody.innerHTML = "<tr><td colspan=\"11\" class=\"empty\">No rows to show.</td></tr>";
    return;
  }

  els.resultsBody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const xero = row.xero || {};
    const status = reconcile ? row.status : "preview";
    tr.innerHTML = `
      <td>${escapeHtml(row.rowNumber)}</td>
      <td>${escapeHtml(row.invoiceNumber || "")}</td>
      <td>${escapeHtml(formatCurrency(row.paidAmount, row.currency))}</td>
      <td>${escapeHtml(formatCurrency(row.outstandingAmount, row.currency))}</td>
      <td>${escapeHtml(formatFinanceCharge(row))}</td>
      <td>${escapeHtml(formatCurrency(row.drawingProceedsZar, "ZAR"))}</td>
      <td class="status-${escapeHtml(status)}">${escapeHtml(status)}</td>
      <td>${escapeHtml(formatMoney(row.variance))}</td>
      <td>${escapeHtml(xero.invoiceNumber || "")}</td>
      <td>${escapeHtml(xero.contact || "")}</td>
      <td>${escapeHtml(formatMoney(xero.amountDue))}</td>
    `;
    els.resultsBody.appendChild(tr);
  }
}

function renderSummary(summary) {
  els.summary.innerHTML = "";
  for (const [key, value] of Object.entries(summary || {})) {
    const item = document.createElement("div");
    item.className = "summaryItem";
    item.textContent = `${key}: ${value}`;
    els.summary.appendChild(item);
  }
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function formatMoney(value) {
  return typeof value === "number" ? value.toFixed(2) : "";
}

function formatCurrency(value, currency) {
  return typeof value === "number" ? `${currency || ""} ${value.toFixed(2)}`.trim() : "";
}

function formatFinanceCharge(row) {
  if (typeof row.financeChargeInvoiceCurrency !== "number") return "";
  const fx = formatCurrency(row.financeChargeInvoiceCurrency, row.currency);
  const zar = formatCurrency(row.financeChargeZar, "ZAR");
  return zar ? `${fx} (${zar})` : fx;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = String(reader.result || "");
      resolve(result.includes(",") ? result.split(",")[1] : result);
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

async function readSelectedFile() {
  const file = els.fileInput.files[0];
  if (!file) throw new Error("Choose a remittance file first.");
  if (/\.pdf$/i.test(file.name)) {
    return {
      fileName: file.name,
      contentBase64: await fileToBase64(file)
    };
  }
  return {
    fileName: file.name,
    content: await file.text()
  };
}

function invoicePatterns() {
  return els.patternsInput.value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
}

els.configForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(els.configForm);
  await api("/api/config", {
    method: "POST",
    body: JSON.stringify({
      clientId: form.get("clientId"),
      clientSecret: form.get("clientSecret"),
      redirectUri: form.get("redirectUri")
    })
  });
  state.status = await api("/api/status");
  renderStatus();
});

els.previewButton.addEventListener("click", async () => {
  try {
    setBusy("Parsing");
    const filePayload = await readSelectedFile();
    const parsed = await api("/api/remittance/preview", {
      method: "POST",
      body: JSON.stringify({
        ...filePayload,
        options: { invoicePatterns: invoicePatterns() }
      })
    });
    state.parsedRows = parsed.rows;
    state.reconcileOutput = null;
    els.reconcileButton.disabled = !parsed.rows.length;
    els.exportButton.disabled = true;
    els.remittanceStatusText.textContent = parsed.rows.length ? "Parsed" : "No rows detected";
    els.remittanceNote.textContent = parsed.warnings.length
      ? parsed.warnings.join(" ")
      : `${parsed.rows.length} remittance row detected${parsed.parser ? ` by ${parsed.parser}` : ""}.`;
    els.resultBadge.textContent = "Preview";
    renderSummary({ parsed: parsed.rows.length });
    renderRows(parsed.rows, false);
  } catch (error) {
    els.remittanceNote.textContent = error.message;
    setBusy("Error");
  }
});

els.reconcileButton.addEventListener("click", async () => {
  try {
    setBusy("Matching");
    const output = await api("/api/reconcile", {
      method: "POST",
      body: JSON.stringify({ rows: state.parsedRows })
    });
    state.reconcileOutput = output;
    els.exportButton.disabled = !output.results.length;
    els.resultBadge.textContent = "Matched";
    els.remittanceStatusText.textContent = output.results.length ? "Matched" : "No matches";
    renderSummary(output.summary);
    renderRows(output.results, true);
  } catch (error) {
    els.remittanceNote.textContent = error.message;
    setBusy("Error");
  }
});

els.exportButton.addEventListener("click", async () => {
  const response = await fetch("/api/reconcile/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ results: state.reconcileOutput ? state.reconcileOutput.results : [] })
  });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `xero-remittance-recon-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
});

async function init() {
  state.status = await api("/api/status");
  renderStatus();
}

init().catch((error) => {
  els.connectionSummary.textContent = error.message;
});
