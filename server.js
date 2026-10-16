const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Integrations ────────────────────────────────────────────────────────────
// Secrets come from the environment (see .env, ignored by git). Never hardcode them.
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const INTERNAL_WEBHOOK = process.env.INTERNAL_WEBHOOK;

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || `http://localhost:${PORT}`,
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── Database setup ───────────────────────────────────────────────────────────
const db = new Database(":memory:");

db.exec(`
  CREATE TABLE users (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    email        TEXT UNIQUE NOT NULL,
    password     TEXT NOT NULL,
    role         TEXT NOT NULL DEFAULT 'employee',
    department   TEXT,
    salary       REAL,
    ssn          TEXT,
    bank_account TEXT,
    hire_date    TEXT,
    active       INTEGER DEFAULT 1
  );

  CREATE TABLE announcements (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    author_id  INTEGER,
    pinned     INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE leave_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    start_date  TEXT,
    end_date    TEXT,
    reason      TEXT,
    status      TEXT DEFAULT 'pending',
    created_at  TEXT DEFAULT CURRENT_TIMESTAMP
  );

  INSERT INTO users (name, email, password, role, department, salary, ssn, bank_account, hire_date) VALUES
    ('Ana García',      'ana@nexushr.com',    'admin123',   'admin',    'Engineering', 95000, '123-45-6789', 'ES91 2100 0418 4502 0005 1332', '2021-03-15'),
    ('Carlos López',    'carlos@nexushr.com', 'password',   'manager',  'Sales',       72000, '234-56-7890', 'ES80 2310 0001 1800 0001 2345', '2020-06-01'),
    ('María Martín',    'maria@nexushr.com',  'maria2024',  'employee', 'Marketing',   48000, '345-67-8901', 'ES12 0049 1500 0523 1000 3456', '2022-09-12'),
    ('Jorge Ruiz',      'jorge@nexushr.com',  'jorge123',   'employee', 'Engineering', 52000, '456-78-9012', 'ES31 0075 0899 0600 6000 4567', '2023-01-08'),
    ('Laura Sánchez',   'laura@nexushr.com',  'laura!456',  'manager',  'HR',          68000, '567-89-0123', 'ES76 0049 0001 2110 3456 7890', '2019-11-20'),
    ('Tomás Ferreira',  'tomas@nexushr.com',  'tomas789',   'employee', 'Finance',     55000, '678-90-1234', 'ES24 2038 9900 9960 0012 3456', '2022-02-14');

  INSERT INTO announcements (title, body, author_id, pinned) VALUES
    ('Revisión salarial Q2 2026',        'Las revisiones salariales del segundo trimestre comenzarán el próximo lunes. Por favor preparad vuestros informes de desempeño antes del viernes.',          1, 1),
    ('Nuevo portal de vacaciones',        'A partir del 1 de mayo todas las solicitudes de vacaciones se gestionarán exclusivamente a través del nuevo módulo integrado en NexusHR.',                  5, 0),
    ('Formación obligatoria RGPD',        'Recordamos que la formación en protección de datos es obligatoria para todo el personal antes del 30 de abril. Acceso disponible en el área de formación.', 1, 0),
    ('Actualización plan de beneficios',  'El departamento de RRHH ha actualizado el catálogo de beneficios para 2026. Seguro médico ampliado y nuevas opciones de retribución flexible.',             5, 0);

  INSERT INTO leave_requests (user_id, start_date, end_date, reason, status) VALUES
    (3, '2026-04-21', '2026-04-25', 'Vacaciones personales', 'approved'),
    (4, '2026-05-02', '2026-05-06', 'Asuntos familiares',    'pending'),
    (6, '2026-04-28', '2026-04-28', 'Cita médica',           'pending');
`);

// ── Password hashing ─────────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

// Hash seeded plaintext passwords so none are stored in clear
const updatePassword = db.prepare("UPDATE users SET password = ? WHERE id = ?");
for (const { id, password } of db.prepare("SELECT id, password FROM users").all()) {
  updatePassword.run(hashPassword(password), id);
}

