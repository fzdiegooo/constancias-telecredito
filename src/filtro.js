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

// Reduce la cantidad de páginas (por defecto trae 25 filas por página) para
// minimizar los problemas de paginación con muchos resultados: con 100 por
// página, un rango típico de ~300-400 operaciones queda en 3-4 páginas en
// vez de 15+, y evita el caso donde el número de página buscado ni siquiera
// aparece en pantalla (queda oculto tras el "..." del control de paginación).
//
// Este control de "Filas" vive pegado a la tabla de resultados, así que NO
// existe en el DOM hasta después del primer "Buscar" (no hay tabla, no hay
// paginador). Por eso esta función se llama luego de la búsqueda inicial.
// No confiamos en que el propio selector dispare su búsqueda solo al
// cambiar de valor (en la práctica resultó poco confiable — a veces no
// dispara nada, o dispara con la página vieja): tras elegir la opción,
// forzamos un clic explícito en "Buscar" para garantizar una búsqueda
// determinística con el nuevo tamaño de página, igual que la primera vez.
async function seleccionarFilasPorPagina(page, cantidad) {

    const selector = page.locator("bcp-select-consult-tray").filter({ hasText: "Filas" });

    if (await selector.count() === 0)
        return null;

    try {

        await selector.locator(".bcp-ffw-dropdown-toggle").click();
        await page.waitForTimeout(300);

        const opcion = selector.getByRole("option", { name: String(cantidad), exact: true });

        if (await opcion.count() === 0) {
            await page.keyboard.press("Escape").catch(() => {});
            return null;
        }

        await opcion.click();
        await page.waitForTimeout(400);

        return await buscarConRespuesta(page, () =>
            page.getByRole("button", { name: "search Buscar" }).click(),
            0,
            10000
        );

    } catch {
        // No es crítico: si falla (el control no disparó ninguna petición
        // nueva, cambió de estructura, etc.) seguimos con la cantidad de
        // filas que haya quedado (25 por defecto) en vez de tumbar todo el
        // proceso.
        return null;
    }
}

// El sitio no recuerda la cantidad de filas elegida: cada vez que se vuelve
// a la lista desde el detalle de una operación, el paginador se resetea a
// 25 filas por página (igual que se resetea siempre a la página 1). Por eso
// hay que revisar/reaplicar esto en cada iteración, no solo una vez al
// aplicar el filtro. Leemos el valor actual del selector, pero le damos un
// respiro antes (la etiqueta puede tardar en actualizarse tras volver de
// una operación) para no confiarnos de una lectura vieja/en transición.
async function filasActuales(page) {

    const selector = page.locator("bcp-select-consult-tray").filter({ hasText: "Filas" });

    if (await selector.count() === 0)
        return null;

    await page.waitForTimeout(300);

    const texto = await selector
        .locator(".bcp-ffw-dropdown-toggle p")
        .first()
        .textContent()
        .catch(() => null);

    return texto ? texto.trim() : null;
}

