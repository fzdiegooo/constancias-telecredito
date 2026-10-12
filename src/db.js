// Persistencia de los datos de cada constancia en SQLite (node:sqlite nativo,
// sin dependencias externas). Una fila por operación, identificada por
// requestId. Guarda todos los campos útiles que trae el search, más el estado
// de descarga del PDF y la fecha de sincronización.

const { DatabaseSync } = require("node:sqlite");
const path = require("path");
const { carpetaConstancias } = require("./download");

function rutaBaseDatos() {
    return path.join(carpetaConstancias(), "constancias.db");
}

function abrir() {
    const db = new DatabaseSync(rutaBaseDatos());

    db.exec(`
        CREATE TABLE IF NOT EXISTS operaciones (
            requestId        INTEGER PRIMARY KEY,
            product          TEXT,
            status           TEXT,
            amount           REAL,
            currencyCode     TEXT,
            sendingDate      TEXT,
            creationDate     TEXT,
            firstSigningDate TEXT,
            source           TEXT,
            sourceCompany    TEXT,
            target           TEXT,
            targetBeneficiary TEXT,
            sender           TEXT,
            creator          TEXT,
            firstSigner      TEXT,
            reference        TEXT,
            subProduct       TEXT,
            typeSubProduct   TEXT,
            contract         TEXT,
            channelId        TEXT,
            rate             REAL,
            pdf_estado       TEXT DEFAULT 'pendiente',   -- pendiente | descargado | cliente_pendiente | no_soportado | error
            pdf_archivo      TEXT,
            pdf_error        TEXT,
            detalle_json     TEXT,
            raw_json         TEXT,
            sincronizado     TEXT
        )
    `);

    // Migración simple: agregar detalle_json si la tabla es de una versión vieja.
    const cols = db.prepare("PRAGMA table_info(operaciones)").all().map(c => c.name);
    if (!cols.includes("detalle_json"))
        db.exec("ALTER TABLE operaciones ADD COLUMN detalle_json TEXT");

    return db;
}

function guardarDetalle(db, requestId, detalle) {
    db.prepare("UPDATE operaciones SET detalle_json=? WHERE requestId=?")
        .run(detalle ? JSON.stringify(detalle) : null, requestId);
}

// Inserta o actualiza una operación. No pisa pdf_estado/pdf_archivo si ya
// estaba 'descargado' (para no perder el registro de lo ya bajado al re-sincronizar).
function guardarOperacion(db, op) {
    const stmt = db.prepare(`
        INSERT INTO operaciones (
            requestId, product, status, amount, currencyCode, sendingDate,
            creationDate, firstSigningDate, source, sourceCompany, target,
            targetBeneficiary, sender, creator, firstSigner, reference,
            subProduct, typeSubProduct, contract, channelId, rate,
            raw_json, sincronizado
        ) VALUES (
            @requestId, @product, @status, @amount, @currencyCode, @sendingDate,
            @creationDate, @firstSigningDate, @source, @sourceCompany, @target,
            @targetBeneficiary, @sender, @creator, @firstSigner, @reference,
            @subProduct, @typeSubProduct, @contract, @channelId, @rate,
            @raw_json, @sincronizado
        )
        ON CONFLICT(requestId) DO UPDATE SET
            product=excluded.product, status=excluded.status, amount=excluded.amount,
            currencyCode=excluded.currencyCode, sendingDate=excluded.sendingDate,
            creationDate=excluded.creationDate, firstSigningDate=excluded.firstSigningDate,
            source=excluded.source, sourceCompany=excluded.sourceCompany, target=excluded.target,
            targetBeneficiary=excluded.targetBeneficiary, sender=excluded.sender,
            creator=excluded.creator, firstSigner=excluded.firstSigner, reference=excluded.reference,
            subProduct=excluded.subProduct, typeSubProduct=excluded.typeSubProduct,
            contract=excluded.contract, channelId=excluded.channelId, rate=excluded.rate,
            raw_json=excluded.raw_json, sincronizado=excluded.sincronizado
    `);

    const n = (v) => (v === undefined ? null : v);

    stmt.run({
        requestId: op.requestId,
        product: n(op.product), status: n(op.status), amount: n(op.amount),
        currencyCode: n(op.currencyCode), sendingDate: n(op.sendingDate),
        creationDate: n(op.creationDate), firstSigningDate: n(op.firstSigningDate),
        source: n(op.source), sourceCompany: n(op.sourceCompany), target: n(op.target),
        targetBeneficiary: n(op.targetBeneficiary), sender: n(op.sender),
        creator: n(op.creator), firstSigner: n(op.firstSigner), reference: n(op.reference),
        subProduct: n(op.subProduct), typeSubProduct: n(op.typeSubProduct),
        contract: n(op.contract), channelId: n(op.channelId), rate: n(op.rate),
        raw_json: JSON.stringify(op),
        sincronizado: new Date().toISOString()
    });
}