// ── Session store ────────────────────────────────────────────────────────────
const sessions = {};

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token || !Object.hasOwn(sessions, token)) {
    return res
      .status(401)
      .json({ error: "Sesión no válida. Por favor inicia sesión." });
  }
  req.user = sessions[token];
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin") {
      return res
        .status(403)
        .json({ error: "Acceso restringido al área de administración." });
    }
    next();
  });
}

// ════════════════════════════════════════════════════════════════════════════
//  AUTH ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== "string" || typeof password !== "string" || !email || !password) {
    return res.status(400).json({ error: "Email y contraseña requeridos." });
  }

  const user = db
    .prepare("SELECT * FROM users WHERE email = ? AND active = 1")
    .get(email);

  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: "Credenciales incorrectas." });
  }

  const token = generateToken();
  sessions[token] = {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
  };

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      role: user.role,
      department: user.department,
    },
  });
});

app.post("/api/auth/logout", (req, res) => {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (Object.hasOwn(sessions, token)) delete sessions[token];
  res.json({ message: "Sesión cerrada correctamente." });
});

// ════════════════════════════════════════════════════════════════════════════
//  EMPLOYEE ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/employees", requireAuth, (req, res) => {
  const employees = db
    .prepare(
      "SELECT id, name, email, role, department, hire_date, active FROM users ORDER BY department, name",
    )
    .all();
  res.json(employees);
});

app.get("/api/employees/search", requireAuth, (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q : "";
  const pattern = `%${q}%`;

  // Rendering is done client-side with escaped output; the API only returns JSON
  const results = db
    .prepare(
      "SELECT id, name, email, department, role FROM users WHERE name LIKE ? OR department LIKE ? OR email LIKE ?",
    )
    .all(pattern, pattern, pattern);

  res.json(results);
});

app.get("/api/employees/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const canSeeSalary = req.user.role === "admin" || req.user.id === id;

  const employee = db
    .prepare(
      canSeeSalary
        ? "SELECT id, name, email, role, department, salary, hire_date FROM users WHERE id = ?"
        : "SELECT id, name, email, role, department, hire_date FROM users WHERE id = ?",
    )
    .get(id);

  if (!employee)
    return res.status(404).json({ error: "Empleado no encontrado." });
  res.json(employee);
});

// ════════════════════════════════════════════════════════════════════════════
//  ANNOUNCEMENTS
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/announcements", requireAuth, (req, res) => {
  const announcements = db
    .prepare(
      "SELECT a.*, u.name as author_name FROM announcements a JOIN users u ON a.author_id = u.id ORDER BY a.pinned DESC, a.created_at DESC",
    )
    .all();
  res.json(announcements);
});

