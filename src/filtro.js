// Aplica el filtro de "Estado de operaciones": estado = Procesada y rango de
// fechas Desde/Hasta, todo mediante clics reales en la UI (nunca reenviando
// tokens). Captura la respuesta real del buscador (channel-orders/search)
// que dispara el propio clic en "Buscar", en vez de reconstruir la petición.

const MESES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"
];

const REGEX_MES_ANIO = new RegExp(`^(${MESES.join("|")}) \\d{4}$`);

async function seleccionarEstado(page, estado) {

    const combo = page.getByRole("listbox").filter({ hasText: "Estado de operación" });

    await combo.click();
    await page.waitForTimeout(300);

    await page.getByRole("option", { name: estado, exact: true }).click();
    await page.waitForTimeout(300);
}

async function abrirCalendario(page, campo) {

    const input = page.getByRole("textbox", { name: campo });
    const box = await input.boundingBox();

    await page.mouse.click(box.x + box.width - 15, box.y + box.height / 2);
    await page.waitForTimeout(500);
}

// Navega el calendario (vista de dos meses) hasta que el mes/año objetivo
// quede visible. Devuelve "primero" o "segundo" según en qué columna quedó.
async function irAMes(page, mesObjetivo, anioObjetivo) {

    const objetivoTotal = anioObjetivo * 12 + mesObjetivo;

    for (let intentos = 0; intentos < 24; intentos++) {

        const encabezados = await page.getByText(REGEX_MES_ANIO).allTextContents();

        const [nombrePrimero, anioPrimeroStr] = encabezados[0].trim().split(" ");
        const mesActual = MESES.indexOf(nombrePrimero);
        const anioActual = parseInt(anioPrimeroStr, 10);
        const actualTotal = anioActual * 12 + mesActual;

        if (actualTotal === objetivoTotal)
            return "primero";

        if (actualTotal + 1 === objetivoTotal)
            return "segundo";

        const flechas = await page.getByText(/angle/i).all();
        const cajas = [];

        for (const f of flechas) {
            const b = await f.boundingBox();
            if (b) cajas.push({ el: f, box: b });
        }

        cajas.sort((a, b) => a.box.x - b.box.x);

        const flecha = objetivoTotal > actualTotal ? cajas[cajas.length - 1] : cajas[0];

        // El navbar fijo del banco a veces queda superpuesto sobre la
        // flecha (visualmente arriba en el z-index), lo que hace fallar un
        // clic normal por "intercepts pointer events". Disparamos el clic
        // directamente sobre el elemento (nativo, sin depender de
        // coordenadas/hit-testing) para esquivar ese problema.
        await flecha.el.evaluate(el => el.click());
        await page.waitForTimeout(400);
    }

    throw new Error(`No se pudo navegar el calendario hasta ${MESES[mesObjetivo]} ${anioObjetivo}`);
}

async function clickDia(page, dia, columna) {

    const candidatos = await page.getByText(String(dia), { exact: true }).all();
    const cajas = [];

    for (const c of candidatos) {
        const b = await c.boundingBox();
        if (b) cajas.push(b);
    }

    cajas.sort((a, b) => a.x - b.x);

    const b = columna === "segundo" ? cajas[cajas.length - 1] : cajas[0];

    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
}

// fecha en formato "DD-MM-YYYY"
async function seleccionarFecha(page, campo, fecha) {

    const [dia, mes, anio] = fecha.split("-").map(Number);

    await abrirCalendario(page, campo);
    const columna = await irAMes(page, mes - 1, anio);
    await clickDia(page, dia, columna);
    await page.waitForTimeout(300);
}

async function buscarConRespuesta(page, disparador) {

    const [response] = await Promise.all([
        page.waitForResponse(res =>
            res.request().method() === "POST" &&
            res.url().includes("/channel-orders/search")
        ),
        disparador()
    ]);

    const json = await response.json();

    if (!json || !json.metadata) {
        throw new Error("La respuesta de búsqueda no trajo los datos esperados (metadata). Puede que la sesión haya expirado o el filtro no se haya aplicado bien.");
    }

    return json;
}

async function aplicarFiltro(page, fechaDesde, fechaHasta, estado = "Procesada") {

    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    await seleccionarEstado(page, estado);

    await seleccionarFecha(page, "Desde", fechaDesde);
    await seleccionarFecha(page, "Hasta", fechaHasta);

    // El calendario de "Hasta" puede quedar abierto y tapar el botón Buscar.
    // Lo cerramos haciendo clic fuera y presionando Escape antes de continuar.
    await page.getByRole("heading", { name: "Estado de operaciones" }).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);

    const json = await buscarConRespuesta(page, () =>
        page.getByRole("button", { name: "search Buscar" }).click()
    );

    return {
        operations: json.operations,
        totalPages: json.metadata.totalPages
    };
}

async function irAPagina(page, numeroPagina) {

    const nav = page.getByRole("navigation", { name: "Page navigation" });

    const json = await buscarConRespuesta(page, () =>
        nav.getByText(String(numeroPagina), { exact: true }).click()
    );

    return json.operations;
}

module.exports = { aplicarFiltro, irAPagina };
