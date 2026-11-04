// FASE 2 (UI) — Crear transferencias a terceros dejándolas EN PENDIENTE DE FIRMA.
//
// Maneja la web del banco (Playwright sobre el navegador ya logueado) replicando
// EXACTAMENTE lo que hace el usuario a mano (receta grabada el 2026-11-03):
//   tab "Cuentas de terceros BCP" -> elegir cuenta origen FRUTICOLA (soles) ->
//   escribir cuenta destino -> monto -> referencia -> correos -> "Continuar" ->
//   "Enviar a pendiente de firma".
//
// El botón final es "Enviar a pendiente de firma": la orden queda en cola; LA
// PLATA NO SE MUEVE hasta que un firmante firme el lote aparte. Por eso crear
// las órdenes es reversible y de bajo riesgo. El propio SPA arma el devicePrint
// (user-consents); no reconstruimos nada.
//
// Gates de seguridad por fila (si algo no cuadra, NO se envía esa fila):
//   - el titular que valida el banco (GET third-party) debe coincidir con el cuadro
//   - el PUT debe quedar con cuenta origen de FRUTICOLA
//   - idempotencia por guía: una guía ya "enviada"/"pagada" no se repite
//
// Uso:
//   node src/abrir.js                 # navegador logueado (otra terminal)
//   node src/pagos/enviar_ui.js <cuadro.pdf> [--solo 4530] [--si] [--emails a@x,b@y]

const { chromium } = require("playwright-core");
const { DatabaseSync } = require("node:sqlite");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { parsearCuadro } = require("./parse");
const { rutaBaseDatos } = require("../db");

const CDP = "http://127.0.0.1:9222";
const AT = "ux-ntlc-account-transfer-v2/channel/ntlc/v2";
// Cuenta origen a elegir en el dropdown (FRUTICOLA SELVA SAC, soles).
const ORIGEN_MATCH = "191-9948529";
const EMAILS_DEF = ["notificaciones@nativaorganics.pe", "contabilidad2@nativaperu.com.pe", "mlavado@nativaperu.com.pe"];

const dormir = (ms) => new Promise(r => setTimeout(r, ms));
const normNombre = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
const buscarValor = (o, re, p = 0) => {
    if (!o || typeof o !== "object" || p > 6) return null;
    for (const [k, v] of Object.entries(o)) if (typeof v === "string" && v.trim() && re.test(k)) return v.trim();
    for (const v of Object.values(o)) if (v && typeof v === "object") { const r = buscarValor(v, re, p + 1); if (r) return r; }
    return null;
};

function parseArgs(argv) {
    const o = { pdf: null, solo: null, si: false, emails: EMAILS_DEF };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--si") o.si = true;
        else if (a === "--solo") o.solo = argv[++i];
        else if (a === "--emails") o.emails = (argv[++i] || "").split(",").map(s => s.trim()).filter(Boolean);
        else if (!o.pdf) o.pdf = a;
    }
    return o;
}

function abrirDb() {
    const db = new DatabaseSync(rutaBaseDatos());
    db.exec(`CREATE TABLE IF NOT EXISTS pagos (
        guia TEXT PRIMARY KEY, nombre TEXT, cuenta TEXT, pago REAL, referencia TEXT,
        estado TEXT, operacion TEXT, respuesta TEXT, fecha TEXT, error TEXT)`);
    return db;
}

async function conectar() {
    const b = await chromium.connectOverCDP(CDP);
    const ctx = b.contexts()[0];
    const page = ctx.pages().find(p => p.url().includes("tlcbcp.com")) || ctx.pages()[0];
    return { b, page };
}

// Abre el formulario de terceros y selecciona la cuenta origen FRUTICOLA.
async function abrirFormulario(page, log) {
    await page.goto("https://www.tlcbcp.com/#/h/transferencias/v2/dashboard").catch(() => {});
    await page.waitForTimeout(2000);
    await page.getByText("Cuentas de terceros BCP", { exact: false }).first().click();
    await page.waitForTimeout(2500);
    await page.getByText("Cuenta de origen", { exact: false }).first().click();
    await page.waitForTimeout(1000);
    const opt = page.getByText(ORIGEN_MATCH, { exact: false }).first();
    if (!await opt.count()) throw new Error(`no apareció la cuenta origen ${ORIGEN_MATCH} en el dropdown`);
    await opt.click();
    await page.waitForTimeout(1500);
}

