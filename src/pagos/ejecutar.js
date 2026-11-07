// Ejecutor de pagos del cuadro, 100% por API (sin manejar la UI). Replica el
// flujo real del banco INCLUYENDO el cierre "Enviar a pendiente de firma"
// (POST user-consents), que es lo que faltaba. Deja cada transferencia EN
// PENDIENTE DE FIRMA: reversible, la plata NO se mueve hasta que se firma el
// lote a mano. Pensado para una operación por agricultor (una op = una
// constancia; la carga masiva da una sola constancia y por eso no sirve).
//
// Flujo por fila: POST account-transfer-orders (con selectedCompany) -> GET
// company-accounts -> GET third-party -> POST verify -> PUT (arma) -> POST
// user-consents (encola a pendiente de firma).
//
// Los 3 valores de device-binding del user-consents (devicetokencookie,
// orig-device-id, devicePrint) se leen de un curl del navegador
// (curl-transferencia.txt por defecto). Si caducan, el banco devuelve 4xx y se
// avisa para re-capturar un curl nuevo.

const fs = require("fs");
const path = require("path");
const { crearSesion } = require("../apiclient");
const { parsearCuadro } = require("./parse");
const { rutaBaseDatos } = require("../db");
const { DatabaseSync } = require("node:sqlite");

const AT = "https://apisux.ntlc.tlcbcp.com/ux-ntlc-account-transfer-v2/channel/ntlc/v2";
const EMPRESA_DEF = { documentNumber: "20610822356", documentType: "RUC", organizationName: "FRUTICOLA SELVA SAC" };
// Correos de aviso que se adjuntan a cada transferencia.
const EMAILS = ["notificaciones@nativaorganics.pe", "contabilidad2@nativaperu.com.pe", "mlavado@nativaperu.com.pe", "frutipagos2026@gmail.com"];
const CURL_DEF = path.join(__dirname, "..", "..", "curl-transferencia.txt");

const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
const find = (o, re, p = 0) => {
    if (!o || typeof o !== "object" || p > 6) return null;
    for (const [k, v] of Object.entries(o)) if (typeof v === "string" && v.trim() && re.test(k)) return v.trim();
    for (const v of Object.values(o)) if (v && typeof v === "object") { const r = find(v, re, p + 1); if (r) return r; } return null;
};

class CancelacionError extends Error { constructor() { super("Cancelado por el usuario."); this.name = "CancelacionError"; } }

async function checkpoint(control, log) {
    if (!control) return;
    if (control.cancelado) throw new CancelacionError();
    if (!control.pausado) return;
    log("⏸ Pausado. Reanudá para continuar.");
    while (control.pausado && !control.cancelado) await dormir(300);
    if (control.cancelado) throw new CancelacionError();
    log("▶ Reanudado.");
}

