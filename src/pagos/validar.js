// FASE 1 — Validación (NO transfiere dinero).
//
// Lee el cuadro de pagos, se conecta al navegador del banco ya logueado (igual
// que apicli.js) y, por cada fila transferible:
//   1) GET  third-party-accounts/{cuenta}   -> confirma que la cuenta existe y
//      trae el titular; se compara contra el nombre del cuadro.
//   2) POST daily-transfer-amounts/verify    -> confirma que el monto entra en
//      el límite diario.
// NO hace el PUT account-transfer-orders (eso es Fase 2). Ninguna llamada aquí
// mueve plata: son lecturas/validaciones.
//
// Uso:
//   node src/pagos/validar.js /ruta/cuadro-pagos.pdf
// (Abrir antes el navegador del banco logueado: `node src/abrir.js`.)

const fs = require("fs");
const path = require("path");
const { crearSesion } = require("../apiclient");
const { parsearCuadro } = require("./parse");

const BASE = "https://apisux.ntlc.tlcbcp.com/ux-ntlc-account-transfer-v2/channel/ntlc/v2";
const URL_ORDERS = `${BASE}/account-transfer-orders`;
const URL_THIRD = (cuenta) => `${BASE}/third-party-accounts/${cuenta}`;
const URL_VERIFY = `${BASE}/daily-transfer-amounts/verify`;

const dormir = (ms) => new Promise(r => setTimeout(r, ms));

// Normaliza un nombre para comparar: sin tildes, mayúsculas, tokens ordenados.
// Así "PACHECO CCASANI ROBERT VICTOR" == "ROBERT VICTOR PACHECO CCASANI".
function normNombre(s) {
    return (s || "")
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toUpperCase().replace(/[^A-Z\s]/g, " ")
        .split(/\s+/).filter(Boolean).sort().join(" ");
}

// Busca recursivamente en un JSON de forma desconocida el primer valor string
// de una clave que parezca "nombre del titular".
function buscarTitular(obj, prof = 0) {
    if (!obj || typeof obj !== "object" || prof > 6) return null;
    // BCP devuelve el titular en `organizationName`; cubrimos además otras
    // variantes y cualquier clave que termine en "name" (holderName, ownerName…).
    const CLAVE = /(organizationName|holder|titular|beneficiar|razonSocial|fullName|clientName|customerName|name$)/i;
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && v.trim() && CLAVE.test(k)) return v.trim();
    }
    for (const v of Object.values(obj)) {
        if (v && typeof v === "object") {
            const r = buscarTitular(v, prof + 1);
            if (r) return r;
        }
    }
    return null;
}