async function enviarUna(page, fila, emails, log) {
    await abrirFormulario(page, log);

    // Cuenta destino -> dispara validación (GET third-party). Leemos el titular
    // de la respuesta de red (más fiable que raspar la pantalla).
    const espThird = page.waitForResponse(r => r.url().includes("third-party-accounts/") && r.request().method() === "GET", { timeout: 20000 });
    await page.getByLabel("Cuenta de destino").first().fill(fila.cuentaCuadro);
    await page.keyboard.press("Tab");
    const resThird = await espThird;
    let titular = null;
    try { titular = buscarValor(await resThird.json(), /(organizationName|holder|titular|beneficiar|name$)/i); } catch {}
    if (!titular) throw new Error("el banco no devolvió titular del destino");
    if (normNombre(titular) !== normNombre(fila.nombre))
        throw new Error(`titular banco "${titular}" ≠ cuadro "${fila.nombre}" — NO se envía`);

    // Monto y referencia.
    await page.getByLabel("Monto").first().fill(fila.pago.toFixed(2));
    await page.waitForTimeout(500);
    await page.getByLabel("Referencia (opcional)").first().fill(fila.referencia);
    await page.waitForTimeout(500);

    // Correos de aviso: opcionales (solo notificación), se omiten en v1. El
    // banco igual notifica según su config. Se pueden agregar más adelante.

    // Continuar -> PUT (arma la orden). Verificamos la empresa del PUT.
    const espPut = page.waitForResponse(r => r.url().includes("account-transfer-orders/") && r.request().method() === "PUT", { timeout: 20000 });
    await page.getByRole("button", { name: /Continuar/i }).first().click();
    const resPut = await espPut;
    if (resPut.status() !== 200 && resPut.status() !== 201) throw new Error(`PUT status ${resPut.status()}`);
    let putJson = {}; try { putJson = await resPut.json(); } catch {}
    const srcComp = putJson.sourceAccount && putJson.sourceAccount.company && putJson.sourceAccount.company.organizationName;
    if (srcComp && !/FRUTICOLA/i.test(srcComp))
        throw new Error(`¡ALERTA! la orden quedó con empresa "${srcComp}", no FRUTICOLA — NO se envía.`);
    await page.waitForTimeout(1500);

    // Enviar a pendiente de firma -> POST user-consents.
    const espCons = page.waitForResponse(r => r.url().includes("/user-consents") && r.request().method() === "POST", { timeout: 20000 });
    await page.getByRole("button", { name: /Enviar a pendiente de firma/i }).first().click();
    const resCons = await espCons;
    if (resCons.status() !== 200 && resCons.status() !== 201) throw new Error(`user-consents status ${resCons.status()}`);
    await page.waitForTimeout(1500);

    const operacion = buscarValor(putJson, /(operationNumber|orderNumber|transactionNumber|number)/i);
    return { titular, operacion, respuesta: putJson };
}

async function correr(opts, log = console.log) {
    const { filas, saltadas } = parsearCuadro(opts.pdf);
    let pend = filas;
    if (opts.solo) { const s = opts.solo; pend = filas.filter(f => f.guia === s || f.guia.endsWith(s)); if (!pend.length) throw new Error(`--solo ${s} no coincide`); }

    const db = abrirDb();
    const hechas = new Set(db.prepare("SELECT guia FROM pagos WHERE estado IN ('enviada','pagada')").all().map(r => r.guia));
    const cola = pend.filter(f => !hechas.has(f.guia));
    const total = cola.reduce((s, f) => s + f.pago, 0);

    log(`\nCrear órdenes EN PENDIENTE DE FIRMA (reversible; la plata no se mueve hasta firmar).`);
    log(`Cuadro: ${filas.length} transferibles, ${saltadas.length} saltadas, ${hechas.size} ya enviadas.`);
    log(`A enviar ahora: ${cola.length}, total S/ ${total.toFixed(2)}.`);
    if (!cola.length) { db.close(); log("Nada que hacer."); return; }

    const rl = !opts.si ? readline.createInterface({ input: stdin, output: stdout }) : null;
    const preg = async (q) => rl ? (await rl.question(q)).trim().toLowerCase() : "s";

    if (rl) {
        const ok = await preg(`¿Confirmas CREAR ${cola.length} órdenes (pendiente de firma) por S/ ${total.toFixed(2)} desde FRUTICOLA? (SI): `);
        if (ok !== "si") { log("Cancelado."); rl.close(); db.close(); return; }
    }

    const { b, page } = await conectar();
    let ok = 0, err = 0, abort = false;
    for (let i = 0; i < cola.length; i++) {
        const f = cola[i], pos = `[${i + 1}/${cola.length}]`;
        if (rl) {
            const r = await preg(`${pos} ${f.guia} ${f.nombre} ${f.cuentaCuadro} S/ ${f.pago.toFixed(2)} "${f.referencia}" — enviar? (s/n/a): `);
            if (r === "a") { abort = true; break; }
            if (r !== "s" && r !== "si") { log("  saltada."); continue; }
        }
        try {
            const res = await enviarUna(page, f, opts.emails, log);
            ok++;
            db.prepare("INSERT OR REPLACE INTO pagos (guia,nombre,cuenta,pago,referencia,estado,operacion,respuesta,fecha,error) VALUES (?,?,?,?,?,?,?,?,?,NULL)")
                .run(f.guia, f.nombre, f.cuenta, f.pago, f.referencia, "enviada", res.operacion ? String(res.operacion) : null, JSON.stringify(res.respuesta), new Date().toISOString());
            log(`  ✓ ${pos} ENVIADA a pendiente de firma: ${f.nombre} S/ ${f.pago.toFixed(2)} (titular ok: ${res.titular})`);
        } catch (e) {
            err++;
            db.prepare("INSERT OR REPLACE INTO pagos (guia,nombre,cuenta,pago,referencia,estado,fecha,error) VALUES (?,?,?,?,?,?,?,?)")
                .run(f.guia, f.nombre, f.cuenta, f.pago, f.referencia, "error", new Date().toISOString(), e.message);
            log(`  ✗ ${pos} ERROR ${f.nombre}: ${e.message}`);
            if (/ALERTA/.test(e.message)) { abort = true; log("  🛑 Abortando por seguridad."); break; }
            if (rl) { const r = await preg("     ¿continuar? (s/N): "); if (r !== "s" && r !== "si") { abort = true; break; } }
        }
        await dormir(800);
    }
    if (rl) rl.close();
    await b.close();
    db.close();
    log(`\n${abort ? "ABORTADO. " : ""}Hecho. Enviadas a pendiente: ${ok}, con error: ${err}.`);
    log(`Ahora revisá y FIRMÁ el lote en TeleCrédito (pendientes de firma). Registro: tabla pagos.`);
}

if (require.main === module) {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.pdf) { console.error("uso: node src/pagos/enviar_ui.js <cuadro.pdf> [--solo GUIA] [--si] [--emails ...]"); process.exit(1); }
    correr(opts).catch(err => { console.error("ERROR FATAL:", err.message); process.exit(1); });
}

module.exports = { correr };