app.post("/api/announcements", requireAdmin, (req, res) => {
  const { title, body, pinned } = req.body;
  const result = db
    .prepare(
      "INSERT INTO announcements (title, body, author_id, pinned) VALUES (?, ?, ?, ?)",
    )
    .run(title, body, req.user.id, pinned ? 1 : 0);
  res.json({
    id: result.lastInsertRowid,
    message: "Anuncio publicado correctamente.",
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  LEAVE REQUESTS
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/leave-requests", requireAuth, (req, res) => {
  const query =
    req.user.role === "admin" || req.user.role === "manager"
      ? "SELECT l.*, u.name as employee_name, u.department FROM leave_requests l JOIN users u ON l.user_id = u.id ORDER BY l.created_at DESC"
      : "SELECT * FROM leave_requests WHERE user_id = ? ORDER BY created_at DESC";

  const requests =
    req.user.role === "admin" || req.user.role === "manager"
      ? db.prepare(query).all()
      : db.prepare(query).all(req.user.id);

  res.json(requests);
});

app.post("/api/leave-requests", requireAuth, (req, res) => {
  const { start_date, end_date, reason } = req.body;
  const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (!isDate(start_date) || !isDate(end_date) || start_date > end_date) {
    return res.status(400).json({ error: "Fechas no válidas." });
  }
  if (reason !== undefined && (typeof reason !== "string" || reason.length > 500)) {
    return res.status(400).json({ error: "Motivo no válido." });
  }
  const result = db
    .prepare(
      "INSERT INTO leave_requests (user_id, start_date, end_date, reason) VALUES (?, ?, ?, ?)",
    )
    .run(req.user.id, start_date, end_date, reason);
  res.json({
    id: result.lastInsertRowid,
    message: "Solicitud enviada correctamente.",
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  PAYROLL
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/payroll/summary", requireAuth, (req, res) => {
  const target = req.user.role === "admin" ? null : req.user.id;
  const employees = target
    ? db
        .prepare("SELECT id, name, department, salary FROM users WHERE id = ?")
        .all(target)
    : db
        .prepare(
          "SELECT id, name, department, salary FROM users ORDER BY department",
        )
        .all();
  res.json(employees);
});

// Safe arithmetic evaluator: numbers, + - * / ( ) and the `salary` variable only
function evaluateFormula(formula, vars) {
  const tokens = formula.match(/\d+(?:\.\d+)?|[a-z_]+|[-+*/()]|\S/gi) || [];
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  const parsePrimary = () => {
    const tok = next();
    if (tok === undefined) throw new Error("Unexpected end");
    if (tok === "-") return -parsePrimary();
    if (tok === "+") return parsePrimary();
    if (tok === "(") {
      const value = parseExpr();
      if (next() !== ")") throw new Error("Missing )");
      return value;
    }
    if (/^\d/.test(tok)) return Number(tok);
    if (Object.hasOwn(vars, tok)) return vars[tok];
    throw new Error(`Invalid token: ${tok}`);
  };

  const parseTerm = () => {
    let value = parsePrimary();
    while (peek() === "*" || peek() === "/") {
      value = next() === "*" ? value * parsePrimary() : value / parsePrimary();
    }
    return value;
  };

  const parseExpr = () => {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      value = next() === "+" ? value + parseTerm() : value - parseTerm();
    }
    return value;
  };

  const result = parseExpr();
  if (pos !== tokens.length || !Number.isFinite(result)) {
    throw new Error("Invalid formula");
  }
  return result;
}

app.post("/api/payroll/calculate", requireAuth, (req, res) => {
  const { formula } = req.body;
  if (typeof formula !== "string" || !formula || formula.length > 200) {
    return res.status(400).json({ error: "Fórmula requerida." });
  }

  try {
    const { salary = 0 } =
      db.prepare("SELECT salary FROM users WHERE id = ?").get(req.user.id) || {};
    const result = evaluateFormula(formula, { salary });
    res.json({ result, formula });
  } catch (err) {
    res.status(400).json({ error: "Fórmula no válida. Revisa la sintaxis." });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  ADMIN ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════

app.get("/api/admin/users", requireAdmin, (req, res) => {
  const users = db
    .prepare(
      "SELECT id, name, email, role, department, salary, ssn, bank_account, hire_date, active FROM users",
    )
    .all();
  res.json(users);
});

app.get("/api/admin/stats", requireAdmin, (req, res) => {
  const totalEmployees = db
    .prepare("SELECT COUNT(*) as count FROM users WHERE active = 1")
    .get();
  const byDepartment = db
    .prepare(
      "SELECT department, COUNT(*) as count FROM users GROUP BY department",
    )
    .all();
  const avgSalary = db
    .prepare("SELECT AVG(salary) as avg FROM users WHERE active = 1")
    .get();
  const pendingLeave = db
    .prepare(
      "SELECT COUNT(*) as count FROM leave_requests WHERE status = 'pending'",
    )
    .get();

  res.json({
    totalEmployees: totalEmployees.count,
    byDepartment,
    avgSalary: Math.round(avgSalary.avg),
    pendingLeave: pendingLeave.count,
  });
});

app.get("/api/config", requireAdmin, (req, res) => {
  // Only non-sensitive status is exposed; secrets never leave the server
  res.json({
    version: "2.4.1",
    environment: process.env.NODE_ENV || "development",
    integrations: {
      stripe: Boolean(STRIPE_SECRET_KEY),
      sendgrid: Boolean(SENDGRID_API_KEY),
      openai: Boolean(OPENAI_API_KEY),
      webhook: Boolean(INTERNAL_WEBHOOK),
    },
    features: {
      aiAssistant: true,
      advancedReports: true,
      biometricLogin: false,
    },
  });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ┌──────────────────────────────────────────┐`);
  console.log(`  │   NexusHR v2.4.1  →  http://localhost:${PORT}  │`);
  console.log(`  └──────────────────────────────────────────┘\n`);
});