async function validar(pdfPath, log = console.log) {
    const { filas, saltadas } = parsearCuadro(pdfPath);
    log(`Cuadro: ${filas.length} transferibles, ${saltadas.length} saltadas.`);
    for (const s of saltadas) log(`  ↷ saltada ${s.guia} ${s.nombre} — ${s.motivo}`);

    log("Conectando al navegador y capturando token...");
    const sesion = await crearSesion(log);
    log(`Token OK (expira en ${sesion.expSegundos()}s).`);

    // Abrir una orden borrador (no compromete nada) por si el GET de destino
    // necesita contexto de orden en el servidor. Dejamos registro de la
    // respuesta para conocer su forma (y las cuentas origen disponibles).
    const orden = await sesion.fetchJson(URL_ORDERS, { method: "POST", body: { type: "TXTHIRDPARTIES" } });
    log(`POST account-transfer-orders -> status ${orden.status}`);
    log(`  respuesta: ${JSON.stringify(orden.json || orden.raw).slice(0, 800)}`);

    const resultados = [];
    let dumpHecho = false;

    for (let i = 0; i < filas.length; i++) {
        const f = filas[i];
        const pos = `[${i + 1}/${filas.length}]`;
        const r = {
            guia: f.guia, nombre: f.nombre, cuenta: f.cuentaCuadro,
            pago: f.pago, referencia: f.referencia,
            cuentaOk: false, titularApi: null, nombreCoincide: null,
            montoOk: false, estado: "ok", notas: [],
        };

        try {
            const dest = await sesion.fetchJson(URL_THIRD(f.cuenta));
            if (!dumpHecho) {
                log(`  (forma de respuesta third-party, fila 1): ${JSON.stringify(dest.json).slice(0, 900)}`);
                dumpHecho = true;
            }
            if (dest.status === 200 && dest.json) {
                r.cuentaOk = true;
                r.titularApi = buscarTitular(dest.json);
                if (r.titularApi) {
                    r.nombreCoincide = normNombre(r.titularApi) === normNombre(f.nombre);
                    if (!r.nombreCoincide) r.notas.push(`titular API "${r.titularApi}" ≠ cuadro "${f.nombre}"`);
                } else {
                    r.notas.push("no se encontró titular en la respuesta");
                }
            } else {
                r.estado = "error";
                r.notas.push(`third-party status ${dest.status}: ${JSON.stringify(dest.json || dest.raw).slice(0, 200)}`);
            }

            const ver = await sesion.fetchJson(URL_VERIFY, {
                method: "POST", body: { amount: f.pago.toFixed(2), currency: "PEN" },
            });
            if (ver.status === 200) r.montoOk = true;
            else { r.estado = "error"; r.notas.push(`verify status ${ver.status}: ${JSON.stringify(ver.json || ver.raw).slice(0, 200)}`); }

        } catch (err) {
            r.estado = "error";
            r.notas.push(`excepción: ${err.message}`);
        }

        if (r.estado === "ok" && r.nombreCoincide === false) r.estado = "revisar";
        if (r.estado === "ok" && r.nombreCoincide === null && r.cuentaOk) r.estado = "revisar";

        resultados.push(r);
        const marca = r.estado === "ok" ? "✓" : r.estado === "revisar" ? "⚠" : "✗";
        log(`${marca} ${pos} ${f.guia} ${f.cuenta} S/ ${f.pago.toFixed(2)} — ${r.titularApi || "?"} ${r.notas.join("; ")}`);
        await dormir(300);
    }

    await sesion.cerrar();

    const resumen = {
        ok: resultados.filter(r => r.estado === "ok").length,
        revisar: resultados.filter(r => r.estado === "revisar").length,
        error: resultados.filter(r => r.estado === "error").length,
    };
    log(`\nValidación: ${resumen.ok} OK, ${resumen.revisar} a revisar, ${resumen.error} con error.`);

    // Reporte junto al PDF: JSON (completo) + CSV (para abrir en Excel).
    const dir = path.dirname(pdfPath);
    const jsonOut = path.join(dir, "validacion-pagos.json");
    const csvOut = path.join(dir, "validacion-pagos.csv");
    fs.writeFileSync(jsonOut, JSON.stringify({ resumen, resultados, saltadas }, null, 2));
    const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = ["estado,guia,nombre_cuadro,titular_api,coincide,cuenta,pago,referencia,notas"]
        .concat(resultados.map(r => [
            r.estado, r.guia, r.nombre, r.titularApi || "", r.nombreCoincide,
            r.cuenta, r.pago.toFixed(2), r.referencia, r.notas.join(" | "),
        ].map(esc).join(",")))
        .concat(saltadas.map(s => [
            "saltada", s.guia, s.nombre, "", "", s.cuentaCuadro || "", s.pago.toFixed(2), "", s.motivo,
        ].map(esc).join(",")))
        .join("\n");
    fs.writeFileSync(csvOut, csv);
    log(`Reporte: ${csvOut}`);
    log(`         ${jsonOut}`);

    return { resumen, resultados, saltadas };
}

module.exports = { validar };

if (require.main === module) {
    const pdf = process.argv[2];
    if (!pdf) { console.error("uso: node src/pagos/validar.js <cuadro.pdf>"); process.exit(1); }
    validar(pdf).catch(err => { console.error("ERROR FATAL:", err.message); process.exit(1); });
}
