// EXPERIMENTO: ¿se puede completar una transferencia SOLO por API (sin manejar
// la UI), reusando los valores de device-binding capturados en curl-transferencia.txt?
//
// Hace el flujo completo por API y, al final, dispara POST user-consents (el
// "Enviar a pendiente de firma") con devicePrint + devicetokencookie +
// orig-device-id leídos del curl. Si entra, la orden queda EN PENDIENTE DE FIRMA
// (reversible, la plata no se mueve). Si el banco rechaza los valores stale,
// confirma que hace falta la UI.
//
// Los 3 valores sensibles se leen del curl DENTRO del script y NO se imprimen.
//
// Uso: node src/abrir.js (loguear) ; luego:
//   node src/pagos/probar_api_firma.js [guia|ultimos4]              (del cuadro)
//   node src/pagos/probar_api_firma.js --cuenta 401-XXXXXXXX-X-XX --nombre "BULNES RUIZ DIEGO" --monto 50 --ref "GI1 0001"

const fs = require("fs");
const path = require("path");
const { crearSesion } = require("../apiclient");
const { parsearCuadro } = require("./parse");

const AT = "https://apisux.ntlc.tlcbcp.com/ux-ntlc-account-transfer-v2/channel/ntlc/v2";
const CURL = path.join(__dirname, "..", "..", "curl-transferencia.txt");
const EMPRESA = { documentNumber: "20610822356", documentType: "RUC", organizationName: "FRUTICOLA SELVA SAC" };

const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z\s]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
const find = (o, re, p = 0) => {
    if (!o || typeof o !== "object" || p > 6) return null;
    for (const [k, v] of Object.entries(o)) if (typeof v === "string" && v.trim() && re.test(k)) return v.trim();
    for (const v of Object.values(o)) if (v && typeof v === "object") { const r = find(v, re, p + 1); if (r) return r; } return null;
};

function leerDevice() {
    const t = fs.readFileSync(CURL, "utf8");
    const dtc = (t.match(/devicetokencookie:\s*([^'\n]+)/) || [])[1];
    const odi = (t.match(/orig-device-id:\s*([^'\n]+)/) || [])[1];
    const dp = (t.match(/"devicePrint":"([^"]+)"/) || [])[1];
    if (!dtc || !odi || !dp) throw new Error("no se pudieron leer devicetokencookie/orig-device-id/devicePrint del curl");
    return { dtc: dtc.trim(), odi: odi.trim(), dp };
}

function argVal(name) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; }

async function main() {
    let f;
    const cuentaArg = argVal("--cuenta");
    if (cuentaArg) {
        // Destino custom (fuera del cuadro): para pruebas a cuenta propia.
        const monto = Number(argVal("--monto") || "0");
        if (!(monto > 0)) throw new Error("--monto debe ser > 0");
        f = {
            guia: "CUSTOM",
            nombre: argVal("--nombre") || "",
            cuentaCuadro: cuentaArg,
            cuenta: cuentaArg.replace(/-/g, ""),
            pago: monto,
            referencia: argVal("--ref") || "GI1 0001",
        };
    } else {
        const sel = process.argv[2] || "4523";
        const { filas } = parsearCuadro(path.join(process.env.HOME, "Downloads", "cuadro-pagos-03-11-2026.pdf"));
        f = filas.find(x => x.guia === sel || x.guia.endsWith(sel));
        if (!f) throw new Error(`guia ${sel} no está en el cuadro`);
    }
    console.log(`Fila: ${f.guia} ${f.nombre} ${f.cuentaCuadro} S/ ${f.pago.toFixed(2)} ref "${f.referencia}"`);

    const dev = leerDevice();
    const s = await crearSesion(console.log);
    console.log(`Token OK (expira ${s.expSegundos()}s).`);

    const orden = await s.fetchJson(`${AT}/account-transfer-orders`, { method: "POST", body: { type: "TXTHIRDPARTIES", selectedCompany: EMPRESA } });
    const pen = ((orden.json && orden.json.sourceCompanyAccounts) || []).filter(c => c.currency === "PEN");
    const origen = pen.find(c => (c.company && c.company.documentNumber) === EMPRESA.documentNumber) || pen[0];
    if (!origen) throw new Error("sin cuenta origen PEN");
    if ((origen.company && origen.company.documentNumber) !== EMPRESA.documentNumber)
        throw new Error(`cuenta origen no es FRUTICOLA (${origen.company && origen.company.documentNumber})`);
    const id = origen.id;
    console.log(`Origen: ${origen.alias} ${origen.number} id=${id}`);

    await s.fetchJson(`${AT}/company-accounts/${id}?flag=SOURCE`);
    const dest = await s.fetchJson(`${AT}/third-party-accounts/${f.cuenta}`);
    const titular = find(dest.json, /(organizationName|holder|titular|beneficiar|name$)/i);
    console.log(`Titular banco: ${titular} | coincide: ${f.nombre ? norm(titular) === norm(f.nombre) : "(sin nombre, no se compara)"}`);
    if (f.nombre && norm(titular) !== norm(f.nombre)) throw new Error(`titular banco "${titular}" ≠ "${f.nombre}" — abortado. Reintentá con --nombre exacto si es tu cuenta.`);

    const ver = await s.fetchJson(`${AT}/daily-transfer-amounts/verify`, { method: "POST", body: { amount: f.pago.toFixed(2), currency: "PEN" } });
    console.log(`verify: ${ver.status}`);

    const put = await s.fetchJson(`${AT}/account-transfer-orders/${id}`, { method: "PUT", body: { amount: f.pago.toFixed(2), currency: "PEN", reference: f.referencia, emails: [], message: "" } });
    const pj = put.json || {};
    const srcComp = pj.sourceAccount && pj.sourceAccount.company && pj.sourceAccount.company.organizationName;
    console.log(`PUT: ${put.status} | preview ${srcComp} ${pj.sourceAccount && pj.sourceAccount.number} -> ${pj.targetAccount && pj.targetAccount.number} S/ ${pj.amount} canSign=${pj.canSign}`);
    if (srcComp && !/FRUTICOLA/i.test(srcComp)) throw new Error("preview no es FRUTICOLA — abortado antes de firmar");

    // user-consents desde el contexto de la página, con los 3 headers de device.
    const cons = await s.page.evaluate(async ({ url, base, dev }) => {
        const h = { ...base };
        delete h["content-length"]; delete h["host"];
        h["content-type"] = "application/json";
        h["devicetokencookie"] = dev.dtc;
        h["orig-device-id"] = dev.odi;
        const r = await fetch(url, { method: "POST", headers: h, credentials: "include", body: JSON.stringify({ devicePrint: dev.dp }) });
        const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = null; }
        return { status: r.status, json, raw: json ? null : text.slice(0, 300) };
    }, { url: `${AT}/user-consents`, base: s.headers(), dev });

    console.log(`\nuser-consents: ${cons.status}`);
    console.log(`respuesta: ${JSON.stringify(cons.json || cons.raw).slice(0, 400)}`);
    if (cons.status === 200 || cons.status === 201)
        console.log(`\n✅ POSIBLE ÉXITO: la orden debería estar EN PENDIENTE DE FIRMA. Verificá en el banco.`);
    else
        console.log(`\n❌ user-consents rechazado (${cons.status}): los valores de device probablemente son stale -> hace falta la UI.`);

    await s.cerrar();
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