async function asegurarFilasPorPagina(page, cantidad, intentosMax = 3) {

    for (let intento = 1; intento <= intentosMax; intento++) {

        const actual = await filasActuales(page);

        if (actual === String(cantidad))
            return null; // Ya está en el valor correcto, no hace falta tocar nada.

        const json = await seleccionarFilasPorPagina(page, cantidad);

        // Verificamos que de verdad haya quedado seleccionado antes de
        // confiar y devolver el control — el clic puede "resolver" en
        // Playwright sin que el componente realmente haya cambiado de
        // valor (visto en producción: el selector se queda pegado en 25).
        const quedoBien = await filasActuales(page) === String(cantidad);

        if (quedoBien)
            return json;

        if (intento < intentosMax)
            await page.waitForTimeout(500);
    }

    return null;
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

// pageNumberEsperado (0-indexado, igual que el campo metaData.pageNumber que
// manda el propio sitio) permite descartar respuestas "viejas"/de otra
// página que por una condición de carrera coincidan en URL y método pero no
// correspondan al pedido que acabamos de disparar (visto en producción: al
// paginar, a veces se captura una respuesta de la página anterior en vez de
// la nueva). Si no se pasa, solo valida URL + método (uso original).
// timeoutMs limita cuánto esperamos esa respuesta (por defecto el de
// Playwright, 30s); usar un valor corto cuando esta llamada es una
// "recuperación" reactiva y no queremos colgar el script si el sitio no
// dispara ninguna petición nueva (p. ej. porque ya cree estar en esa página).
async function buscarConRespuesta(page, disparador, pageNumberEsperado, timeoutMs) {

    const [response] = await Promise.all([
        page.waitForResponse(res => {

            if (res.request().method() !== "POST" || !res.url().includes("/channel-orders/search"))
                return false;

            if (pageNumberEsperado === undefined)
                return true;

            try {
                const body = res.request().postDataJSON();
                return body?.metaData?.pageNumber === pageNumberEsperado;
            } catch {
                return false;
            }
        }, timeoutMs ? { timeout: timeoutMs } : undefined),
        disparador()
    ]);

    const json = await response.json();

    if (!json || !json.metadata) {
        throw new Error("La respuesta de búsqueda no trajo los datos esperados (metadata). Puede que la sesión haya expirado o el filtro no se haya aplicado bien.");
    }

    return json;
}

// Último recurso cuando todo lo demás (reintentos, scroll, re-navegación de
// página) falló: limpia el estado del buscador con el botón "Restablecer"
// (a la derecha de "Buscar") para partir de cero antes de reaplicar el
// filtro, por si la SPA quedó en un estado de paginación/filtro inconsistente
// que ningún otro reintento pudo corregir.
async function restablecer(page) {

    // Es un componente custom (bcp-button-consult-tray > button >
    // bcp-character-consult-tray > span) con id-auto="button-restore" fijo,
    // más confiable que matchear el texto "Restablecer" a través de varios
    // niveles de elementos custom anidados.
    await page.locator('[id-auto="button-restore"]').click();
    await page.waitForTimeout(500);
}

async function aplicarFiltro(page, fechaDesde, fechaHasta, estado = "Procesada", filasPorPagina = 25) {

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

    let json = await buscarConRespuesta(page, () =>
        page.getByRole("button", { name: "search Buscar" }).click(),
        0
    );

    // El selector de "Filas por página" solo aparece una vez que ya hay
    // resultados (es parte del paginador de la tabla), así que recién ahora
    // podemos intentar subirlo. Usamos la versión con reintentos/verificación
    // para no quedarnos con una selección "a medias": si esto queda
    // inconsistente (a veces sí, a veces no cambia), el total de páginas
    // calculado más abajo ya no correspondería con la cantidad de filas que
    // realmente terminó mostrando la tabla, y toda la navegación por
    // número de página que se apoya en `totalPages` quedaría rota (se vio
    // en producción: página "4" mostrando 74 operaciones sueltas en vez de
    // las 25 esperadas, porque el tamaño de página cambió a mitad de
    // camino sin recalcular nada). Por eso esto se fija UNA sola vez aquí,
    // al aplicar el filtro, y no se vuelve a tocar durante el resto del
    // proceso.
    if (filasPorPagina && filasPorPagina !== 25) {

        const jsonFilas = await asegurarFilasPorPagina(page, filasPorPagina);

        if (jsonFilas)
            json = jsonFilas;
    }

    return {
        operations: json.operations,
        totalPages: json.metadata.totalPages
    };
}

// A veces el clic en el número de página no dispara ninguna petición nueva
// (visto en producción: el botón queda deshabilitado momentáneamente, o el
// componente de paginación todavía no terminó de re-renderizar tras volver
// de una operación) y se ve como "aprieta el botón pero se quedan los datos
// de la página anterior". Además, incluso cuando SÍ llega la respuesta de
// red correcta, la tabla (Angular) puede tardar en re-renderizar y quedar
// mostrando visualmente las filas de la página vieja un instante — por eso
// no basta con confiar en la respuesta HTTP, hay que verificar que el DOM
// realmente cambió antes de devolver el control. Reintentamos el clic
// unas cuantas veces antes de rendirnos; si aun así no cede, quien llama
// (main.js/index.js) tiene como último recurso una recarga completa de la
// página + reaplicar filtro, que es la que de verdad destraba este bug.
async function irAPagina(page, numeroPagina, timeoutMs, intentosMax = 3) {

    const nav = page.getByRole("navigation", { name: "Page navigation" });

    let ultimoError;

    for (let intento = 1; intento <= intentosMax; intento++) {

        try {

            const json = await buscarConRespuesta(page, () =>
                nav.getByText(String(numeroPagina), { exact: true }).click(),
                numeroPagina - 1,
                timeoutMs
            );

            // Los controles de paginación están al final de la tabla, así
            // que al hacer clic el scroll suele quedar abajo (donde quedó
            // de procesar la página anterior). Si la tabla usa scroll
            // virtual, las primeras filas de la página nueva no llegan a
            // existir en el DOM hasta que se desplaza de vuelta arriba, lo
            // que hace fallar indiceFilaPorMonto para la primera operación
            // de cada página nueva. Forzamos scroll al inicio y damos un
            // respiro para que la tabla termine de re-renderizar.
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(500);

            // Verificación extra: confirmamos que el DOM realmente muestra
            // ya alguna fila de la página nueva (buscando el beneficiario
            // de la primera operación "identificable" que trajo la
            // respuesta) antes de confiar en que la navegación terminó.
            const referencia = json.operations.find(op => op.targetBeneficiary !== "Varios beneficiarios");

            if (referencia) {

                const visible = await page.getByText(referencia.targetBeneficiary, { exact: true })
                    .first()
                    .waitFor({ state: "visible", timeout: 8000 })
                    .then(() => true)
                    .catch(() => false);

                if (!visible)
                    throw new Error(`La tabla no reflejó la página ${numeroPagina} tras el clic (sigue mostrando datos viejos).`);
            }

            return json.operations;

        } catch (err) {

            ultimoError = err;

            if (intento < intentosMax) {

                // Estrategia que en la práctica destraba el bug al hacerlo
                // manualmente: ir a una página vecina y luego regresar a la
                // página objetivo, en vez de solo reintentar el mismo clic.
                // Forzamos que la SPA "reaccione" a un cambio de página real
                // antes de volver a pedir la que realmente queremos.
                const vecina = numeroPagina > 1 ? numeroPagina - 1 : numeroPagina + 1;

                try {

                    await buscarConRespuesta(page, () =>
                        nav.getByText(String(vecina), { exact: true }).click(),
                        vecina - 1,
                        8000
                    );

                    await page.waitForTimeout(500);

                } catch {
                    // Si tampoco reacciona a la vecina, seguimos igual con
                    // el reintento normal (scroll) más abajo.
                }

                await page.waitForTimeout(500);
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await page.waitForTimeout(300);
            }
        }
    }

    throw ultimoError;
}

module.exports = { aplicarFiltro, irAPagina, restablecer };
