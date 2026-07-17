async function buscarOperaciones(page, headers, fechaDesde, fechaHasta) {

    let pagina = 0;
    let totalPaginas = 1;

    const operaciones = [];

    while (pagina < totalPaginas) {

        const json = await page.evaluate(
            async ({ pagina, fechaDesde, fechaHasta, headers }) => {

                const res = await fetch(
                    "https://apisux.ntlc.tlcbcp.com/ux-ntlc-consent-management-v1/channel/ntlc/v1/channel-orders/search",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            ...headers
                        },
                        body: JSON.stringify({
                            operationStatus: [],
                            metaData: {
                                pageSize: 25,
                                pageNumber: pagina
                            },
                            products: [],
                            advancedSearch: {
                                dateFrom: fechaDesde,
                                dateTo: fechaHasta,
                                dateFilter: "CREATED",
                                status: "PROCESSED"
                            }
                        })
                    }
                );

                return await res.json();

            },
            { pagina, fechaDesde, fechaHasta, headers }
        );

        totalPaginas = json.metadata.totalPages;

        operaciones.push(...json.operations);

        pagina++;
    }

    return operaciones;
}

async function descargarPdf(page, headers, requestId, transferType) {

    return await page.evaluate(
        async ({ requestId, transferType, headers }) => {

            const res = await fetch(
                `https://apisux.ntlc.tlcbcp.com/ux-ntlc-transfer-operation-v2/channel/ntlc/v2/transfer-operations/reports/${requestId}?reportType=CONSULT&transferType=${transferType}`,
                { headers }
            );

            return await res.json();

        },
        { requestId, transferType, headers }
    );

}

module.exports = {
    buscarOperaciones,
    descargarPdf
};