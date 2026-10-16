/* ── Auth guard ─────────────────────────────────────────────────────────── */
const token = localStorage.getItem("nexushr_token");
const user = JSON.parse(localStorage.getItem("nexushr_user") || "null");

if (!token || !user) {
  window.location.href = "/index.html";
}

/* ── HTML escaping ──────────────────────────────────────────────────────── */
const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

/* ── API helper ─────────────────────────────────────────────────────────── */
async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    localStorage.clear();
    window.location.href = "/index.html";
  }
  return res.json();
}

/* ── Init UI ────────────────────────────────────────────────────────────── */
document.getElementById("sidebarName").textContent = user.name;
document.getElementById("sidebarRole").textContent = user.role;
document.getElementById("sidebarAvatar").textContent = user.name
  .charAt(0)
  .toUpperCase();
document.getElementById("welcomeMsg").textContent =
  `Hola, ${user.name.split(" ")[0]} 👋`;
document.getElementById("topbarDate").textContent =
  new Date().toLocaleDateString("es-ES", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

if (user.role === "admin") {
  document.getElementById("adminSection").style.display = "";
  document.getElementById("adminNav").style.display = "";
}

/* ── Navigation ─────────────────────────────────────────────────────────── */
const sections = {
  overview: "Resumen",
  employees: "Empleados",
  announcements: "Comunicados",
  leave: "Ausencias",
  payroll: "Nóminas",
  admin: "Administración",
};

document.querySelectorAll(".nav-item[data-section]").forEach((btn) => {
  btn.addEventListener("click", () => navigateTo(btn.dataset.section));
});

function navigateTo(name) {
  document
    .querySelectorAll(".nav-item")
    .forEach((b) => b.classList.remove("active"));
  document
    .querySelector(`.nav-item[data-section="${name}"]`)
    ?.classList.add("active");
  document
    .querySelectorAll(".section")
    .forEach((s) => s.classList.remove("active"));
  document.getElementById(`sec-${name}`)?.classList.add("active");
  document.getElementById("topbarTitle").textContent = sections[name] || name;
  if (name === "admin") loadAdmin();
  if (name === "leave") loadLeave();
  if (name === "payroll") loadPayroll();
  if (name === "announcements") loadAnnouncementsFull();
}

/* ── Overview ───────────────────────────────────────────────────────────── */
async function loadOverview() {
  const [announcements, leaveRequests] = await Promise.all([
    api("/api/announcements"),
    api("/api/leave-requests"),
  ]);

  // Stats
  if (user.role === "admin") {
    const stats = await api("/api/admin/stats");
    document.getElementById("statEmployees").textContent = stats.totalEmployees;
    document.getElementById("statSalary").textContent =
      "€" + stats.avgSalary.toLocaleString("es-ES");
    document.getElementById("statLeave").textContent = stats.pendingLeave;
    document.getElementById("statDepts").textContent =
      stats.byDepartment.length;
  } else {
    document.getElementById("statsGrid").style.display = "none";
  }

  // Announcements preview
  const el = document.getElementById("announcementsPreview");
  el.innerHTML = announcements
    .slice(0, 3)
    .map(
      (a) => `
    <div class="announcement-item">
      <div class="announcement-meta">
        ${a.pinned ? '<span class="pinned-dot"></span>' : ""}
        <span>${escapeHtml(a.author_name)}</span>
        <span>·</span>
        <span>${new Date(a.created_at).toLocaleDateString("es-ES")}</span>
      </div>
      <div class="announcement-title">${escapeHtml(a.title)}</div>
      <div class="announcement-body">${escapeHtml(a.body)}</div>
    </div>`,
    )
    .join("");

  // Leave preview
  const leaveEl = document.getElementById("leavePreview");
  const pending = leaveRequests
    .filter((r) => r.status === "pending")
    .slice(0, 4);
  if (!pending.length) {
    leaveEl.innerHTML =
      '<p style="color:var(--text-2);font-size:.875rem">No hay solicitudes pendientes.</p>';
    return;
  }
  leaveEl.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Empleado</th><th>Período</th><th>Estado</th></tr></thead>
    <tbody>${pending
      .map(
        (r) => `
      <tr>
        <td>${escapeHtml(r.employee_name || user.name)}</td>
        <td style="font-size:.82rem">${escapeHtml(r.start_date)} → ${escapeHtml(r.end_date)}</td>
        <td><span class="badge badge-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
      </tr>`,
      )
      .join("")}
    </tbody></table></div>`;
}

/* ── Employee search ────────────────────────────────────────────────────── */
document.getElementById("empSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runEmpSearch();
});

document.getElementById("globalSearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    navigateTo("employees");
    document.getElementById("empSearch").value = e.target.value;
    runEmpSearch();
  }
});

async function runEmpSearch() {
  const q = document.getElementById("empSearch").value.trim();
  const resultsEl = document.getElementById("empSearchResults");
  const tableEl = document.getElementById("empTable");

  resultsEl.style.display = "";
  tableEl.style.display = "none";

  const results = await api(`/api/employees/search?q=${encodeURIComponent(q)}`);
  const rows = results
    .map(
      (e) => `
      <div class="result-row" data-id="${escapeHtml(e.id)}">
        <div class="result-avatar">${escapeHtml(e.name.charAt(0))}</div>
        <div class="result-info">
          <strong>${escapeHtml(e.name)}</strong>
          <span>${escapeHtml(e.email)}</span>
        </div>
        <span class="badge badge-${escapeHtml(e.role)}">${escapeHtml(e.role)}</span>
        <span class="dept-tag">${escapeHtml(e.department)}</span>
      </div>`,
    )
    .join("");

  resultsEl.innerHTML = `<div class="card-body">
      <div class="search-results-container">
        <p class="results-meta">${results.length} resultado(s) para: <em>${escapeHtml(q)}</em></p>
        <div class="results-list">${rows || '<p class="no-results">Sin resultados</p>'}</div>
      </div>
    </div>`;
}

/* ── Announcements full ─────────────────────────────────────────────────── */
async function loadAnnouncementsFull() {
  const data = await api("/api/announcements");
  document.getElementById("announcementsFull").innerHTML = data
    .map(
      (a) => `
    <div class="announcement-item">
      <div class="announcement-meta">
        ${a.pinned ? '<span class="pinned-dot"></span><span style="color:var(--primary);font-weight:600">Fijado</span><span>·</span>' : ""}
        <span>${escapeHtml(a.author_name)}</span>
        <span>·</span>
        <span>${new Date(a.created_at).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" })}</span>
      </div>
      <div class="announcement-title">${escapeHtml(a.title)}</div>
      <div class="announcement-body">${escapeHtml(a.body)}</div>
    </div>`,
    )
    .join("");
}

/* ── Leave ──────────────────────────────────────────────────────────────── */
async function loadLeave() {
  const data = await api("/api/leave-requests");
  document.getElementById("leaveTableBody").innerHTML = data
    .map(
      (r) => `
    <tr>
      <td>${escapeHtml(r.employee_name || user.name)}</td>
      <td style="font-size:.82rem">${escapeHtml(r.start_date)} → ${escapeHtml(r.end_date)}</td>
      <td><span class="badge badge-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
    </tr>`,
    )
    .join("");
}

document.getElementById("leaveForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msgEl = document.getElementById("leaveMsg");
  const data = await api("/api/leave-requests", {
    method: "POST",
    body: JSON.stringify({
      start_date: document.getElementById("leaveStart").value,
      end_date: document.getElementById("leaveEnd").value,
      reason: document.getElementById("leaveReason").value,
    }),
  });
  if (data.id) {
    msgEl.innerHTML =
      '<div class="alert alert-success">Solicitud enviada correctamente.</div>';
    e.target.reset();
    loadLeave();
  } else {
    msgEl.innerHTML = `<div class="alert alert-error">${escapeHtml(data.error)}</div>`;
  }
});

/* ── Payroll ────────────────────────────────────────────────────────────── */
async function loadPayroll() {
  const data = await api("/api/payroll/summary");
  document.getElementById("payrollTableBody").innerHTML = data
    .map(
      (e) => `
    <tr>
      <td>${escapeHtml(e.name)}</td>
      <td>${escapeHtml(e.department)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.875rem">€${Number(e.salary).toLocaleString("es-ES")}</td>
    </tr>`,
    )
    .join("");
}

async function runCalc() {
  const formula = document.getElementById("calcFormula").value.trim();
  if (!formula) return;

  document.getElementById("calcExpr").textContent = formula;
  document.getElementById("calcResult").textContent = "";
  document.getElementById("calcError").textContent = "";
  document.getElementById("calcError").classList.add("hidden");

  const data = await api("/api/payroll/calculate", {
    method: "POST",
    body: JSON.stringify({ formula }),
  });

  if (data.result !== undefined) {
    document.getElementById("calcResult").textContent =
      typeof data.result === "number"
        ? "€ " +
          data.result.toLocaleString("es-ES", { minimumFractionDigits: 2 })
        : String(data.result);
  } else {
    document.getElementById("calcError").textContent = data.error;
    document.getElementById("calcError").classList.remove("hidden");
  }
}

function setPreset(formula) {
  document.getElementById("calcFormula").value = formula;
}

document.getElementById("calcFormula").addEventListener("keydown", (e) => {
  if (e.key === "Enter") runCalc();
});

/* ── Admin ──────────────────────────────────────────────────────────────── */
async function loadAdmin() {
  if (user.role !== "admin") return;

  const users = await api("/api/admin/users");
  document.getElementById("adminUsersBody").innerHTML = users
    .map(
      (u) => `
    <tr>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.8rem">${escapeHtml(u.id)}</td>
      <td>${escapeHtml(u.name)}</td>
      <td>${escapeHtml(u.email)}</td>
      <td><span class="badge badge-${escapeHtml(u.role)}">${escapeHtml(u.role)}</span></td>
      <td>${escapeHtml(u.department)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.85rem">€${Number(u.salary).toLocaleString("es-ES")}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.78rem">${escapeHtml(u.ssn)}</td>
      <td style="font-family:'JetBrains Mono',monospace;font-size:.75rem">${escapeHtml(u.bank_account)}</td>
    </tr>`,
    )
    .join("");

  const config = await api("/api/config");
  document.getElementById("configDisplay").textContent = JSON.stringify(
    config,
    null,
    2,
  );

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".tab-btn")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("tab-users").style.display =
        btn.dataset.tab === "users" ? "" : "none";
      document.getElementById("tab-config").style.display =
        btn.dataset.tab === "config" ? "" : "none";
    });
  });
}

/* ── Logout ─────────────────────────────────────────────────────────────── */
document.getElementById("logoutBtn").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  localStorage.clear();
  window.location.href = "/index.html";
});

/* ── Boot ───────────────────────────────────────────────────────────────── */
loadOverview();
