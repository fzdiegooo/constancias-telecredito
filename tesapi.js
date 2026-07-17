const fs = require("fs");
const { connect } = require("./src/connect");

(async () => {

    const { page, headers } = await connect();

    const pdf = await page.evaluate(async ({ headers }) => {

        const response = await fetch(
            "https://apisux.ntlc.tlcbcp.com/ux-ntlc-transfer-operation-v2/channel/ntlc/v2/transfer-operations/reports/94501551?reportType=CONSULT&transferType=TXTHIRDPARTIES",
            { headers, credentials: "include" }
        );

        return await response.json();
    }, { headers });

    console.log(pdf);

    fs.writeFileSync(
        "prueba.pdf",
        Buffer.from(pdf.data, "base64")
    );

    console.log("PDF generado");

})();