// FASE 2 — Ejecutar transferencias (MUEVE DINERO REAL E IRREVERSIBLE).
//
// Por cada fila transferible del cuadro, replica el flujo real del banco:
//   1) POST account-transfer-orders {type:"TXTHIRDPARTIES"}  -> abre orden y
//      devuelve las cuentas origen (su id cambia en cada orden).
//   2) GET  company-accounts/{sourceId}?flag=SOURCE          -> selecciona origen
//   3) GET  third-party-accounts/{cuentaDestino}             -> liga el destino
//      (el destino NO va en el body del PUT; queda ligado por esta llamada)
//   4) POST daily-transfer-amounts/verify {amount,currency}  -> límite diario
//   5) PUT  account-transfer-orders/{sourceId}               -> EJECUTA
//
// Seguridad:
//   - Confirmación por fila (salvo --si). En --dry-run NO se hace el paso 5.
//   - Idempotencia por GUÍA en SQLite: una guía ya 'pagada' nunca se repite.
//   - Antes del PUT se exige que el titular que devuelve el banco (paso 3)
//     coincida con el del cuadro; si no, la fila se marca error y se salta.
//   - Tras el PUT se revisa que la respuesta no eche atrás un destino distinto.
//
// Uso:
//   node src/abrir.js                 # abrir y loguear el banco (otra terminal)
//   node src/pagos/transferir.js <cuadro.pdf> [opciones]
// Opciones:
//   --empresa 20610822356     RUC o nombre de la empresa pagadora
//                             (default: FRUTICOLA SELVA SAC). Se fija en cada orden.
//   --source "FRUTICOLA"      alias/numero de la cuenta origen (default: única PEN)
//   --solo 4517               procesar solo esa guía (full o últimos 4) — para prueba
//   --emails a@x,b@y          correos de aviso del banco (default: ninguno)
//   --dry-run                 hace todo MENOS el PUT (no mueve plata, no pregunta)
//   --si                      no preguntar por fila (ejecuta todo; úsalo con cuidado)