function marcarPdf(db, requestId, estado, archivo = null, error = null) {
    db.prepare(`UPDATE operaciones SET pdf_estado=?, pdf_archivo=?, pdf_error=? WHERE requestId=?`)
        .run(estado, archivo, error, requestId);
}

// Estado del PDF de una operación ya guardada (o null si no existe aún).
function estadoPdf(db, requestId) {
    const row = db.prepare("SELECT pdf_estado, pdf_archivo FROM operaciones WHERE requestId=?").get(requestId);
    return row || null;
}

// Lista operaciones con filtros opcionales { q, product, pdf_estado, desde, hasta }.
// desde/hasta en "YYYY-MM-DD" (se comparan contra sendingDate ISO).
function listar(db, filtros = {}) {
    const cond = [];
    const params = {};

    if (filtros.q) {
        cond.push("(targetBeneficiary LIKE @q OR sourceCompany LIKE @q OR reference LIKE @q OR CAST(requestId AS TEXT) LIKE @q)");
        params.q = `%${filtros.q}%`;
    }
    if (filtros.product) { cond.push("product = @product"); params.product = filtros.product; }
    if (filtros.empresa) { cond.push("sourceCompany = @empresa"); params.empresa = filtros.empresa; }
    if (filtros.moneda) { cond.push("currencyCode = @moneda"); params.moneda = filtros.moneda; }
    if (filtros.pdf_estado) { cond.push("pdf_estado = @pdf_estado"); params.pdf_estado = filtros.pdf_estado; }
    if (filtros.desde) { cond.push("substr(sendingDate,1,10) >= @desde"); params.desde = filtros.desde; }
    if (filtros.hasta) { cond.push("substr(sendingDate,1,10) <= @hasta"); params.hasta = filtros.hasta; }

    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const limit = Math.min(Number(filtros.limit) || 500, 2000);

    return db.prepare(`
        SELECT requestId, product, status, amount, currencyCode, sendingDate,
               targetBeneficiary, sourceCompany, reference, source,
               pdf_estado, pdf_archivo
        FROM operaciones ${where}
        ORDER BY sendingDate DESC
        LIMIT ${limit}
    `).all(params);
}

function estadisticas(db) {
    return {
        total: db.prepare("SELECT COUNT(*) c FROM operaciones").get().c,
        porEstado: db.prepare("SELECT pdf_estado, COUNT(*) c FROM operaciones GROUP BY pdf_estado").all(),
        porTipo: db.prepare("SELECT product, COUNT(*) c FROM operaciones GROUP BY product ORDER BY c DESC").all(),
        empresas: db.prepare("SELECT sourceCompany e, COUNT(*) c FROM operaciones WHERE sourceCompany IS NOT NULL AND sourceCompany <> '' GROUP BY sourceCompany ORDER BY c DESC").all(),
        rango: db.prepare("SELECT MIN(substr(sendingDate,1,10)) min, MAX(substr(sendingDate,1,10)) max FROM operaciones").get()
    };
}

module.exports = {
    abrir, guardarOperacion, guardarDetalle, marcarPdf,
    estadoPdf, listar, estadisticas, rutaBaseDatos
};