// Lee los 3 valores de device-binding de un curl del navegador. No los expone.
function leerDevice(curlPath) {
    if (!fs.existsSync(curlPath)) throw new Error(`No se encontró el curl de referencia (${path.basename(curlPath)}). Hace falta para firmar; capturá uno nuevo del navegador.`);
    const t = fs.readFileSync(curlPath, "utf8");
    const dtc = (t.match(/devicetokencookie:\s*([^'\n]+)/) || [])[1];
    const odi = (t.match(/orig-device-id:\s*([^'\n]+)/) || [])[1];
    const dp = (t.match(/"devicePrint":"([^"]+)"/) || [])[1];
    if (!dtc || !odi || !dp) throw new Error("El curl no tiene devicetokencookie/orig-device-id/devicePrint. Usá un curl de una transferencia real completa.");
    return { dtc: dtc.trim(), odi: odi.trim(), dp };
}

function abrirDb() {
    const db = new DatabaseSync(rutaBaseDatos());
    db.exec(`CREATE TABLE IF NOT EXISTS pagos (
        guia TEXT PRIMARY KEY, nombre TEXT, cuenta TEXT, pago REAL, referencia TEXT,
        estado TEXT, operacion TEXT, respuesta TEXT, fecha TEXT, error TEXT)`);
    return db;
}

// Envía una fila hasta "pendiente de firma" (o se queda en el preview si dryRun).
async function enviarUna(sesion, dev, fila, empresa, dryRun) {
    const orden = await sesion.fetchJson(`${AT}/account-transfer-orders`, { method: "POST", body: { type: "TXTHIRDPARTIES", selectedCompany: empresa } });
    if (orden.status !== 200) throw new Error(`POST order ${orden.status}`);
    const pen = ((orden.json && orden.json.sourceCompanyAccounts) || []).filter(c => c.currency === "PEN");
    const origen = pen.find(c => (c.company && c.company.documentNumber) === empresa.documentNumber) || null;
    if (!origen) throw new Error(`sin cuenta origen PEN de ${empresa.organizationName}`);
    const id = origen.id;

    await sesion.fetchJson(`${AT}/company-accounts/${id}?flag=SOURCE`);

    const dest = await sesion.fetchJson(`${AT}/third-party-accounts/${fila.cuenta}`);
    if (dest.status !== 200) throw new Error(`GET destino ${dest.status}`);
    const titular = find(dest.json, /(organizationName|holder|titular|beneficiar|name$)/i);
    if (!titular) throw new Error("el banco no devolvió titular del destino");
    if (norm(titular) !== norm(fila.nombre)) throw new Error(`titular banco "${titular}" ≠ cuadro "${fila.nombre}" — NO se envía`);

    const ver = await sesion.fetchJson(`${AT}/daily-transfer-amounts/verify`, { method: "POST", body: { amount: fila.pago.toFixed(2), currency: "PEN" } });
    if (ver.status !== 200) throw new Error(`verify ${ver.status}`);

    const put = await sesion.fetchJson(`${AT}/account-transfer-orders/${id}`, { method: "PUT", body: { amount: fila.pago.toFixed(2), currency: "PEN", reference: fila.referencia, emails: EMAILS, message: "" } });
    if (put.status !== 200 && put.status !== 201) throw new Error(`PUT ${put.status}`);
    const pj = put.json || {};
    const srcComp = pj.sourceAccount && pj.sourceAccount.company && pj.sourceAccount.company.organizationName;
    if (srcComp && !new RegExp(empresa.organizationName.split(" ")[0], "i").test(srcComp))
        throw new Error(`¡ALERTA! preview con empresa "${srcComp}", no ${empresa.organizationName} — NO se envía`);
    const tgt = pj.targetAccount && pj.targetAccount.number;
    if (tgt && String(tgt).replace(/\D/g, "") !== fila.cuenta)
        throw new Error(`¡ALERTA! preview con destino ${tgt} ≠ ${fila.cuenta} — NO se envía`);

    if (dryRun) return { dryRun: true, titular };

    // Cierre: user-consents con los 3 headers de device (desde el contexto de la página).
    const cons = await sesion.page.evaluate(async ({ url, base, dev }) => {
        const h = { ...base };
        delete h["content-length"]; delete h["host"];
        h["content-type"] = "application/json";
        h["devicetokencookie"] = dev.dtc;
        h["orig-device-id"] = dev.odi;
        const r = await fetch(url, { method: "POST", headers: h, credentials: "include", body: JSON.stringify({ devicePrint: dev.dp }) });
        const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
        return { status: r.status, json, raw: json ? null : text.slice(0, 300) };
    }, { url: `${AT}/user-consents`, base: sesion.headers(), dev });

    if (cons.status !== 200 && cons.status !== 201)
        throw new Error(`user-consents ${cons.status} (device-binding caducado? re-capturá un curl nuevo). ${JSON.stringify(cons.json || cons.raw).slice(0, 160)}`);
    const ok = cons.json && (cons.json.sucess === true || cons.json.success === true);
    if (cons.json && cons.json.sucess === false) throw new Error(`user-consents sucess:false ${JSON.stringify(cons.json).slice(0, 160)}`);

    const operacion = find(cons.json, /(operationNumber|orderNumber|transactionNumber|number)/i) || null;
    return { dryRun: false, titular, operacion, ok, respuesta: cons.json };
}

// opciones: { pdfPath, dryRun, soloGuias:[...], empresa, curlPath, control }
async function correrPagos(opciones, log = console.log) {
    const { pdfPath, dryRun = false, soloGuias = null, empresa = EMPRESA_DEF, curlPath = CURL_DEF, control = null } = opciones;
    const { filas, saltadas } = parsearCuadro(pdfPath);
    let pend = soloGuias && soloGuias.length ? filas.filter(f => soloGuias.includes(f.guia) || soloGuias.some(s => f.guia.endsWith(s))) : filas;

    const dev = dryRun ? null : leerDevice(curlPath);
    const db = abrirDb();
    const hechas = new Set(db.prepare("SELECT guia FROM pagos WHERE estado IN ('enviada','pagada')").all().map(r => r.guia));
    const cola = pend.filter(f => !hechas.has(f.guia));
    const total = cola.reduce((s, f) => s + f.pago, 0);

    log(`${dryRun ? "SIMULACRO (no crea nada)" : "Crear órdenes EN PENDIENTE DE FIRMA (reversible; la plata no se mueve hasta firmar)"}.`);
    log(`Cuadro: ${filas.length} transferibles, ${saltadas.length} saltadas, ${hechas.size} ya enviadas. A procesar: ${cola.length} (S/ ${total.toFixed(2)}).`);
    for (const s of saltadas) log(`  ↷ saltada ${s.guia} ${s.nombre} — ${s.motivo}`);
    if (!cola.length) { db.close(); log("Nada que hacer."); return { enviadas: 0, errores: 0, simuladas: 0, total: 0, cancelado: false }; }

    let sesion = null, enviadas = 0, errores = 0, simuladas = 0, cancelado = false;
    try {
        log("Conectando al navegador y capturando token...");
        sesion = await crearSesion(log);
        log(`Token OK (expira en ${sesion.expSegundos()}s). Empresa pagadora: ${empresa.organizationName}.`);

        for (let i = 0; i < cola.length; i++) {
            await checkpoint(control, log);
            const f = cola[i], pos = `[${i + 1}/${cola.length}]`;
            try {
                const res = await enviarUna(sesion, dev, f, empresa, dryRun);
                if (res.dryRun) {
                    simuladas++;
                    db.prepare("INSERT OR REPLACE INTO pagos (guia,nombre,cuenta,pago,referencia,estado,fecha) VALUES (?,?,?,?,?,?,?)")
                        .run(f.guia, f.nombre, f.cuenta, f.pago, f.referencia, "simulada", new Date().toISOString());
                    log(`○ ${pos} SIMULADA ${f.nombre} S/ ${f.pago.toFixed(2)} (titular ok: ${res.titular})`);
                } else {
                    enviadas++;
                    db.prepare("INSERT OR REPLACE INTO pagos (guia,nombre,cuenta,pago,referencia,estado,operacion,respuesta,fecha,error) VALUES (?,?,?,?,?,?,?,?,?,NULL)")
                        .run(f.guia, f.nombre, f.cuenta, f.pago, f.referencia, "enviada", res.operacion ? String(res.operacion) : null, JSON.stringify(res.respuesta), new Date().toISOString());
                    log(`✓ ${pos} EN PENDIENTE DE FIRMA ${f.nombre} S/ ${f.pago.toFixed(2)}${res.operacion ? " — op " + res.operacion : ""}`);
                }
            } catch (e) {
                errores++;
                db.prepare("INSERT OR REPLACE INTO pagos (guia,nombre,cuenta,pago,referencia,estado,fecha,error) VALUES (?,?,?,?,?,?,?,?)")
                    .run(f.guia, f.nombre, f.cuenta, f.pago, f.referencia, "error", new Date().toISOString(), e.message);
                log(`✗ ${pos} ERROR ${f.nombre}: ${e.message}`);
                if (/ALERTA|device-binding caducado/.test(e.message)) { log("🛑 Abortando por seguridad."); break; }
            }
            await dormir(500);
        }
    } catch (err) {
        if (err instanceof CancelacionError) { cancelado = true; log("■ Cancelado."); }
        else throw err;
    } finally {
        db.close();
        if (sesion) await sesion.cerrar();
    }

    log(`\n${cancelado ? "Cancelado. " : "Listo. "}En pendiente de firma: ${enviadas}, simuladas: ${simuladas}, errores: ${errores}.`);
    if (enviadas > 0) log("Ahora revisá y FIRMÁ el lote en TeleCrédito para concretar los pagos.");
    return { enviadas, errores, simuladas, total, cancelado };
}

module.exports = { correrPagos };