const fs = require("fs");
const path = require("path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { DatabaseSync } = require("node:sqlite");
const { crearSesion } = require("../apiclient");
const { parsearCuadro } = require("./parse");
const { rutaBaseDatos } = require("../db");

const AT = "https://apisux.ntlc.tlcbcp.com/ux-ntlc-account-transfer-v2/channel/ntlc/v2";
const URL_ORDERS = `${AT}/account-transfer-orders`;
const URL_SOURCE = (id) => `${AT}/company-accounts/${id}?flag=SOURCE`;
const URL_THIRD = (cuenta) => `${AT}/third-party-accounts/${cuenta}`;
const URL_VERIFY = `${AT}/daily-transfer-amounts/verify`;
const URL_PUT = (id) => `${AT}/account-transfer-orders/${id}`;

const dormir = (ms) => new Promise(r => setTimeout(r, ms));

function normNombre(s) {
    return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
}

// Busca recursivamente un string bajo una clave "de nombre" (organizationName…).
function buscarValor(obj, re, prof = 0) {
    if (!obj || typeof obj !== "object" || prof > 6) return null;
    for (const [k, v] of Object.entries(obj))
        if (typeof v === "string" && v.trim() && re.test(k)) return v.trim();
    for (const v of Object.values(obj))
        if (v && typeof v === "object") { const r = buscarValor(v, re, prof + 1); if (r) return r; }
    return null;
}

function parseArgs(argv) {
    const o = { pdf: null, empresa: "20610822356", source: null, solo: null, emails: [], dryRun: false, si: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--dry-run") o.dryRun = true;
        else if (a === "--si") o.si = true;
        else if (a === "--empresa") o.empresa = argv[++i];
        else if (a === "--source") o.source = argv[++i];
        else if (a === "--solo") o.solo = argv[++i];
        else if (a === "--emails") o.emails = (argv[++i] || "").split(",").map(s => s.trim()).filter(Boolean);
        else if (!o.pdf) o.pdf = a;
    }
    return o;
}

function abrirDb() {
    const db = new DatabaseSync(rutaBaseDatos());
    db.exec(`
        CREATE TABLE IF NOT EXISTS pagos (
            guia        TEXT PRIMARY KEY,
            nombre      TEXT,
            cuenta      TEXT,
            pago        REAL,
            referencia  TEXT,
            estado      TEXT,           -- pagada | error | simulada
            operacion   TEXT,           -- nro de operación que devuelve el banco
            respuesta   TEXT,           -- JSON crudo del PUT
            fecha       TEXT,
            error       TEXT
        )`);
    return db;
}

// Resuelve la empresa pagadora (objeto {documentNumber,documentType,organizationName})
// desde sourceCompanies de una orden, filtrando por RUC o nombre.
function elegirEmpresa(orden, filtro) {
    const empresas = (orden.json && orden.json.sourceCompanies) || [];
    const f = (filtro || "").toUpperCase();
    return empresas.find(e => e.documentNumber === filtro || (e.organizationName || "").toUpperCase().includes(f)) || null;
}

// Recibo final: vuelca toda la tabla pagos a un CSV junto al PDF. Incluye lo
// pagado en corridas anteriores (idempotencia), con nro de operación por fila.
function escribirRecibo(db, pdfPath, log) {
    const filas = db.prepare("SELECT guia,nombre,cuenta,pago,referencia,estado,operacion,fecha,error FROM pagos ORDER BY guia").all();
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const pagadas = filas.filter(r => r.estado === "pagada");
    const totalPagado = pagadas.reduce((s, r) => s + (r.pago || 0), 0);
    const cab = "estado,guia,nombre,cuenta,pago,referencia,operacion,fecha,error";
    const cuerpo = filas.map(r => [
        r.estado, r.guia, r.nombre, r.cuenta, (r.pago ?? 0).toFixed(2),
        r.referencia, r.operacion || "", r.fecha || "", r.error || "",
    ].map(esc).join(","));
    const total = ["", "", "TOTAL PAGADAS", "", totalPagado.toFixed(2), `${pagadas.length} transferencias`, "", "", ""].map(esc).join(",");
    const out = path.join(path.dirname(pdfPath), "recibo-pagos.csv");
    fs.writeFileSync(out, [cab, ...cuerpo, total].join("\n"));
    log(`Recibo: ${out}  (${pagadas.length} pagadas, S/ ${totalPagado.toFixed(2)})`);
    return out;
}

// Elige la cuenta origen PEN de la respuesta del POST order. Si el usuario pasó
// --source, filtra por alias/numero. El id se re-lee en cada orden (cambia).
function elegirOrigen(orden, filtro) {
    const cuentas = (orden.json && orden.json.sourceCompanyAccounts) || [];
    let pen = cuentas.filter(c => c.currency === "PEN");
    if (filtro) {
        const f = filtro.toUpperCase();
        pen = pen.filter(c => (c.alias || "").toUpperCase().includes(f) || (c.number || "").includes(filtro));
    }
    return pen[0] || null;
}

async function ejecutarUna(sesion, fila, empresa, origenFiltro, emails, dryRun, log) {
    // Orden nueva por transferencia: estado limpio en el servidor. Fijamos la
    // empresa pagadora (selectedCompany) para que las cuentas origen sean suyas.
    const orden = await sesion.fetchJson(URL_ORDERS, { method: "POST", body: { type: "TXTHIRDPARTIES", selectedCompany: empresa } });
    if (orden.status !== 200) throw new Error(`POST order status ${orden.status}: ${JSON.stringify(orden.json || orden.raw).slice(0, 200)}`);
    // GUARDA DE EMPRESA: la selección de empresa es pegajosa a la sesión y no
    // siempre aplica. Verificamos que la orden quedó en la empresa pedida y que
    // la cuenta origen elegida pertenece a esa empresa (su RUC). Si no, abortamos
    // ANTES de tocar nada: jamás pagar desde la empresa equivocada.
    const selDoc = orden.json && orden.json.selectedCompany && orden.json.selectedCompany.documentNumber;
    if (selDoc && empresa.documentNumber && selDoc !== empresa.documentNumber)
        throw new Error(`la orden quedó en empresa ${orden.json.selectedCompany.organizationName} (${selDoc}), no ${empresa.organizationName} (${empresa.documentNumber}). La selección de empresa no aplicó — abortado.`);

    const origen = elegirOrigen(orden, origenFiltro);
    if (!origen) throw new Error("no se encontró cuenta origen PEN que coincida con --source");
    const origenDoc = origen.company && origen.company.documentNumber;
    if (origenDoc && empresa.documentNumber && origenDoc !== empresa.documentNumber)
        throw new Error(`la cuenta origen ${origen.alias} (${origen.number}) es de la empresa ${origenDoc}, no ${empresa.documentNumber} — abortado.`);
    const sourceId = origen.id;

    const src = await sesion.fetchJson(URL_SOURCE(sourceId));
    if (src.status !== 200) throw new Error(`GET source status ${src.status}`);

    const dest = await sesion.fetchJson(URL_THIRD(fila.cuenta));
    if (dest.status !== 200) throw new Error(`GET third-party status ${dest.status}: ${JSON.stringify(dest.json || dest.raw).slice(0, 200)}`);
    const titular = buscarValor(dest.json, /(organizationName|holder|titular|beneficiar|name$)/i);
    if (!titular) throw new Error("el banco no devolvió titular del destino");
    if (normNombre(titular) !== normNombre(fila.nombre))
        throw new Error(`titular banco "${titular}" ≠ cuadro "${fila.nombre}" — NO se transfiere`);

    const ver = await sesion.fetchJson(URL_VERIFY, { method: "POST", body: { amount: fila.pago.toFixed(2), currency: "PEN" } });
    if (ver.status !== 200) throw new Error(`verify status ${ver.status}: ${JSON.stringify(ver.json || ver.raw).slice(0, 200)}`);

    if (dryRun) return { dryRun: true, titular, origen };

    const put = await sesion.fetchJson(URL_PUT(sourceId), {
        method: "PUT",
        body: { amount: fila.pago.toFixed(2), currency: "PEN", reference: fila.referencia, emails, message: "" },
    });
    if (put.status !== 200 && put.status !== 201)
        throw new Error(`PUT status ${put.status}: ${JSON.stringify(put.json || put.raw).slice(0, 300)}`);

    // El PUT solo ARMA la orden (devuelve un preview con sourceAccount/targetAccount
    // y canSign). Verificamos que el preview sea correcto antes de nada:
    const j = put.json || {};
    const srcNum = j.sourceAccount && j.sourceAccount.number;
    const srcComp = j.sourceAccount && j.sourceAccount.company && j.sourceAccount.company.organizationName;
    const tgtNum = j.targetAccount && j.targetAccount.number;
    if (srcNum && origen.number && srcNum !== origen.number)
        throw new Error(`¡ALERTA! preview con cuenta origen ${srcNum} (${srcComp}) ≠ elegida ${origen.number}. Abortado.`);
    if (tgtNum && String(tgtNum).replace(/\D/g, "") !== fila.cuenta)
        throw new Error(`¡ALERTA! preview con destino ${tgtNum} ≠ ${fila.cuenta}. Abortado.`);

    // FALTA el paso de firma real (POST user-consents + devicePrint). Mientras no
    // esté implementado y probado, NO declaramos la transferencia como ejecutada:
    // devolver aquí un "pagada" sería mentir. El preview quedó armado pero sin firmar.
    throw new Error(`orden armada pero NO ejecutada: falta el paso de firma (POST user-consents). Preview: ${srcComp}/${srcNum} → ${tgtNum} S/ ${j.amount}, canSign=${j.canSign}.`);
}

async function correr(opts, log = console.log) {
    const { filas, saltadas } = parsearCuadro(opts.pdf);
    let pend = filas;
    if (opts.solo) {
        const s = opts.solo;
        pend = filas.filter(f => f.guia === s || f.guia.endsWith(s));
        if (!pend.length) throw new Error(`--solo ${s} no coincide con ninguna fila`);
    }

    const db = abrirDb();
    const yaPagadas = new Set(db.prepare("SELECT guia FROM pagos WHERE estado='pagada'").all().map(r => r.guia));
    const cola = pend.filter(f => !yaPagadas.has(f.guia));
    const totalMonto = cola.reduce((s, f) => s + f.pago, 0);

    log(`\n${opts.dryRun ? "SIMULACRO (no mueve dinero)" : "⚠ TRANSFERENCIAS REALES"}`);
    log(`Cuadro: ${filas.length} transferibles, ${saltadas.length} saltadas, ${yaPagadas.size} ya pagadas.`);
    log(`A procesar ahora: ${cola.length} transferencias, total S/ ${totalMonto.toFixed(2)}.`);
    if (!cola.length) { db.close(); log("Nada que hacer."); return; }

    const rl = (!opts.dryRun && !opts.si) ? readline.createInterface({ input: stdin, output: stdout }) : null;
    const preguntar = async (q) => {
        if (!rl) return "s";
        const r = (await rl.question(q)).trim().toLowerCase();
        return r;
    };

    log("Conectando al navegador y capturando token...");
    const sesion = await crearSesion(log);
    log(`Token OK (expira en ${sesion.expSegundos()}s).`);

    // Resolver la empresa pagadora (lista completa en cualquier orden) y luego
    // pedir una orden con esa empresa fijada para ver su cuenta origen.
    const ordenLista = await sesion.fetchJson(URL_ORDERS, { method: "POST", body: { type: "TXTHIRDPARTIES" } });
    const empresa = elegirEmpresa(ordenLista, opts.empresa);
    if (!empresa) {
        const disp = ((ordenLista.json && ordenLista.json.sourceCompanies) || []).map(e => `${e.organizationName} (${e.documentNumber})`).join("; ");
        await sesion.cerrar(); db.close();
        throw new Error(`empresa "${opts.empresa}" no encontrada. Disponibles: ${disp}`);
    }
    const orden0 = await sesion.fetchJson(URL_ORDERS, { method: "POST", body: { type: "TXTHIRDPARTIES", selectedCompany: empresa } });
    const origen0 = elegirOrigen(orden0, opts.source);
    if (!origen0) { await sesion.cerrar(); db.close(); throw new Error("no hay cuenta origen PEN (usa --source)"); }
    log(`Empresa pagadora: ${empresa.organizationName} (RUC ${empresa.documentNumber})`);
    log(`Cuenta origen: ${origen0.alias} (${origen0.number}) ${origen0.currency}`);
    if (rl) {
        const ok = await preguntar(`¿Confirmas ejecutar ${cola.length} transferencias por S/ ${totalMonto.toFixed(2)} desde ${empresa.organizationName} / ${origen0.alias}? (escribe SI): `);
        if (ok !== "si") { log("Cancelado."); if (rl) rl.close(); await sesion.cerrar(); db.close(); return; }
    }

    let ok = 0, err = 0, sim = 0, abortado = false;
    for (let i = 0; i < cola.length; i++) {
        const f = cola[i];
        const pos = `[${i + 1}/${cola.length}]`;

        if (rl) {
            log(`\n${pos} ${f.guia}  ${f.nombre}`);
            log(`     cuenta ${f.cuentaCuadro}  →  S/ ${f.pago.toFixed(2)}   ref "${f.referencia}"`);
            const r = await preguntar("     transferir? (s = sí / n = saltar / a = abortar): ");
            if (r === "a") { abortado = true; break; }
            if (r !== "s" && r !== "si") { log("     saltada."); continue; }
        }

        try {
            const res = await ejecutarUna(sesion, f, empresa, opts.source, opts.emails, opts.dryRun, log);
            if (res.dryRun) {
                sim++;
                db.prepare("INSERT OR REPLACE INTO pagos (guia,nombre,cuenta,pago,referencia,estado,fecha) VALUES (?,?,?,?,?,?,?)")
                    .run(f.guia, f.nombre, f.cuenta, f.pago, f.referencia, "simulada", new Date().toISOString());
                log(`  ○ ${pos} SIMULADA (titular ok: ${res.titular}) — sin PUT`);
            } else {
                ok++;
                db.prepare("INSERT OR REPLACE INTO pagos (guia,nombre,cuenta,pago,referencia,estado,operacion,respuesta,fecha,error) VALUES (?,?,?,?,?,?,?,?,?,NULL)")
                    .run(f.guia, f.nombre, f.cuenta, f.pago, f.referencia, "pagada", res.operacion ? String(res.operacion) : null, JSON.stringify(res.respuesta), new Date().toISOString());
                log(`  ✓ ${pos} PAGADA ${f.nombre} S/ ${f.pago.toFixed(2)} — op ${res.operacion || "?"}`);
            }
        } catch (e) {
            err++;
            db.prepare("INSERT OR REPLACE INTO pagos (guia,nombre,cuenta,pago,referencia,estado,fecha,error) VALUES (?,?,?,?,?,?,?,?)")
                .run(f.guia, f.nombre, f.cuenta, f.pago, f.referencia, "error", new Date().toISOString(), e.message);
            log(`  ✗ ${pos} ERROR ${f.nombre}: ${e.message}`);
            if (/ALERTA/.test(e.message)) { abortado = true; log("  🛑 Abortando el lote por seguridad."); break; }
            if (rl) {
                const r = await preguntar("     ¿continuar con las siguientes? (s/N): ");
                if (r !== "s" && r !== "si") { abortado = true; break; }
            }
        }
        await dormir(400);
    }

    if (rl) rl.close();
    await sesion.cerrar();
    log(`\n${abortado ? "ABORTADO. " : ""}Hecho. Pagadas: ${ok}, simuladas: ${sim}, con error: ${err}.`);
    log(`Registro en SQLite: ${rutaBaseDatos()} (tabla pagos).`);
    if (!opts.dryRun) escribirRecibo(db, opts.pdf, log);
    db.close();
}

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.pdf) { console.error("uso: node src/pagos/transferir.js <cuadro.pdf> [--source ALIAS] [--solo GUIA] [--dry-run] [--si]"); process.exit(1); }
    correr(opts).catch(err => { console.error("ERROR FATAL:", err.message); process.exit(1); });
}

module.exports = { correr };
